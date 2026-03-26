/**
 * Epoch Totals Sync Cron Job
 *
 * Syncs epoch denominators (circulation, treasury, delegated DRep power,
 * pool voting power, special DRep aggregates) and timestamps for the
 * previous and current epochs.
 *
 * Previous epoch totals are checkpointed; current epoch totals always refresh.
 */

import { prisma } from "../services";
import { syncEpochTotalsStep } from "../services/ingestion/epoch-analytics.service";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = "epoch-totals-sync";

export const startEpochTotalsSyncJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "Epoch Totals Sync",
    scheduleEnvKey: "EPOCH_TOTALS_SYNC_SCHEDULE",
    defaultSchedule: "42 * * * *",
    skipDbPressure: true,
    skipKoiosPressure: true,
    useKoiosHeavyLane: true,
    run: async () => {
      const result = await syncEpochTotalsStep(prisma);
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] Epoch totals sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync})`
      );

      if (result.previousEpochTotals) {
        const prev = result.previousEpochTotals;
        console.log(
          `  Totals (previous epoch=${result.epochToSync}): upserted=${prev.upserted}, circulation=${prev.circulation?.toString() ?? "null"}, treasury=${prev.treasury?.toString() ?? "null"}, delegatedDrepPower=${prev.delegatedDrepPower?.toString() ?? "null"}, totalPoolVotePower=${prev.totalPoolVotePower?.toString() ?? "null"}`
        );
      }
      const cur = result.currentEpochTotals;
      console.log(
        `  Totals (current epoch=${result.currentEpoch}): upserted=${cur.upserted}, circulation=${cur.circulation?.toString() ?? "null"}, treasury=${cur.treasury?.toString() ?? "null"}, delegatedDrepPower=${cur.delegatedDrepPower?.toString() ?? "null"}, totalPoolVotePower=${cur.totalPoolVotePower?.toString() ?? "null"}`
      );

      return { itemsProcessed: result.skippedPrevious ? 1 : 2 };
    },
  });
