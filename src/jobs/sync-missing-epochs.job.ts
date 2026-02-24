/**
 * Missing Epochs Backfill Cron Job
 *
 * Finds epochs missing from the EpochTotals table and backfills them
 * from Koios. Runs less frequently than other jobs since it's only needed
 * to fill gaps (e.g., after first deployment or if prior syncs failed).
 */

import cron from "node-cron";
import { prisma } from "../services";
import { syncMissingEpochAnalytics } from "../services/ingestion/epoch-analytics.service";

let isRunning = false;

export const startMissingEpochsSyncJob = () => {
  const schedule = process.env.MISSING_EPOCHS_SYNC_SCHEDULE || "33 */6 * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] Missing epochs backfill job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: 33 */6 * * *`
    );
    return startMissingEpochsSyncJobWithSchedule("33 */6 * * *");
  }

  startMissingEpochsSyncJobWithSchedule(schedule);
};

function startMissingEpochsSyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] Missing epochs backfill job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isRunning = true;
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    console.log(`\n[${timestamp}] Starting missing epochs backfill job...`);

    try {
      const backfill = await syncMissingEpochAnalytics(prisma);

      console.log(
        `[${timestamp}] Missing epochs backfill result:`
      );
      console.log(
        `  Range: ${backfill.startEpoch}-${backfill.endEpoch}, missing=${backfill.totals.missing.length}, synced=${backfill.totals.synced.length}, failed=${backfill.totals.failed.length}`
      );
      if (backfill.totals.failed.length > 0) {
        console.error(
          `  First failures:`,
          backfill.totals.failed.slice(0, 10)
        );
      }
    } catch (error: any) {
      console.error(
        `[${timestamp}] Missing epochs backfill job failed:`,
        error?.message ?? String(error)
      );
    } finally {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const finishedTimestamp = new Date().toISOString();
      console.log(
        `[${finishedTimestamp}] Missing epochs backfill job finished (duration=${durationSeconds}s)`
      );
      isRunning = false;
    }
  });

  console.log(
    `[Cron] Missing epochs backfill job scheduled with cron: ${schedule}`
  );
}
