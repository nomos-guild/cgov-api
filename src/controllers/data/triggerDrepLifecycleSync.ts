import { Request, Response } from "express";
import { syncDrepLifecycleStep } from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";

const JOB_NAME = "drep-lifecycle-sync";
const DISPLAY_NAME = "DRep Lifecycle Sync";
const LOCK_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/**
 * POST /data/trigger-drep-lifecycle-sync
 *
 * Trigger DRep lifecycle events sync (registrations, deregistrations, updates).
 * Uses database-level locking to prevent concurrent runs.
 */
export const postTriggerDrepLifecycleSync = async (
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
      return res.status(409).json({ success: false, message: "DRep lifecycle sync is already running. Please try again later." });
    }

    console.log("[DRep Lifecycle Sync] Triggered via API endpoint");
    res.json({ success: true, message: "DRep lifecycle sync started", jobName: JOB_NAME });

    (async () => {
      try {
        const result = await syncDrepLifecycleStep(prisma);
        const itemsProcessed = result.drepLifecycle?.eventsIngested ?? 0;

        await prisma.syncStatus.update({
          where: { jobName: JOB_NAME },
          data: { isRunning: false, completedAt: new Date(), lastResult: "success", itemsProcessed, expiresAt: null, errorMessage: null },
        });

        console.log("[DRep Lifecycle Sync] Completed successfully:", {
          currentEpoch: result.currentEpoch, epochToSync: result.epochToSync, itemsProcessed, skipped: result.skipped,
        });
      } catch (error) {
        console.error("[DRep Lifecycle Sync] Async processing error:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        try {
          await prisma.syncStatus.update({ where: { jobName: JOB_NAME }, data: { isRunning: false, completedAt: new Date(), lastResult: "failed", expiresAt: null, errorMessage } });
        } catch (updateError) {
          console.error("[DRep Lifecycle Sync] Failed to update sync status:", updateError);
        }
      }
    })().catch((error) => { console.error("[DRep Lifecycle Sync] Unhandled error:", error); });
  } catch (error) {
    console.error("[DRep Lifecycle Sync] Setup error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    try {
      const status = await prisma.syncStatus.findUnique({ where: { jobName: JOB_NAME } });
      if (status?.isRunning) {
        await prisma.syncStatus.update({ where: { jobName: JOB_NAME }, data: { isRunning: false, completedAt: new Date(), lastResult: "failed", expiresAt: null, errorMessage } });
      }
    } catch (updateError) {
      console.error("[DRep Lifecycle Sync] Failed to update sync status:", updateError);
    }
    res.status(500).json({ success: false, error: "Failed to start DRep lifecycle sync", message: errorMessage });
  }
};
