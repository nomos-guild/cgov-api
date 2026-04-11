/**
 * DRep Delegation Change Sync Cron Job
 *
 * Runs on a configurable schedule and syncs stake address delegation changes
 * to avoid storing per-epoch snapshot rows.
 */

import { prisma } from "../services";
import {
  DREP_DELEGATOR_SYNC_JOB_NAME,
  drepDelegatorBudgetUtcDay,
  isDrepDelegatorDailyBudgetExhausted,
  readDrepDelegatorDailyBudgetCursor,
  runDrepDelegatorSyncWithDailyRetry,
} from "../services/ingestion/drep-delegator-sync-run";
import { DREP_DELEGATOR_SYNC_LOCK_TTL_MS } from "../services/ingestion/sync-utils";
import { startIngestionCronJob } from "./runIngestionCronJob";

/**
 * Starts the DRep delegation change sync job.
 * Schedule is configurable via DREP_DELEGATOR_SYNC_SCHEDULE env variable.
 * Default is once daily at 03:15 UTC (heavy /drep_delegators work + daily UTC budget).
 */
export const startDrepDelegatorSyncJob = () =>
  startIngestionCronJob({
    jobName: DREP_DELEGATOR_SYNC_JOB_NAME,
    displayName: "DRep Delegator Sync",
    scheduleEnvKey: "DREP_DELEGATOR_SYNC_SCHEDULE",
    defaultSchedule: "15 3 * * *",
    lockOptions: {
      ttlMs: DREP_DELEGATOR_SYNC_LOCK_TTL_MS,
      source: "cron",
    },
    skipDbPressure: true,
    skipKoiosPressure: true,
    useKoiosHeavyLane: true,
    beforeAcquire: async () => {
      const cursor = await readDrepDelegatorDailyBudgetCursor();
      if (!isDrepDelegatorDailyBudgetExhausted(cursor)) {
        return true;
      }
      console.log(
        `[Cron] DRep Delegator Sync skipped: daily budget exhausted for UTC ${drepDelegatorBudgetUtcDay()}`
      );
      return false;
    },
    run: async () => {
      const cursorAfterLock = await readDrepDelegatorDailyBudgetCursor();
      if (isDrepDelegatorDailyBudgetExhausted(cursorAfterLock)) {
        console.log(
          `[Cron] DRep Delegator Sync skipped after lock: daily budget exhausted for UTC ${drepDelegatorBudgetUtcDay()}`
        );
        return { itemsProcessed: 0, lockResult: "success" };
      }

      console.log("  [DRep Delegation Sync] Starting delegation change sync...");
      const outcome = await runDrepDelegatorSyncWithDailyRetry(prisma);

      if (outcome.kind === "skipped") {
        const result = outcome.result;
        console.log(
          `  Delegations skipped: reason=${result.skipReason ?? "unknown"}`
        );
        return { itemsProcessed: 0, lockResult: "success" };
      }

      const result = outcome.result;
      console.log(
        `  Delegations: lastEpoch=${result.lastProcessedEpoch}, maxEpoch=${result.maxDelegationEpoch}, dreps=${result.drepsProcessed}, delegators=${result.delegatorsProcessed}, stateUpdates=${result.statesUpdated}, changes=${result.changesInserted}, failed=${result.failed.length}`
      );
      if (result.failed.length > 0) {
        console.error("  Delegations: first failures:", result.failed.slice(0, 10));
      }

      return {
        itemsProcessed: outcome.itemsProcessed,
        lockResult: outcome.lockResult,
      };
    },
  });
