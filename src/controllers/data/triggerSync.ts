import { Request, Response } from "express";
import { syncAllProposals } from "../../services/ingestion/proposal.service";
import { updateNCL } from "../../services/ingestion/ncl.service";
import { prisma } from "../../services";

const JOB_NAME = "proposal-sync";
const DISPLAY_NAME = "Proposal Sync";
const LOCK_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes (matches Cloud Run max timeout)

/**
 * POST /data/trigger-sync
 *
 * Manually trigger proposal sync (for testing/admin use and Cloud Scheduler cron)
 * Uses database-level locking to prevent concurrent runs
 */
export const postTriggerSync = async (_req: Request, res: Response) => {
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
      console.log("[Manual Sync] Skipped - another sync is already running");
      return res.status(409).json({
        success: false,
        message: "Proposal sync is already running. Please try again later.",
      });
    }

    console.log("[Manual Sync] Triggered via API endpoint");

    // ✅ Respond immediately to avoid Cloud Scheduler timeout
    res.json({
      success: true,
      message: "Proposal sync started",
      jobName: JOB_NAME,
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
        await prisma.syncStatus.update({
          where: { jobName: JOB_NAME },
          data: {
            isRunning: false,
            completedAt: new Date(),
            lastResult: "success",
            itemsProcessed: results.success,
            expiresAt: null,
            errorMessage: null,
          },
        });

        console.log("[Manual Sync] Completed successfully:", {
          total: results.total,
          success: results.success,
          failed: results.failed,
          nclUpdated: !!nclResult,
        });
      } catch (error) {
        console.error("[Manual Sync] Async processing error:", error);

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
      console.error("[Manual Sync] Failed to update sync status:", updateError);
    }

    res.status(500).json({
      success: false,
      error: "Failed to start proposal sync",
      message: errorMessage,
    });
  }
};