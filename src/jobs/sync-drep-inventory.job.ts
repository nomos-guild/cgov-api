/**
 * DRep Inventory + Snapshot Cron Job
 *
 * Inventories ALL DReps from Koios /drep_list into DB and creates
 * per-epoch snapshots of delegatorCount + votingPower.
 * Uses EpochAnalyticsSync checkpoint table to avoid duplicate work.
 */

import { prisma } from "../services";
import { syncDrepInventoryStep } from "../services/ingestion/epoch-analytics.service";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = "drep-inventory-sync";

export const startDrepInventorySyncJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "DRep Inventory Sync",
    scheduleEnvKey: "DREP_INVENTORY_SYNC_SCHEDULE",
    defaultSchedule: "2 * * * *",
    skipDbPressure: true,
    skipKoiosPressure: true,
    useKoiosHeavyLane: true,
    run: async () => {
      const result = await syncDrepInventoryStep(prisma);
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] DRep inventory sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync})`
      );
      if (result.inventory) {
        console.log(
          `  Inventory: koios=${result.inventory.koiosTotal}, existing=${result.inventory.existingInDb}, created=${result.inventory.created}, updatedFromInfo=${result.inventory.updatedFromInfo}, failedInfoBatches=${result.inventory.failedInfoBatches}`
        );
      }
      if (result.snapshot) {
        console.log(
          `  Snapshot: epoch=${result.snapshot.epoch}, snapshotted=${result.snapshot.snapshotted}`
        );
      }
      return {
        itemsProcessed:
          (result.inventory?.created ?? 0) + (result.snapshot?.snapshotted ?? 0),
      };
    },
  });
