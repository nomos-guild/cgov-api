import { Request, Response } from "express";
import { syncDrepDelegationChanges } from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";
import { acquireJobLock, releaseJobLock } from "../../services/ingestion/syncLock";
import { DREP_DELEGATOR_SYNC_LOCK_TTL_MS } from "../../services/ingestion/sync-utils";

const JOB_NAME = "drep-delegator-sync";
const DISPLAY_NAME = "DRep Delegator Sync";

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
  let acquired = false;

  try {
    // Try to acquire lock using database transaction
    acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
      ttlMs: DREP_DELEGATOR_SYNC_LOCK_TTL_MS,
      source: "api-instance",
    });

    if (!acquired) {
      console.log(
        "[DRep Delegator Sync] Skipped - another sync is already running"
      );
      return res.status(202).json({
        success: true,
        accepted: false,
        message:
          "DRep delegator sync is already running. Skipping duplicate trigger.",
      });
    }

    const lease = await prisma.syncStatus.findUnique({
      where: { jobName: JOB_NAME },
      select: { startedAt: true, expiresAt: true, lockedBy: true },
    });
    console.log(
      `[DRep Delegator Sync] lockLease startedAt=${lease?.startedAt?.toISOString() ?? "null"} expiresAt=${lease?.expiresAt?.toISOString() ?? "null"} lockedBy=${lease?.lockedBy ?? "null"}`
    );

    console.log("[DRep Delegator Sync] Triggered via API endpoint");

    // ✅ Respond immediately to avoid Cloud Scheduler timeout
    res.status(202).json({
      success: true,
      accepted: true,
      message: "DRep delegator sync started",
      jobName: JOB_NAME,
    });

    // ✅ Process asynchronously
    (async () => {
      try {
        // Run the sync
        const result = await syncDrepDelegationChanges(prisma);

        // Mark sync as completed
        await releaseJobLock(
          JOB_NAME,
          "success",
          result.statesUpdated + result.changesInserted
        );

        console.log("[DRep Delegator Sync] Completed successfully:", {
          currentEpoch: result.currentEpoch,
          drepsProcessed: result.drepsProcessed,
          delegatorsProcessed: result.delegatorsProcessed,
          statesUpdated: result.statesUpdated,
          changesInserted: result.changesInserted,
        });
      } catch (error) {
        console.error("[DRep Delegator Sync] Async processing error:", error);

        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        // Mark sync as failed
        try {
          await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
        } catch (updateError) {
          console.error("[DRep Delegator Sync] Failed to update sync status:", updateError);
        }
      }
    })().catch((error) => {
      console.error("[DRep Delegator Sync] Unhandled error in async processing:", error);
    });
  } catch (error) {
    console.error("[DRep Delegator Sync] Setup error:", error);

    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Mark sync as failed (only if lock was acquired)
    if (acquired) {
      try {
        await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
      } catch (updateError) {
        console.error("[DRep Delegator Sync] Failed to update sync status:", updateError);
      }
    }

    res.status(500).json({
      success: false,
      error: "Failed to start DRep delegator sync",
      message: errorMessage,
    });
  }
};
