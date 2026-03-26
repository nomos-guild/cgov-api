import { Request, Response } from "express";
import { syncAllProposals } from "../../services/ingestion/proposal.service";
import { updateNCL } from "../../services/ingestion/ncl.service";
import {
  PROPOSAL_SYNC_JOB_NAME,
  releaseProposalSyncLock,
  tryAcquireProposalSyncLock,
} from "../../services/ingestion/proposalSyncLock";

/**
 * POST /data/trigger-sync
 *
 * Manually trigger proposal sync (for testing/admin use and Cloud Scheduler cron)
 * Uses database-level locking to prevent concurrent runs
 */
export const postTriggerSync = async (_req: Request, res: Response) => {
  let acquired = false;

  try {
    acquired = await tryAcquireProposalSyncLock("manual-trigger");

    if (!acquired) {
      console.log("[Manual Sync] Skipped - another sync is already running");
      return res.status(202).json({
        success: true,
        accepted: false,
        message: "Proposal sync is already running. Skipping duplicate trigger.",
      });
    }

    console.log("[Manual Sync] Triggered via API endpoint");

    // ✅ Respond immediately to avoid Cloud Scheduler timeout
    res.status(202).json({
      success: true,
      accepted: true,
      message: "Proposal sync started",
      jobName: PROPOSAL_SYNC_JOB_NAME,
    });

    // ✅ Process asynchronously
    (async () => {
      try {
        // Run the sync
        const results = await syncAllProposals();

        // Update NCL after proposal sync
        let nclResult: Awaited<ReturnType<typeof updateNCL>> | null = null;
        try {
          nclResult = await updateNCL();
          console.log("[Manual Sync] NCL update completed");
        } catch (nclError: any) {
          console.error("[Manual Sync] NCL update failed:", nclError.message);
        }

        // Mark sync as completed
        await releaseProposalSyncLock({
          status: "success",
          itemsProcessed: results.success,
        });

        console.log("[Manual Sync] Completed successfully:", {
          total: results.total,
          success: results.success,
          partial: results.partial,
          failed: results.failed,
          nclUpdated: !!nclResult,
        });
      } catch (error) {
        console.error("[Manual Sync] Async processing error:", error);

        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        // Mark sync as failed
        try {
          await releaseProposalSyncLock({
            status: "failed",
            errorMessage,
          });
        } catch (updateError) {
          console.error("[Manual Sync] Failed to update sync status:", updateError);
        }
      }
    })().catch((error) => {
      console.error("[Manual Sync] Unhandled error in async processing:", error);
    });
  } catch (error) {
    console.error("[Manual Sync] Setup error:", error);

    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Mark sync as failed (only if lock was acquired)
    if (acquired) {
      try {
      await releaseProposalSyncLock({
        status: "failed",
        errorMessage,
      });
      } catch (updateError) {
        console.error("[Manual Sync] Failed to update sync status:", updateError);
      }
    }

    res.status(500).json({
      success: false,
      error: "Failed to start proposal sync",
      message: errorMessage,
    });
  }
};