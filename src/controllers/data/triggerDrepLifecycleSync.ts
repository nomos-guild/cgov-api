import { Request, Response } from "express";
import { syncDrepLifecycleStep } from "../../services/ingestion/epoch-analytics.service";
import { prisma } from "../../services";
import { acquireJobLock, releaseJobLock } from "../../services/ingestion/syncLock";
import { DREP_LIFECYCLE_SYNC_LOCK_TTL_MS } from "../../services/ingestion/sync-utils";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

const JOB_NAME = "drep-lifecycle-sync";
const DISPLAY_NAME = "DRep Lifecycle Sync";

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
  let acquired = false;

  try {
    acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
      ttlMs: DREP_LIFECYCLE_SYNC_LOCK_TTL_MS,
      source: "api-instance",
    });

    if (!acquired) {
      return res.status(202).json({ success: true, accepted: false, message: "DRep lifecycle sync is already running. Skipping duplicate trigger." });
    }

    const lease = await prisma.syncStatus.findUnique({
      where: { jobName: JOB_NAME },
      select: { startedAt: true, expiresAt: true, lockedBy: true },
    });
    console.log(
      `[DRep Lifecycle Sync] lockLease startedAt=${lease?.startedAt?.toISOString() ?? "null"} expiresAt=${lease?.expiresAt?.toISOString() ?? "null"} lockedBy=${lease?.lockedBy ?? "null"}`
    );

    console.log("[DRep Lifecycle Sync] Triggered via API endpoint");
    res.status(202).json({ success: true, accepted: true, message: "DRep lifecycle sync started", jobName: JOB_NAME });

    (async () => {
      try {
        const result = await syncDrepLifecycleStep(prisma);
        const itemsProcessed = result.drepLifecycle?.eventsIngested ?? 0;

        await releaseJobLock(JOB_NAME, "success", itemsProcessed);

        console.log("[DRep Lifecycle Sync] Completed successfully:", {
          currentEpoch: result.currentEpoch, epochToSync: result.epochToSync, itemsProcessed, skipped: result.skipped,
        });
      } catch (error) {
        console.error("[DRep Lifecycle Sync] Async processing error:", formatAxiosLikeError(error));
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        try {
          await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
        } catch (updateError) {
          console.error("[DRep Lifecycle Sync] Failed to update sync status:", formatAxiosLikeError(updateError));
        }
      }
    })().catch((error) => { console.error("[DRep Lifecycle Sync] Unhandled error:", formatAxiosLikeError(error)); });
  } catch (error) {
    console.error("[DRep Lifecycle Sync] Setup error:", formatAxiosLikeError(error));
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (acquired) {
      try {
        await releaseJobLock(JOB_NAME, "failed", 0, errorMessage);
      } catch (updateError) {
        console.error("[DRep Lifecycle Sync] Failed to update sync status:", formatAxiosLikeError(updateError));
      }
    }
    res.status(500).json({ success: false, error: "Failed to start DRep lifecycle sync", message: errorMessage });
  }
};
