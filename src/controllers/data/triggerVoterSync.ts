import { Request, Response } from "express";
import { syncAllVoterVotingPower } from "../../services/ingestion/voter.service";
import { prisma } from "../../services";

const JOB_NAME = "voter-power-sync";
const DISPLAY_NAME = "Voter Power Sync";
const LOCK_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes (matches Cloud Run max timeout)

/**
 * POST /data/trigger-voter-sync
 *
 * Manually trigger voter power sync (for testing/admin use and Cloud Scheduler cron)
 * Uses database-level locking to prevent concurrent runs
 */
export const postTriggerVoterSync = async (_req: Request, res: Response) => {
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
        "[Manual Voter Sync] Skipped - another sync is already running"
      );
      return res.status(409).json({
        success: false,
        message: "Voter power sync is already running. Please try again later.",
      });
    }

    console.log("[Manual Voter Sync] Triggered via API endpoint");

    // ✅ Respond immediately to avoid Cloud Scheduler timeout
    res.json({
      success: true,
      message: "Voter power sync started",
      jobName: JOB_NAME,
    });

    // ✅ Process asynchronously
    (async () => {
      try {
        // Run the sync
        const results = await syncAllVoterVotingPower(prisma);

        // Mark sync as completed
        await prisma.syncStatus.update({
          where: { jobName: JOB_NAME },
          data: {
            isRunning: false,
            completedAt: new Date(),
            lastResult: "success",
            itemsProcessed: results.dreps.updated + results.spos.updated,
            expiresAt: null,
            errorMessage: null,
          },
        });

        console.log("[Manual Voter Sync] Completed successfully:", results);
      } catch (error) {
        console.error("[Manual Voter Sync] Async processing error:", error);

        const errorMessage = error instanceof Error ? error.message : "Unknown error";

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
    try {
      const status = await prisma.syncStatus.findUnique({ where: { jobName: JOB_NAME } });
      if (status?.isRunning) {
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
      }
    } catch (updateError) {
      console.error("[Manual Voter Sync] Failed to update sync status:", updateError);
    }

    res.status(500).json({
      success: false,
      error: "Failed to start voter power sync",
      message: errorMessage,
    });
  }
};
