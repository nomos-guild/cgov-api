/**
 * DRep Lifecycle Events Cron Job
 *
 * Syncs DRep registration, deregistration, and update events from Koios.
 * Fetches /drep_updates for every DRep — can be slow with many DReps.
 * Uses EpochAnalyticsSync checkpoint table to avoid duplicate work.
 */

import { prisma } from "../services";
import { syncDrepLifecycleStep } from "../services/ingestion/epoch-analytics.service";
import { DREP_LIFECYCLE_SYNC_LOCK_TTL_MS } from "../services/ingestion/sync-utils";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = "drep-lifecycle-sync";

export const startDrepLifecycleSyncJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "DRep Lifecycle Sync",
    scheduleEnvKey: "DREP_LIFECYCLE_SYNC_SCHEDULE",
    defaultSchedule: "37 * * * *",
    skipDbPressure: true,
    skipKoiosPressure: true,
    useKoiosHeavyLane: true,
    lockOptions: {
      ttlMs: DREP_LIFECYCLE_SYNC_LOCK_TTL_MS,
      source: "cron",
    },
    run: async () => {
      const result = await syncDrepLifecycleStep(prisma);
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] DRep lifecycle sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync})`
      );

      if (result.drepLifecycle) {
        const lc = result.drepLifecycle;
        console.log(
          `  Lifecycle: attempted=${lc.drepsAttempted}, processed=${lc.drepsProcessed}, noUpdates=${lc.drepsWithNoUpdates}, updatesFetched=${lc.totalUpdatesFetched}, events=${lc.eventsIngested} (reg=${lc.eventsByType.registration}, dereg=${lc.eventsByType.deregistration}, update=${lc.eventsByType.update}), failed=${lc.failed.length}`
        );
        if (lc.failed.length > 0) {
          console.error("  Lifecycle: first failures:", lc.failed.slice(0, 10));
        }
      } else {
        console.log(`  Lifecycle: skipped=${result.skipped}`);
      }

      return { itemsProcessed: result.drepLifecycle?.eventsIngested ?? 0 };
    },
  });
