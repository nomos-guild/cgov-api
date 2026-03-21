import { Request, Response } from "express";
import { syncDrepInfoStep } from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";
import {
  acquireJobLock,
  getBoundedIntEnv,
  releaseJobLock,
} from "../../services/ingestion/syncLock";

const JOB_NAME = "drep-info-sync";
const DISPLAY_NAME = "DRep Info Sync";
const LOCK_EXPIRY_MS = getBoundedIntEnv(
  "DREP_INFO_SYNC_LOCK_TTL_MS",
  20 * 60 * 1000,
  30_000,
  60 * 60 * 1000
);

/**
 * POST /data/trigger-drep-info-sync
 *
 * Trigger full DRep info refresh from Koios /drep_info + /drep_updates.
 * This is the slowest analytics step — isolated for timeout safety.
 * Uses database-level locking to prevent concurrent runs.
 */
export const postTriggerDrepInfoSync = async (
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
      return res.status(409).json({ success: false, message: "DRep info sync is already running. Please try again later." });
    }

    console.log("[DRep Info Sync] Triggered via API endpoint");
    res.json({ success: true, message: "DRep info sync started", jobName: JOB_NAME });

    (async () => {
      try {
        const result = await syncDrepInfoStep(prisma);
        const itemsProcessed = result.drepInfo?.updated ?? 0;

        await releaseJobLock(JOB_NAME, "success", itemsProcessed);

        console.log("[DRep Info Sync] Completed successfully:", {
          currentEpoch: result.currentEpoch, epochToSync: result.epochToSync, itemsProcessed, skipped: result.skipped,
        });
      } catch (error) {
        console.error("[DRep Info Sync] Async processing error:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        try {
          await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
        } catch (updateError) {
          console.error("[DRep Info Sync] Failed to update sync status:", updateError);
        }
      }
    })().catch((error) => { console.error("[DRep Info Sync] Unhandled error:", error); });
  } catch (error) {
    console.error("[DRep Info Sync] Setup error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (acquired) {
      try {
        await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
      } catch (updateError) {
        console.error("[DRep Info Sync] Failed to update sync status:", updateError);
      }
    }
    res.status(500).json({ success: false, error: "Failed to start DRep info sync", message: errorMessage });
  }
};
