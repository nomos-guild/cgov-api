/**
 * DRep Info Refresh Cron Job
 *
 * Refreshes ALL DReps' metadata from Koios /drep_info + /drep_updates.
 * This is the slowest analytics step — isolated to avoid timing out other work.
 * Uses EpochAnalyticsSync checkpoint table to avoid duplicate work.
 */

import { prisma } from "../services";
import { syncDrepInfoStep } from "../services/ingestion/epoch-analytics.service";
import { getBoundedIntEnv } from "../services/ingestion/syncLock";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = "drep-info-sync";
const LOCK_TTL_MS = getBoundedIntEnv(
  "DREP_INFO_SYNC_LOCK_TTL_MS",
  20 * 60 * 1000,
  30_000,
  60 * 60 * 1000
);

export const startDrepInfoSyncJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "DRep Info Sync",
    scheduleEnvKey: "DREP_INFO_SYNC_SCHEDULE",
    defaultSchedule: "22 * * * *",
    skipDbPressure: true,
    skipKoiosPressure: true,
    useKoiosHeavyLane: true,
    lockOptions: {
      ttlMs: LOCK_TTL_MS,
      source: "cron",
    },
    run: async () => {
      const result = await syncDrepInfoStep(prisma);
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] DRep info sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync})`
      );
      if (result.drepInfo) {
        console.log(
          `  DRep Info: total=${result.drepInfo.totalDreps}, updated=${result.drepInfo.updated}, failedBatches=${result.drepInfo.failedBatches}`
        );
      } else {
        console.log(`  DRep Info: skipped=${result.skipped}`);
      }
      return { itemsProcessed: result.drepInfo?.updated ?? 0 };
    },
  });
