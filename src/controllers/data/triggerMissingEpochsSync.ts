import { Request, Response } from "express";
import { syncMissingEpochAnalytics } from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";

const JOB_NAME = "missing-epochs-sync";
const DISPLAY_NAME = "Missing Epochs Backfill";
const LOCK_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes (backfill can be slow)

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
  const now = new Date();

  try {
    const acquired = await prisma.$transaction(async (tx) => {
      await tx.syncStatus.updateMany({
        where: { jobName: JOB_NAME, isRunning: true, expiresAt: { lt: now } },
        data: { isRunning: false, lastResult: "expired", errorMessage: "Lock expired - previous run may have crashed" },
      });

      const status = await tx.syncStatus.findUnique({ where: { jobName: JOB_NAME } });
      if (status?.isRunning) return false;

      await tx.syncStatus.upsert({
        where: { jobName: JOB_NAME },
        create: { jobName: JOB_NAME, displayName: DISPLAY_NAME, isRunning: true, startedAt: now, expiresAt: new Date(now.getTime() + LOCK_EXPIRY_MS), lockedBy: process.env.HOSTNAME || "api-instance" },
        update: { isRunning: true, startedAt: now, expiresAt: new Date(now.getTime() + LOCK_EXPIRY_MS), lockedBy: process.env.HOSTNAME || "api-instance", errorMessage: null },
      });
      return true;
    });

    if (!acquired) {
      return res.status(409).json({ success: false, message: "Missing epochs backfill is already running. Please try again later." });
    }

    console.log("[Missing Epochs Sync] Triggered via API endpoint");
    res.json({ success: true, message: "Missing epochs backfill started", jobName: JOB_NAME });

    (async () => {
      try {
        const backfill = await syncMissingEpochAnalytics(prisma);
        const itemsProcessed = backfill.totals.synced.length;

        await prisma.syncStatus.update({
          where: { jobName: JOB_NAME },
          data: { isRunning: false, completedAt: new Date(), lastResult: "success", itemsProcessed, expiresAt: null, errorMessage: null },
        });

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
          await prisma.syncStatus.update({ where: { jobName: JOB_NAME }, data: { isRunning: false, completedAt: new Date(), lastResult: "failed", expiresAt: null, errorMessage } });
        } catch (updateError) {
          console.error("[Missing Epochs Sync] Failed to update sync status:", updateError);
        }
      }
    })().catch((error) => { console.error("[Missing Epochs Sync] Unhandled error:", error); });
  } catch (error) {
    console.error("[Missing Epochs Sync] Setup error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    try {
      const status = await prisma.syncStatus.findUnique({ where: { jobName: JOB_NAME } });
      if (status?.isRunning) {
        await prisma.syncStatus.update({ where: { jobName: JOB_NAME }, data: { isRunning: false, completedAt: new Date(), lastResult: "failed", expiresAt: null, errorMessage } });
      }
    } catch (updateError) {
      console.error("[Missing Epochs Sync] Failed to update sync status:", updateError);
    }
    res.status(500).json({ success: false, error: "Failed to start missing epochs backfill", message: errorMessage });
  }
};
