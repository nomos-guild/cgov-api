import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  acquireJobLock,
  releaseJobLock,
} from "../../services/ingestion/syncLock";
import {
  DREP_DELEGATOR_SYNC_JOB_NAME,
  isDrepDelegatorDailyBudgetExhausted,
  readDrepDelegatorDailyBudgetCursor,
  runDrepDelegatorSyncWithDailyRetry,
} from "../../services/ingestion/drep-delegator-sync-run";
import { DREP_DELEGATOR_SYNC_LOCK_TTL_MS } from "../../services/ingestion/sync-utils";

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
    const preCursor = await readDrepDelegatorDailyBudgetCursor();
    if (isDrepDelegatorDailyBudgetExhausted(preCursor)) {
      console.log(
        "[DRep Delegator Sync] Skipped - daily budget exhausted for this UTC day"
      );
      return res.status(202).json({
        success: true,
        accepted: false,
        message:
          "DRep delegator sync daily budget exhausted for this UTC day. No further heavy runs until next UTC day.",
      });
    }

    acquired = await acquireJobLock(
      DREP_DELEGATOR_SYNC_JOB_NAME,
      DISPLAY_NAME,
      {
        ttlMs: DREP_DELEGATOR_SYNC_LOCK_TTL_MS,
        source: "api-instance",
      }
    );

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

    const postCursor = await readDrepDelegatorDailyBudgetCursor();
    if (isDrepDelegatorDailyBudgetExhausted(postCursor)) {
      await releaseJobLock(DREP_DELEGATOR_SYNC_JOB_NAME, "success", 0);
      acquired = false;
      console.log(
        "[DRep Delegator Sync] Skipped after lock - daily budget exhausted (race with other instance)"
      );
      return res.status(202).json({
        success: true,
        accepted: false,
        message:
          "DRep delegator sync daily budget exhausted for this UTC day. Lock released without running.",
      });
    }

    const lease = await prisma.syncStatus.findUnique({
      where: { jobName: DREP_DELEGATOR_SYNC_JOB_NAME },
      select: { startedAt: true, expiresAt: true, lockedBy: true },
    });
    console.log(
      `[DRep Delegator Sync] lockLease startedAt=${lease?.startedAt?.toISOString() ?? "null"} expiresAt=${lease?.expiresAt?.toISOString() ?? "null"} lockedBy=${lease?.lockedBy ?? "null"}`
    );

    console.log("[DRep Delegator Sync] Triggered via API endpoint");

    res.status(202).json({
      success: true,
      accepted: true,
      message: "DRep delegator sync started",
      jobName: DREP_DELEGATOR_SYNC_JOB_NAME,
    });

    (async () => {
      try {
        const outcome = await runDrepDelegatorSyncWithDailyRetry(prisma);

        if (outcome.kind === "skipped") {
          const result = outcome.result;
          await releaseJobLock(
            DREP_DELEGATOR_SYNC_JOB_NAME,
            "success",
            result.statesUpdated + result.changesInserted
          );
          console.log("[DRep Delegator Sync] Completed (throttled/skipped):", {
            skipReason: result.skipReason,
          });
          return;
        }

        const result = outcome.result;
        await releaseJobLock(
          DREP_DELEGATOR_SYNC_JOB_NAME,
          outcome.lockResult,
          outcome.itemsProcessed
        );

        console.log("[DRep Delegator Sync] Completed:", {
          currentEpoch: result.currentEpoch,
          drepsProcessed: result.drepsProcessed,
          delegatorsProcessed: result.delegatorsProcessed,
          statesUpdated: result.statesUpdated,
          changesInserted: result.changesInserted,
          failed: result.failed.length,
          lastResult: outcome.lockResult,
        });
      } catch (error) {
        console.error("[DRep Delegator Sync] Async processing error:", error);

        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        try {
          await releaseJobLock(
            DREP_DELEGATOR_SYNC_JOB_NAME,
            "failed",
            0,
            errorMessage
          );
        } catch (updateError) {
          console.error(
            "[DRep Delegator Sync] Failed to update sync status:",
            updateError
          );
        }
      }
    })().catch((error) => {
      console.error(
        "[DRep Delegator Sync] Unhandled error in async processing:",
        error
      );
    });
  } catch (error) {
    console.error("[DRep Delegator Sync] Setup error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    if (acquired) {
      try {
        await releaseJobLock(
          DREP_DELEGATOR_SYNC_JOB_NAME,
          "failed",
          0,
          errorMessage
        );
      } catch (updateError) {
        console.error(
          "[DRep Delegator Sync] Failed to update sync status:",
          updateError
        );
      }
    }

    res.status(500).json({
      success: false,
      error: "Failed to start DRep delegator sync",
      message: errorMessage,
    });
  }
};
