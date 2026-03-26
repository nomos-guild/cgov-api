/**
 * Missing Epochs Backfill Cron Job
 *
 * Finds epochs missing from the EpochTotals table and backfills them
 * from Koios. Runs less frequently than other jobs since it's only needed
 * to fill gaps (e.g., after first deployment or if prior syncs failed).
 */

import { prisma } from "../services";
import { syncMissingEpochAnalytics } from "../services/ingestion/epoch-analytics.service";
import { getBoundedIntEnv } from "../services/ingestion/syncLock";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = "missing-epochs-sync";
const LOCK_TTL_MS = getBoundedIntEnv(
  "MISSING_EPOCHS_SYNC_LOCK_TTL_MS",
  30 * 60 * 1000,
  30_000,
  60 * 60 * 1000
);

export const startMissingEpochsSyncJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "Missing Epochs Backfill",
    scheduleEnvKey: "MISSING_EPOCHS_SYNC_SCHEDULE",
    defaultSchedule: "5 1,13 * * *",
    lockOptions: {
      ttlMs: LOCK_TTL_MS,
      source: "cron",
    },
    skipDbPressure: true,
    skipKoiosPressure: true,
    useKoiosHeavyLane: true,
    run: async () => {
      const backfill = await syncMissingEpochAnalytics(prisma);
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] Missing epochs backfill result:`);
      console.log(
        `  Range: ${backfill.startEpoch}-${backfill.endEpoch}, missing=${backfill.totals.missing.length}, synced=${backfill.totals.synced.length}, failed=${backfill.totals.failed.length}`
      );
      if (backfill.totals.failed.length > 0) {
        console.error("  First failures:", backfill.totals.failed.slice(0, 10));
      }

      return { itemsProcessed: backfill.totals.synced.length };
    },
  });
