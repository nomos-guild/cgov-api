/**
 * DRep Info Refresh Cron Job
 *
 * Refreshes ALL DReps' metadata from Koios /drep_info + /drep_updates.
 * This is the slowest analytics step — isolated to avoid timing out other work.
 * Uses EpochAnalyticsSync checkpoint table to avoid duplicate work.
 */

import cron from "node-cron";
import { prisma } from "../services";
import { syncDrepInfoStep } from "../services/ingestion/epoch-analytics.service";
import { applyCronJitter } from "./jitter";

let isRunning = false;

export const startDrepInfoSyncJob = () => {
  const schedule = process.env.DREP_INFO_SYNC_SCHEDULE || "22 * * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] DRep info sync job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: 22 * * * *`
    );
    return startDrepInfoSyncJobWithSchedule("22 * * * *");
  }

  startDrepInfoSyncJobWithSchedule(schedule);
};

function startDrepInfoSyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] DRep info sync job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isRunning = true;
    await applyCronJitter("[Cron] DRep info sync job");
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    console.log(`\n[${timestamp}] Starting DRep info sync job...`);

    try {
      const result = await syncDrepInfoStep(prisma);

      console.log(
        `[${timestamp}] DRep info sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync}):`
      );

      if (result.drepInfo) {
        console.log(
          `  DRep Info: total=${result.drepInfo.totalDreps}, updated=${result.drepInfo.updated}, failedBatches=${result.drepInfo.failedBatches}`
        );
      } else {
        console.log(`  DRep Info: skipped=${result.skipped}`);
      }
    } catch (error: any) {
      console.error(
        `[${timestamp}] DRep info sync job failed:`,
        error?.message ?? String(error)
      );
    } finally {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const finishedTimestamp = new Date().toISOString();
      console.log(
        `[${finishedTimestamp}] DRep info sync job finished (duration=${durationSeconds}s)`
      );
      isRunning = false;
    }
  });

  console.log(`[Cron] DRep info sync job scheduled with cron: ${schedule}`);
}
