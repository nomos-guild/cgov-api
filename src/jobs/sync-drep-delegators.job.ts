/**
 * DRep Delegation Change Sync Cron Job
 *
 * Runs on a configurable schedule and syncs stake address delegation changes
 * to avoid storing per-epoch snapshot rows.
 */

import { prisma } from "../services";
import { syncDrepDelegationChanges } from "../services/ingestion/epoch-analytics.service";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = "drep-delegator-sync";
const LOCK_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours — full sync (Phase 1+2+3) must complete within this window

/**
 * Starts the DRep delegation change sync job.
 * Schedule is configurable via DREP_DELEGATOR_SYNC_SCHEDULE env variable
 * Defaults to every hour at minute 52
 */
export const startDrepDelegatorSyncJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "DRep Delegator Sync",
    scheduleEnvKey: "DREP_DELEGATOR_SYNC_SCHEDULE",
    defaultSchedule: "52 * * * *",
    lockOptions: {
      ttlMs: LOCK_TTL_MS,
      source: "cron",
    },
    skipDbPressure: true,
    skipKoiosPressure: true,
    useKoiosHeavyLane: true,
    run: async () => {
      console.log("  [DRep Delegation Sync] Starting delegation change sync...");
      const result = await syncDrepDelegationChanges(prisma);
      console.log(
        `  Delegations: lastEpoch=${result.lastProcessedEpoch}, maxEpoch=${result.maxDelegationEpoch}, dreps=${result.drepsProcessed}, delegators=${result.delegatorsProcessed}, stateUpdates=${result.statesUpdated}, changes=${result.changesInserted}, failed=${result.failed.length}`
      );
      if (result.failed.length > 0) {
        console.error("  Delegations: first failures:", result.failed.slice(0, 10));
      }
      return {
        itemsProcessed: result.statesUpdated + result.changesInserted,
      };
    },
  });
