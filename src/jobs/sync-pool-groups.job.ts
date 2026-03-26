/**
 * Pool Groups Sync Cron Job
 *
 * Syncs multi-pool operator groupings from Koios /pool_groups.
 * Uses EpochAnalyticsSync checkpoint table to avoid duplicate work.
 */

import { prisma } from "../services";
import { syncPoolGroupsStep } from "../services/ingestion/epoch-analytics.service";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = "pool-groups-sync";

export const startPoolGroupsSyncJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "Pool Groups Sync",
    scheduleEnvKey: "POOL_GROUPS_SYNC_SCHEDULE",
    defaultSchedule: "47 * * * *",
    skipDbPressure: true,
    skipKoiosPressure: true,
    useKoiosHeavyLane: true,
    run: async () => {
      const result = await syncPoolGroupsStep(prisma);
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] Pool groups sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync})`
      );

      if (result.poolGroups) {
        console.log(
          `  Pool Groups: fetched=${result.poolGroups.totalFetched}, created=${result.poolGroups.created}, updated=${result.poolGroups.updated}, uniqueGroups=${result.poolGroups.uniqueGroups}`
        );
      } else {
        console.log(`  Pool Groups: skipped=${result.skipped}`);
      }

      return {
        itemsProcessed:
          (result.poolGroups?.created ?? 0) + (result.poolGroups?.updated ?? 0),
      };
    },
  });
