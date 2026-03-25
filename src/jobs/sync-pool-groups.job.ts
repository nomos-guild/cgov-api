/**
 * Pool Groups Sync Cron Job
 *
 * Syncs multi-pool operator groupings from Koios /pool_groups.
 * Uses EpochAnalyticsSync checkpoint table to avoid duplicate work.
 */

import cron from "node-cron";
import { prisma } from "../services";
import { syncPoolGroupsStep } from "../services/ingestion/epoch-analytics.service";
import { acquireJobLock, releaseJobLock } from "../services/ingestion/syncLock";
import { shouldSkipForDbPressure } from "./dbPressureGuard";
import {
  acquireKoiosHeavyJobLane,
  releaseKoiosHeavyJobLane,
  shouldSkipForKoiosPressure,
} from "./koiosPressureGuard";
import { applyCronJitter } from "./jitter";

let isRunning = false;
const JOB_NAME = "pool-groups-sync";
const DISPLAY_NAME = "Pool Groups Sync";

export const startPoolGroupsSyncJob = () => {
  const schedule = process.env.POOL_GROUPS_SYNC_SCHEDULE || "47 * * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] Pool groups sync job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: 47 * * * *`
    );
    return startPoolGroupsSyncJobWithSchedule("47 * * * *");
  }

  startPoolGroupsSyncJobWithSchedule(schedule);
};

function startPoolGroupsSyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] Pool groups sync job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isRunning = true;
    await applyCronJitter("[Cron] Pool groups sync job");
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    console.log(`\n[${timestamp}] Starting pool groups sync job...`);
    let acquired = false;
    let laneAcquired = false;

    try {
      if (shouldSkipForDbPressure("pool-groups-sync")) {
        return;
      }
      if (shouldSkipForKoiosPressure("pool-groups-sync")) {
        return;
      }
      acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
        source: "cron",
      });
      if (!acquired) {
        console.log(
          `[${timestamp}] Pool groups sync skipped because another instance already holds the DB lock.`
        );
        return;
      }
      laneAcquired = await acquireKoiosHeavyJobLane(JOB_NAME);
      if (!laneAcquired) {
        console.log(
          `[${timestamp}] Pool groups sync skipped because Koios heavy lane is busy.`
        );
        await releaseJobLock(JOB_NAME, "success", 0);
        acquired = false;
        return;
      }

      const result = await syncPoolGroupsStep(prisma);

      console.log(
        `[${timestamp}] Pool groups sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync}):`
      );

      if (result.poolGroups) {
        console.log(
          `  Pool Groups: fetched=${result.poolGroups.totalFetched}, created=${result.poolGroups.created}, updated=${result.poolGroups.updated}, uniqueGroups=${result.poolGroups.uniqueGroups}`
        );
      } else {
        console.log(`  Pool Groups: skipped=${result.skipped}`);
      }

      await releaseJobLock(
        JOB_NAME,
        "success",
        (result.poolGroups?.created ?? 0) + (result.poolGroups?.updated ?? 0)
      );
      if (laneAcquired) {
        await releaseKoiosHeavyJobLane("success");
        laneAcquired = false;
      }
    } catch (error: any) {
      console.error(
        `[${timestamp}] Pool groups sync job failed:`,
        error?.message ?? String(error)
      );
      if (laneAcquired) {
        try {
          await releaseKoiosHeavyJobLane(
            "failed",
            error?.message ?? String(error)
          );
          laneAcquired = false;
        } catch (laneError: any) {
          console.error(
            `[${timestamp}] Failed to release Koios heavy lane lock:`,
            laneError?.message ?? laneError
          );
        }
      }
      if (acquired) {
        try {
          await releaseJobLock(
            JOB_NAME,
            "failed",
            0,
            error?.message ?? String(error)
          );
        } catch (releaseError: any) {
          console.error(
            `[${timestamp}] Failed to release pool groups sync lock:`,
            releaseError?.message ?? releaseError
          );
        }
      }
    } finally {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const finishedTimestamp = new Date().toISOString();
      console.log(
        `[${finishedTimestamp}] Pool groups sync job finished (duration=${durationSeconds}s)`
      );
      isRunning = false;
    }
  });

  console.log(
    `[Cron] Pool groups sync job scheduled with cron: ${schedule}`
  );
}
