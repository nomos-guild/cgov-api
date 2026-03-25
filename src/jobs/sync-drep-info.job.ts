/**
 * DRep Info Refresh Cron Job
 *
 * Refreshes ALL DReps' metadata from Koios /drep_info + /drep_updates.
 * This is the slowest analytics step — isolated to avoid timing out other work.
 * Uses EpochAnalyticsSync checkpoint table to avoid duplicate work.
 */

import cron from "node-cron";
import { prisma } from "../services";
import { syncDrepInfoStep } from "../services/ingestion/epoch-analytics.service";
import {
  acquireJobLock,
  getBoundedIntEnv,
  releaseJobLock,
} from "../services/ingestion/syncLock";
import { shouldSkipForDbPressure } from "./dbPressureGuard";
import {
  acquireKoiosHeavyJobLane,
  releaseKoiosHeavyJobLane,
  shouldSkipForKoiosPressure,
} from "./koiosPressureGuard";
import { applyCronJitter } from "./jitter";

let isRunning = false;
const JOB_NAME = "drep-info-sync";
const DISPLAY_NAME = "DRep Info Sync";
const LOCK_TTL_MS = getBoundedIntEnv(
  "DREP_INFO_SYNC_LOCK_TTL_MS",
  20 * 60 * 1000,
  30_000,
  60 * 60 * 1000
);

export const startDrepInfoSyncJob = () => {
  const schedule = process.env.DREP_INFO_SYNC_SCHEDULE || "22 * * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] DRep info sync job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: 22 * * * *`
    );
    return startDrepInfoSyncJobWithSchedule("22 * * * *");
  }

  startDrepInfoSyncJobWithSchedule(schedule);
};

function startDrepInfoSyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] DRep info sync job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isRunning = true;
    await applyCronJitter("[Cron] DRep info sync job");
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    console.log(`\n[${timestamp}] Starting DRep info sync job...`);
    let acquired = false;
    let laneAcquired = false;

    try {
      if (shouldSkipForDbPressure("drep-info-sync")) {
        return;
      }
      if (shouldSkipForKoiosPressure("drep-info-sync")) {
        return;
      }
      acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
        ttlMs: LOCK_TTL_MS,
        source: "cron",
      });
      if (!acquired) {
        console.log(
          `[${timestamp}] DRep info sync skipped because another instance already holds the DB lock.`
        );
        return;
      }
      laneAcquired = await acquireKoiosHeavyJobLane(JOB_NAME);
      if (!laneAcquired) {
        console.log(
          `[${timestamp}] DRep info sync skipped because Koios heavy lane is busy.`
        );
        await releaseJobLock(JOB_NAME, "success", 0);
        acquired = false;
        return;
      }

      const result = await syncDrepInfoStep(prisma);

      console.log(
        `[${timestamp}] DRep info sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync}):`
      );

      if (result.drepInfo) {
        console.log(
          `  DRep Info: total=${result.drepInfo.totalDreps}, updated=${result.drepInfo.updated}, failedBatches=${result.drepInfo.failedBatches}`
        );
      } else {
        console.log(`  DRep Info: skipped=${result.skipped}`);
      }

      await releaseJobLock(
        JOB_NAME,
        "success",
        result.drepInfo?.updated ?? 0
      );
      if (laneAcquired) {
        await releaseKoiosHeavyJobLane("success");
        laneAcquired = false;
      }
    } catch (error: any) {
      console.error(
        `[${timestamp}] DRep info sync job failed:`,
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
            `[${timestamp}] Failed to release DRep info sync lock:`,
            releaseError?.message ?? releaseError
          );
        }
      }
    } finally {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const finishedTimestamp = new Date().toISOString();
      console.log(
        `[${finishedTimestamp}] DRep info sync job finished (duration=${durationSeconds}s)`
      );
      isRunning = false;
    }
  });

  console.log(`[Cron] DRep info sync job scheduled with cron: ${schedule}`);
}
