/**
 * DRep Lifecycle Events Cron Job
 *
 * Syncs DRep registration, deregistration, and update events from Koios.
 * Fetches /drep_updates for every DRep — can be slow with many DReps.
 * Uses EpochAnalyticsSync checkpoint table to avoid duplicate work.
 */

import cron from "node-cron";
import { prisma } from "../services";
import { syncDrepLifecycleStep } from "../services/ingestion/epoch-analytics.service";

let isRunning = false;

export const startDrepLifecycleSyncJob = () => {
  const schedule = process.env.DREP_LIFECYCLE_SYNC_SCHEDULE || "37 * * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] DRep lifecycle sync job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: 37 * * * *`
    );
    return startDrepLifecycleSyncJobWithSchedule("37 * * * *");
  }

  startDrepLifecycleSyncJobWithSchedule(schedule);
};

function startDrepLifecycleSyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] DRep lifecycle sync job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isRunning = true;
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    console.log(`\n[${timestamp}] Starting DRep lifecycle sync job...`);

    try {
      const result = await syncDrepLifecycleStep(prisma);

      console.log(
        `[${timestamp}] DRep lifecycle sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync}):`
      );

      if (result.drepLifecycle) {
        const lc = result.drepLifecycle;
        console.log(
          `  Lifecycle: attempted=${lc.drepsAttempted}, processed=${lc.drepsProcessed}, ` +
          `noUpdates=${lc.drepsWithNoUpdates}, updatesFetched=${lc.totalUpdatesFetched}, ` +
          `events=${lc.eventsIngested} (reg=${lc.eventsByType.registration}, ` +
          `dereg=${lc.eventsByType.deregistration}, update=${lc.eventsByType.update}), ` +
          `failed=${lc.failed.length}`
        );
        if (lc.failed.length > 0) {
          console.error(
            `  Lifecycle: first failures:`,
            lc.failed.slice(0, 10)
          );
        }
      } else {
        console.log(`  Lifecycle: skipped=${result.skipped}`);
      }
    } catch (error: any) {
      console.error(
        `[${timestamp}] DRep lifecycle sync job failed:`,
        error?.message ?? String(error)
      );
    } finally {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const finishedTimestamp = new Date().toISOString();
      console.log(
        `[${finishedTimestamp}] DRep lifecycle sync job finished (duration=${durationSeconds}s)`
      );
      isRunning = false;
    }
  });

  console.log(
    `[Cron] DRep lifecycle sync job scheduled with cron: ${schedule}`
  );
}
