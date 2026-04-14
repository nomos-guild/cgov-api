import { Request, Response } from "express";
import { syncPoolGroupsStep } from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";
import { acquireJobLock, releaseJobLock } from "../../services/ingestion/syncLock";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

const JOB_NAME = "pool-groups-sync";
const DISPLAY_NAME = "Pool Groups Sync";

/**
 * POST /data/trigger-pool-groups-sync
 *
 * Trigger pool groups (multi-pool operator mappings) sync.
 * Uses database-level locking to prevent concurrent runs.
 *
 * Query/body: `force=true` clears the epoch checkpoint for pool groups so a full re-fetch runs
 * even if this epoch was already marked synced (e.g. after fixing pagination).
 */
export const postTriggerPoolGroupsSync = async (
  req: Request,
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

    const force =
      req.query.force === "true" ||
      req.query.force === "1" ||
      (typeof req.body === "object" &&
        req.body !== null &&
        (req.body as { force?: boolean }).force === true);

    console.log(
      `[Pool Groups Sync] Triggered via API endpoint${force ? " (force=true)" : ""}`
    );
    res.status(202).json({
      success: true,
      accepted: true,
      message: "Pool groups sync started",
      jobName: JOB_NAME,
      force,
    });

    (async () => {
      try {
        const result = await syncPoolGroupsStep(prisma, { force });
        const itemsProcessed = (result.poolGroups?.created ?? 0) + (result.poolGroups?.updated ?? 0);

        await releaseJobLock(JOB_NAME, "success", itemsProcessed);

        console.log("[Pool Groups Sync] Completed successfully:", {
          currentEpoch: result.currentEpoch, epochToSync: result.epochToSync, itemsProcessed, skipped: result.skipped,
        });
      } catch (error) {
        console.error("[Pool Groups Sync] Async processing error:", formatAxiosLikeError(error));
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        try {
          await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
        } catch (updateError) {
          console.error("[Pool Groups Sync] Failed to update sync status:", formatAxiosLikeError(updateError));
        }
      }
    })().catch((error) => { console.error("[Pool Groups Sync] Unhandled error:", formatAxiosLikeError(error)); });
  } catch (error) {
    console.error("[Pool Groups Sync] Setup error:", formatAxiosLikeError(error));
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (acquired) {
      try {
        await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
      } catch (updateError) {
        console.error("[Pool Groups Sync] Failed to update sync status:", formatAxiosLikeError(updateError));
      }
    }
    res.status(500).json({ success: false, error: "Failed to start pool groups sync", message: errorMessage });
  }
};
