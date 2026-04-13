import { Request, Response } from "express";
import { syncEpochTotalsStep } from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";
import { acquireJobLock, releaseJobLock } from "../../services/ingestion/syncLock";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

const JOB_NAME = "epoch-totals-sync";
const DISPLAY_NAME = "Epoch Totals Sync";

/**
 * POST /data/trigger-epoch-totals-sync
 *
 * Trigger epoch totals sync for previous + current epoch.
 * Previous epoch is checkpointed; current epoch always refreshes.
 * Uses database-level locking to prevent concurrent runs.
 */
export const postTriggerEpochTotalsSync = async (
  _req: Request,
  res: Response
) => {
  let acquired = false;

  try {
    acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
      source: "api-instance",
    });

    if (!acquired) {
      return res.status(202).json({ success: true, accepted: false, message: "Epoch totals sync is already running. Skipping duplicate trigger." });
    }

    console.log("[Epoch Totals Sync] Triggered via API endpoint");
    res.status(202).json({ success: true, accepted: true, message: "Epoch totals sync started", jobName: JOB_NAME });

    (async () => {
      try {
        const result = await syncEpochTotalsStep(prisma);

        await releaseJobLock(
          JOB_NAME,
          "success",
          result.skippedPrevious ? 1 : 2
        );

        console.log("[Epoch Totals Sync] Completed successfully:", {
          currentEpoch: result.currentEpoch, epochToSync: result.epochToSync, skippedPrevious: result.skippedPrevious,
        });
      } catch (error) {
        console.error("[Epoch Totals Sync] Async processing error:", formatAxiosLikeError(error));
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        try {
          await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
        } catch (updateError) {
          console.error("[Epoch Totals Sync] Failed to update sync status:", formatAxiosLikeError(updateError));
        }
      }
    })().catch((error) => { console.error("[Epoch Totals Sync] Unhandled error:", formatAxiosLikeError(error)); });
  } catch (error) {
    console.error("[Epoch Totals Sync] Setup error:", formatAxiosLikeError(error));
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (acquired) {
      try {
        await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
      } catch (updateError) {
        console.error("[Epoch Totals Sync] Failed to update sync status:", formatAxiosLikeError(updateError));
      }
    }
    res.status(500).json({ success: false, error: "Failed to start epoch totals sync", message: errorMessage });
  }
};
