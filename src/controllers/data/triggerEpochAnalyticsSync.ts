import { Request, Response } from "express";
import {
  syncGovernanceAnalyticsForPreviousAndCurrentEpoch,
  syncMissingEpochAnalytics,
} from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";

const JOB_NAME = "epoch-analytics-sync";
const DISPLAY_NAME = "Epoch Analytics Sync";
const LOCK_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes (matches Cloud Run max timeout)

/**
 * POST /data/trigger-epoch-analytics-sync
 *
 * Trigger epoch analytics sync (for testing/admin use and Cloud Scheduler cron)
 * Uses database-level locking to prevent concurrent runs
 */
export const postTriggerEpochAnalyticsSync = async (
  _req: Request,
  res: Response
) => {
  const now = new Date();

  try {
    // Try to acquire lock using database transaction
    const acquired = await prisma.$transaction(async (tx) => {
      // Clear expired locks (in case previous run crashed)
      await tx.syncStatus.updateMany({
        where: {
          jobName: JOB_NAME,
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
        where: { jobName: JOB_NAME },
      });

      if (status?.isRunning) {
        return false;
      }

      // Acquire lock
      await tx.syncStatus.upsert({
        where: { jobName: JOB_NAME },
        create: {
          jobName: JOB_NAME,
          displayName: DISPLAY_NAME,
          isRunning: true,
          startedAt: now,
          expiresAt: new Date(now.getTime() + LOCK_EXPIRY_MS),
          lockedBy: process.env.HOSTNAME || "api-instance",
        },
        update: {
          isRunning: true,
          startedAt: now,
          expiresAt: new Date(now.getTime() + LOCK_EXPIRY_MS),
          lockedBy: process.env.HOSTNAME || "api-instance",
          errorMessage: null,
        },
      });

      return true;
    });

    if (!acquired) {
      console.log(
        "[Epoch Analytics Sync] Skipped - another sync is already running"
      );
      return res.status(409).json({
        success: false,
        message:
          "Epoch analytics sync is already running. Please try again later.",
      });
    }

    console.log("[Epoch Analytics Sync] Triggered via API endpoint");

    // Run the sync
    const result = await syncGovernanceAnalyticsForPreviousAndCurrentEpoch(
      prisma
    );

    // Backfill missing epoch totals
    const backfill = await syncMissingEpochAnalytics(prisma);

    // Calculate items processed
    const previous = result.previousEpoch;
    let itemsProcessed = 0;
    if (previous.dreps) itemsProcessed += previous.dreps.created;
    if (previous.drepInfo) itemsProcessed += previous.drepInfo.updated;
    if (previous.drepLifecycle)
      itemsProcessed += previous.drepLifecycle.eventsIngested;
    if (previous.poolGroups) itemsProcessed += previous.poolGroups.created;
    itemsProcessed += backfill.totals.synced.length;

    // Mark sync as completed
    await prisma.syncStatus.update({
      where: { jobName: JOB_NAME },
      data: {
        isRunning: false,
        completedAt: new Date(),
        lastResult: "success",
        itemsProcessed,
        expiresAt: null,
        errorMessage: null,
      },
    });

    console.log("[Epoch Analytics Sync] Completed successfully");

    res.json({
      success: true,
      message: "Epoch analytics sync completed",
      results: {
        currentEpoch: result.currentEpoch,
        previousEpoch: {
          epoch: previous.epoch,
          dreps: previous.dreps ?? { skipped: true },
          drepInfo: previous.drepInfo ?? { skipped: true },
          totals: previous.totals ?? { skipped: true },
          drepLifecycle: previous.drepLifecycle ?? { skipped: true },
          poolGroups: previous.poolGroups ?? { skipped: true },
        },
        backfill: {
          missing: backfill.totals.missing.length,
          synced: backfill.totals.synced.length,
          failed: backfill.totals.failed.length,
        },
      },
    });
  } catch (error) {
    console.error("[Epoch Analytics Sync] Error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Mark sync as failed
    try {
      await prisma.syncStatus.update({
        where: { jobName: JOB_NAME },
        data: {
          isRunning: false,
          completedAt: new Date(),
          lastResult: "failed",
          expiresAt: null,
          errorMessage: errorMessage,
        },
      });
    } catch (updateError) {
      console.error(
        "[Epoch Analytics Sync] Failed to update sync status:",
        updateError
      );
    }

    res.status(500).json({
      success: false,
      error: "Failed to sync epoch analytics",
      message: errorMessage,
    });
  }
};
