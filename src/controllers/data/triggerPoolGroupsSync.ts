import { Request, Response } from "express";
import { syncPoolGroupsStep } from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";
import { acquireJobLock, releaseJobLock } from "../../services/ingestion/syncLock";

const JOB_NAME = "pool-groups-sync";
const DISPLAY_NAME = "Pool Groups Sync";

/**
 * POST /data/trigger-pool-groups-sync
 *
 * Trigger pool groups (multi-pool operator mappings) sync.
 * Uses database-level locking to prevent concurrent runs.
 */
export const postTriggerPoolGroupsSync = async (
  _req: Request,
  res: Response
) => {
  let acquired = false;

  try {
    acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
      source: "api-instance",
    });

    if (!acquired) {
      return res.status(202).json({ success: true, accepted: false, message: "Pool groups sync is already running. Skipping duplicate trigger." });
    }

    console.log("[Pool Groups Sync] Triggered via API endpoint");
    res.status(202).json({ success: true, accepted: true, message: "Pool groups sync started", jobName: JOB_NAME });

    (async () => {
      try {
        const result = await syncPoolGroupsStep(prisma);
        const itemsProcessed = (result.poolGroups?.created ?? 0) + (result.poolGroups?.updated ?? 0);

        await releaseJobLock(JOB_NAME, "success", itemsProcessed);

        console.log("[Pool Groups Sync] Completed successfully:", {
          currentEpoch: result.currentEpoch, epochToSync: result.epochToSync, itemsProcessed, skipped: result.skipped,
        });
      } catch (error) {
        console.error("[Pool Groups Sync] Async processing error:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        try {
          await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
        } catch (updateError) {
          console.error("[Pool Groups Sync] Failed to update sync status:", updateError);
        }
      }
    })().catch((error) => { console.error("[Pool Groups Sync] Unhandled error:", error); });
  } catch (error) {
    console.error("[Pool Groups Sync] Setup error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (acquired) {
      try {
        await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
      } catch (updateError) {
        console.error("[Pool Groups Sync] Failed to update sync status:", updateError);
      }
    }
    res.status(500).json({ success: false, error: "Failed to start pool groups sync", message: errorMessage });
  }
};
