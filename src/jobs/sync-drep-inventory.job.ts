/**
 * DRep Inventory + Snapshot Cron Job
 *
 * Inventories ALL DReps from Koios /drep_list into DB and creates
 * per-epoch snapshots of delegatorCount + votingPower.
 * Uses EpochAnalyticsSync checkpoint table to avoid duplicate work.
 */

import cron from "node-cron";
import { prisma } from "../services";
import { syncDrepInventoryStep } from "../services/ingestion/epoch-analytics.service";
import { acquireJobLock, releaseJobLock } from "../services/ingestion/syncLock";
import { shouldSkipForDbPressure } from "./dbPressureGuard";
import { applyCronJitter } from "./jitter";

let isRunning = false;
const JOB_NAME = "drep-inventory-sync";
const DISPLAY_NAME = "DRep Inventory Sync";

export const startDrepInventorySyncJob = () => {
  const schedule = process.env.DREP_INVENTORY_SYNC_SCHEDULE || "2 * * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] DRep inventory sync job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: 2 * * * *`
    );
    return startDrepInventorySyncJobWithSchedule("2 * * * *");
  }

  startDrepInventorySyncJobWithSchedule(schedule);
};

function startDrepInventorySyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] DRep inventory sync job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isRunning = true;
    await applyCronJitter("[Cron] DRep inventory sync job");
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    console.log(`\n[${timestamp}] Starting DRep inventory sync job...`);
    let acquired = false;

    try {
      if (shouldSkipForDbPressure("drep-inventory-sync")) {
        return;
      }
      acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
        source: "cron",
      });
      if (!acquired) {
        console.log(
          `[${timestamp}] DRep inventory sync skipped because another instance already holds the DB lock.`
        );
        return;
      }

      const result = await syncDrepInventoryStep(prisma);

      console.log(
        `[${timestamp}] DRep inventory sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync}):`
      );

      if (result.inventory) {
        console.log(
          `  Inventory: koios=${result.inventory.koiosTotal}, existing=${result.inventory.existingInDb}, created=${result.inventory.created}, updatedFromInfo=${result.inventory.updatedFromInfo}, failedInfoBatches=${result.inventory.failedInfoBatches}`
        );
      } else {
        console.log(`  Inventory: skipped=${result.skippedInventory}`);
      }

      if (result.snapshot) {
        console.log(
          `  Snapshot: epoch=${result.snapshot.epoch}, snapshotted=${result.snapshot.snapshotted}`
        );
      } else {
        console.log(`  Snapshot: skipped=${result.skippedSnapshot}`);
      }

      await releaseJobLock(
        JOB_NAME,
        "success",
        (result.inventory?.created ?? 0) + (result.snapshot?.snapshotted ?? 0)
      );
    } catch (error: any) {
      console.error(
        `[${timestamp}] DRep inventory sync job failed:`,
        error?.message ?? String(error)
      );
      if (acquired) {
        try {
          await releaseJobLock(
            JOB_NAME,
            "failed",
            0,
            error?.message ?? String(error)
          );
        } catch (releaseError: any) {
          console.error(
            `[${timestamp}] Failed to release DRep inventory sync lock:`,
            releaseError?.message ?? releaseError
          );
        }
      }
    } finally {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const finishedTimestamp = new Date().toISOString();
      console.log(
        `[${finishedTimestamp}] DRep inventory sync job finished (duration=${durationSeconds}s)`
      );
      isRunning = false;
    }
  });

  console.log(
    `[Cron] DRep inventory sync job scheduled with cron: ${schedule}`
  );
}
