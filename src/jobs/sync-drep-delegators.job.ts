/**
 * DRep Delegation Change Sync Cron Job
 *
 * Runs on a configurable schedule and syncs stake address delegation changes
 * to avoid storing per-epoch snapshot rows.
 */

import cron from "node-cron";
import { prisma } from "../services";
import { syncDrepDelegationChanges } from "../services/ingestion/epoch-analytics.service";

// Simple in-process guard to prevent overlapping runs in a single Node process
let isDrepDelegatorSyncRunning = false;

/**
 * Starts the DRep delegation change sync job.
 * Schedule is configurable via DREP_DELEGATOR_SYNC_SCHEDULE env variable
 * Defaults to every hour at minute 40
 */
export const startDrepDelegatorSyncJob = () => {
  const schedule = process.env.DREP_DELEGATOR_SYNC_SCHEDULE || "40 * * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] DRep delegation change sync job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  // Validate cron schedule
  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: 40 * * * *`
    );
    return startDrepDelegatorSyncJobWithSchedule("40 * * * *");
  }

  startDrepDelegatorSyncJobWithSchedule(schedule);
};

function startDrepDelegatorSyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isDrepDelegatorSyncRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] DRep delegation change sync job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isDrepDelegatorSyncRunning = true;
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    console.log(`\n[${timestamp}] Starting DRep delegation change sync job...`);

    try {
      console.log(`  [DRep Delegation Sync] Starting delegation change sync...`);
      const result = await syncDrepDelegationChanges(prisma);
      console.log(
        `  Delegations: lastEpoch=${result.lastProcessedEpoch}, maxEpoch=${result.maxDelegationEpoch}, dreps=${result.drepsProcessed}, delegators=${result.delegatorsProcessed}, stateUpdates=${result.statesUpdated}, changes=${result.changesInserted}, failed=${result.failed.length}`
      );
      if (result.failed.length > 0) {
        console.error(
          `  Delegations: first failures:`,
          result.failed.slice(0, 10)
        );
      }
    } catch (error: any) {
      console.error(
        `[${timestamp}] DRep delegation change sync job failed:`,
        error?.message ?? String(error)
      );
    } finally {
      const finishedAt = Date.now();
      const durationSeconds = ((finishedAt - startedAt) / 1000).toFixed(1);
      const finishedTimestamp = new Date().toISOString();
      console.log(
        `[${finishedTimestamp}] DRep delegation change sync job finished (duration=${durationSeconds}s)`
      );
      isDrepDelegatorSyncRunning = false;
    }
  });

  console.log(
    `[Cron] DRep delegation change sync job scheduled with cron: ${schedule}`
  );
}
