import { Request, Response } from "express";
import { syncDrepDelegationChanges } from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";

const JOB_NAME = "drep-delegator-sync";
const DISPLAY_NAME = "DRep Delegator Sync";
const LOCK_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes (matches Cloud Run max timeout)

/**
 * POST /data/trigger-drep-delegator-sync
 *
 * Trigger DRep delegation change sync (for testing/admin use and Cloud Scheduler cron)
 * Uses database-level locking to prevent concurrent runs
 */
export const postTriggerDrepDelegatorSync = async (
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
        "[DRep Delegator Sync] Skipped - another sync is already running"
      );
      return res.status(409).json({
        success: false,
        message:
          "DRep delegator sync is already running. Please try again later.",
      });
    }

    console.log("[DRep Delegator Sync] Triggered via API endpoint");

    // Run the sync
    const result = await syncDrepDelegationChanges(prisma);

    // Mark sync as completed
    await prisma.syncStatus.update({
      where: { jobName: JOB_NAME },
      data: {
        isRunning: false,
        completedAt: new Date(),
        lastResult: "success",
        itemsProcessed: result.statesUpdated + result.changesInserted,
        expiresAt: null,
        errorMessage: null,
      },
    });

    console.log("[DRep Delegator Sync] Completed successfully");

    res.json({
      success: true,
      message: "DRep delegator sync completed",
      results: {
        currentEpoch: result.currentEpoch,
        lastProcessedEpoch: result.lastProcessedEpoch,
        maxDelegationEpoch: result.maxDelegationEpoch,
        drepsProcessed: result.drepsProcessed,
        delegatorsProcessed: result.delegatorsProcessed,
        statesUpdated: result.statesUpdated,
        changesInserted: result.changesInserted,
        failed: result.failed.length,
      },
    });
  } catch (error) {
    console.error("[DRep Delegator Sync] Error:", error);

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
        "[DRep Delegator Sync] Failed to update sync status:",
        updateError
      );
    }

    res.status(500).json({
      success: false,
      error: "Failed to sync DRep delegators",
      message: errorMessage,
    });
  }
};
