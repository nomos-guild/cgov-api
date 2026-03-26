import { Request, Response } from "express";
import { syncMissingEpochAnalytics } from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";
import {
  acquireJobLock,
  getBoundedIntEnv,
  releaseJobLock,
} from "../../services/ingestion/syncLock";

const JOB_NAME = "missing-epochs-sync";
const DISPLAY_NAME = "Missing Epochs Backfill";
const LOCK_EXPIRY_MS = getBoundedIntEnv(
  "MISSING_EPOCHS_SYNC_LOCK_TTL_MS",
  30 * 60 * 1000,
  30_000,
  60 * 60 * 1000
);

/**
 * POST /data/trigger-missing-epochs-sync
 *
 * Trigger backfill of missing epoch totals.
 * Uses database-level locking to prevent concurrent runs.
 */
export const postTriggerMissingEpochsSync = async (
  _req: Request,
  res: Response
) => {
  let acquired = false;

  try {
    acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
      ttlMs: LOCK_EXPIRY_MS,
      source: "api-instance",
    });

    if (!acquired) {
      return res.status(202).json({ success: true, accepted: false, message: "Missing epochs backfill is already running. Skipping duplicate trigger." });
    }

    console.log("[Missing Epochs Sync] Triggered via API endpoint");
    res.status(202).json({ success: true, accepted: true, message: "Missing epochs backfill started", jobName: JOB_NAME });

    (async () => {
      try {
        const backfill = await syncMissingEpochAnalytics(prisma);
        const itemsProcessed = backfill.totals.synced.length;

        await releaseJobLock(JOB_NAME, "success", itemsProcessed);

        console.log("[Missing Epochs Sync] Completed successfully:", {
          range: `${backfill.startEpoch}-${backfill.endEpoch}`,
          missing: backfill.totals.missing.length,
          synced: backfill.totals.synced.length,
          failed: backfill.totals.failed.length,
        });
      } catch (error) {
        console.error("[Missing Epochs Sync] Async processing error:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        try {
          await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
        } catch (updateError) {
          console.error("[Missing Epochs Sync] Failed to update sync status:", updateError);
        }
      }
    })().catch((error) => { console.error("[Missing Epochs Sync] Unhandled error:", error); });
  } catch (error) {
    console.error("[Missing Epochs Sync] Setup error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (acquired) {
      try {
        await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
      } catch (updateError) {
        console.error("[Missing Epochs Sync] Failed to update sync status:", updateError);
      }
    }
    res.status(500).json({ success: false, error: "Failed to start missing epochs backfill", message: errorMessage });
  }
};
