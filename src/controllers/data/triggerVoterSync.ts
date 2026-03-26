import { Request, Response } from "express";
import { syncAllVoterVotingPower } from "../../services/ingestion/voterPowerSync.service";
import { prisma } from "../../services";
import { acquireJobLock, releaseJobLock } from "../../services/ingestion/syncLock";

const JOB_NAME = "voter-power-sync";
const DISPLAY_NAME = "Voter Power Sync";

/**
 * POST /data/trigger-voter-sync
 *
 * Manually trigger voter power sync (for testing/admin use and Cloud Scheduler cron)
 * Uses database-level locking to prevent concurrent runs
 */
export const postTriggerVoterSync = async (_req: Request, res: Response) => {
  let acquired = false;

  try {
    // Try to acquire lock using database transaction
    acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
      source: "api-instance",
    });

    if (!acquired) {
      console.log(
        "[Manual Voter Sync] Skipped - another sync is already running"
      );
      return res.status(202).json({
        success: true,
        accepted: false,
        message: "Voter power sync is already running. Skipping duplicate trigger.",
      });
    }

    console.log("[Manual Voter Sync] Triggered via API endpoint");

    // ✅ Respond immediately to avoid Cloud Scheduler timeout
    res.status(202).json({
      success: true,
      accepted: true,
      message: "Voter power sync started",
      jobName: JOB_NAME,
    });

    // ✅ Process asynchronously
    (async () => {
      try {
        // Run the sync
        const results = await syncAllVoterVotingPower(prisma);

        // Mark sync as completed
        await releaseJobLock(
          JOB_NAME,
          "success",
          results.dreps.updated + results.spos.updated
        );

        console.log("[Manual Voter Sync] Completed successfully:", results);
      } catch (error) {
        console.error("[Manual Voter Sync] Async processing error:", error);

        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        // Mark sync as failed
        try {
          await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
        } catch (updateError) {
          console.error("[Manual Voter Sync] Failed to update sync status:", updateError);
        }
      }
    })().catch((error) => {
      console.error("[Manual Voter Sync] Unhandled error in async processing:", error);
    });
  } catch (error) {
    console.error("[Manual Voter Sync] Setup error:", error);

    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Mark sync as failed (only if lock was acquired)
    if (acquired) {
      try {
        await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
      } catch (updateError) {
        console.error("[Manual Voter Sync] Failed to update sync status:", updateError);
      }
    }

    res.status(500).json({
      success: false,
      error: "Failed to start voter power sync",
      message: errorMessage,
    });
  }
};
