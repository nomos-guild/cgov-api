import { Request, Response } from "express";
import { discoverRepositories } from "../../services/ingestion/github-discovery";
import { syncActiveRepos, syncModerateRepos, syncDormantRepos, snapshotAllRepos } from "../../services/ingestion/github-activity";
import { backfillRepositories } from "../../services/ingestion/github-backfill";
import { aggregateRecentToHistorical, precomputeNetworkGraphs } from "../../services/ingestion/github-aggregation";
import { cacheInvalidatePrefix } from "../../services/cache";
import { prisma } from "../../services";

const LOCK_EXPIRY_MS = 35 * 60 * 1000; // 35 minutes (generous for large syncs, handles snapshot's 30min timeout)

// ─── Helper: Acquire Job Lock ───────────────────────────────────────────────

async function acquireJobLock(jobName: string, displayName: string): Promise<boolean> {
  const now = new Date();

  return await prisma.$transaction(async (tx) => {
    // Clear expired locks
    await tx.syncStatus.updateMany({
      where: {
        jobName,
        isRunning: true,
        expiresAt: { lt: now },
      },
      data: {
        isRunning: false,
        lastResult: "expired",
        errorMessage: "Lock expired - previous run may have crashed",
      },
    });

    // Check if job is already running
    const status = await tx.syncStatus.findUnique({
      where: { jobName },
    });

    if (status?.isRunning) {
      return false;
    }

    // Acquire lock
    await tx.syncStatus.upsert({
      where: { jobName },
      create: {
        jobName,
        displayName,
        isRunning: true,
        startedAt: now,
        expiresAt: new Date(now.getTime() + LOCK_EXPIRY_MS),
        lockedBy: process.env.HOSTNAME || "cloud-run-instance",
      },
      update: {
        isRunning: true,
        startedAt: now,
        expiresAt: new Date(now.getTime() + LOCK_EXPIRY_MS),
        lockedBy: process.env.HOSTNAME || "cloud-run-instance",
        errorMessage: null,
      },
    });

    return true;
  });
}

// ─── Helper: Release Job Lock ───────────────────────────────────────────────

async function releaseJobLock(
  jobName: string,
  result: "success" | "failed",
  itemsProcessed?: number,
  errorMessage?: string
): Promise<void> {
  await prisma.syncStatus.update({
    where: { jobName },
    data: {
      isRunning: false,
      completedAt: new Date(),
      lastResult: result,
      itemsProcessed: itemsProcessed ?? null,
      errorMessage: errorMessage ?? null,
    },
  });
}

// ─── GitHub Discovery ────────────────────────────────────────────────────────

export const postTriggerGithubDiscovery = async (_req: Request, res: Response) => {
  const jobName = "github-discover";
  const displayName = "GitHub Repository Discovery";

  const acquired = await acquireJobLock(jobName, displayName);
  if (!acquired) {
    return res.status(409).json({
      success: false,
      message: "GitHub discovery is already running. Please try again later.",
    });
  }

  // ✅ Respond immediately to avoid Cloud Scheduler timeout
  res.json({
    success: true,
    message: `${displayName} started`,
    jobName,
  });

  // ✅ Process asynchronously
  (async () => {
    try {
      const result = await discoverRepositories();
      await releaseJobLock(jobName, "success", result.newRepos + result.updatedRepos);
      console.log(`[${jobName}] Completed successfully:`, result);
    } catch (error) {
      console.error(`[${jobName}] Failed:`, error);
      await releaseJobLock(
        jobName,
        "failed",
        0,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  })().catch((error) => {
    console.error(`[${jobName}] Unhandled error in async processing:`, error);
  });
};

// ─── GitHub Sync (Tiered) ────────────────────────────────────────────────────

export const postTriggerGithubSync = async (req: Request, res: Response) => {
  const tier = (req.query.tier as string) || "all";

  // Map tier to job name
  const tierJobMap: Record<string, { jobName: string; displayName: string }> = {
    active: { jobName: "github-sync-active", displayName: "GitHub Sync - Active Repos" },
    moderate: { jobName: "github-sync-moderate", displayName: "GitHub Sync - Moderate Repos" },
    dormant: { jobName: "github-sync-dormant", displayName: "GitHub Sync - Dormant Repos" },
    all: { jobName: "github-sync-all", displayName: "GitHub Sync - All Repos" },
  };

  const { jobName, displayName } = tierJobMap[tier] || tierJobMap.all;

  const acquired = await acquireJobLock(jobName, displayName);
  if (!acquired) {
    return res.status(409).json({
      success: false,
      message: `GitHub sync (${tier}) is already running. Please try again later.`,
    });
  }

  // ✅ Respond immediately to avoid Cloud Scheduler timeout
  res.json({
    success: true,
    message: `${displayName} started`,
    jobName,
  });

  // ✅ Process asynchronously (don't await)
  (async () => {
    try {
      let result: any;
      if (tier === "active") {
        result = await syncActiveRepos();
      } else if (tier === "moderate") {
        result = await syncModerateRepos();
      } else if (tier === "dormant") {
        result = await syncDormantRepos();
      } else {
        const active = await syncActiveRepos();
        const moderate = await syncModerateRepos();
        const dormant = await syncDormantRepos();
        result = {
          active,
          moderate,
          dormant,
          total: active.total + moderate.total + dormant.total,
          success: active.success + moderate.success + dormant.success,
          failed: active.failed + moderate.failed + dormant.failed,
        };
      }

      cacheInvalidatePrefix("dev:");
      await releaseJobLock(jobName, "success", result.success || 0);
      console.log(`[${jobName}] Completed successfully:`, result);
    } catch (error) {
      console.error(`[${jobName}] Failed:`, error);
      await releaseJobLock(
        jobName,
        "failed",
        0,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  })().catch((error) => {
    console.error(`[${jobName}] Unhandled error in async processing:`, error);
  });
};

// ─── GitHub Backfill ─────────────────────────────────────────────────────────

export const postTriggerGithubBackfill = async (req: Request, res: Response) => {
  const jobName = "github-backfill";
  const displayName = "GitHub Historical Backfill";

  const acquired = await acquireJobLock(jobName, displayName);
  if (!acquired) {
    return res.status(409).json({
      success: false,
      message: "GitHub backfill is already running. Please try again later.",
    });
  }

  const limit = Math.max(1, parseInt((req.query.limit as string) || "50", 10) || 50);
  const minStars = Math.max(0, parseInt((req.query.minStars as string) || "0", 10) || 0);

  // ✅ Respond immediately to avoid Cloud Scheduler timeout
  res.json({
    success: true,
    message: `${displayName} started`,
    jobName,
  });

  // ✅ Process asynchronously
  (async () => {
    try {
      const result = await backfillRepositories({ limit, minStars });
      await releaseJobLock(jobName, "success", result.success);
      console.log(`[${jobName}] Completed successfully:`, result);
    } catch (error) {
      console.error(`[${jobName}] Failed:`, error);
      await releaseJobLock(
        jobName,
        "failed",
        0,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  })().catch((error) => {
    console.error(`[${jobName}] Unhandled error in async processing:`, error);
  });
};

// ─── GitHub Snapshot ─────────────────────────────────────────────────────────

export const postTriggerGithubSnapshot = async (_req: Request, res: Response) => {
  const jobName = "github-snapshot";
  const displayName = "GitHub Daily Snapshot";

  const acquired = await acquireJobLock(jobName, displayName);
  if (!acquired) {
    return res.status(409).json({
      success: false,
      message: "GitHub snapshot is already running. Please try again later.",
    });
  }

  // ✅ Respond immediately to avoid Cloud Scheduler timeout
  res.json({
    success: true,
    message: `${displayName} started`,
    jobName,
  });

  // ✅ Process asynchronously
  (async () => {
    try {
      const result = await snapshotAllRepos();
      await releaseJobLock(jobName, "success", result.success);
      console.log(`[${jobName}] Completed successfully:`, result);
    } catch (error) {
      console.error(`[${jobName}] Failed:`, error);
      await releaseJobLock(
        jobName,
        "failed",
        0,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  })().catch((error) => {
    console.error(`[${jobName}] Unhandled error in async processing:`, error);
  });
};

// ─── GitHub Aggregation ──────────────────────────────────────────────────────

export const postTriggerGithubAggregate = async (_req: Request, res: Response) => {
  const jobName = "github-aggregate";
  const displayName = "GitHub Data Aggregation";

  const acquired = await acquireJobLock(jobName, displayName);
  if (!acquired) {
    return res.status(409).json({
      success: false,
      message: "GitHub aggregation is already running. Please try again later.",
    });
  }

  // ✅ Respond immediately to avoid Cloud Scheduler timeout
  res.json({
    success: true,
    message: `${displayName} started`,
    jobName,
  });

  // ✅ Process asynchronously
  (async () => {
    try {
      const rollup = await aggregateRecentToHistorical();
      await precomputeNetworkGraphs();
      cacheInvalidatePrefix("dev:");
      await releaseJobLock(jobName, "success", rollup.daysRolledUp);
      console.log(`[${jobName}] Completed successfully:`, { rollup });
    } catch (error) {
      console.error(`[${jobName}] Failed:`, error);
      await releaseJobLock(
        jobName,
        "failed",
        0,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  })().catch((error) => {
    console.error(`[${jobName}] Unhandled error in async processing:`, error);
  });
};
