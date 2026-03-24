/**
 * Epoch Totals Sync Cron Job
 *
 * Syncs epoch denominators (circulation, treasury, delegated DRep power,
 * pool voting power, special DRep aggregates) and timestamps for the
 * previous and current epochs.
 *
 * Previous epoch totals are checkpointed; current epoch totals always refresh.
 */

import cron from "node-cron";
import { prisma } from "../services";
import { syncEpochTotalsStep } from "../services/ingestion/epoch-analytics.service";
import { acquireJobLock, releaseJobLock } from "../services/ingestion/syncLock";
import { shouldSkipForDbPressure } from "./dbPressureGuard";
import { applyCronJitter } from "./jitter";

let isRunning = false;
const JOB_NAME = "epoch-totals-sync";
const DISPLAY_NAME = "Epoch Totals Sync";

export const startEpochTotalsSyncJob = () => {
  const schedule = process.env.EPOCH_TOTALS_SYNC_SCHEDULE || "42 * * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] Epoch totals sync job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: 42 * * * *`
    );
    return startEpochTotalsSyncJobWithSchedule("42 * * * *");
  }

  startEpochTotalsSyncJobWithSchedule(schedule);
};

function startEpochTotalsSyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] Epoch totals sync job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isRunning = true;
    await applyCronJitter("[Cron] Epoch totals sync job");
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    console.log(`\n[${timestamp}] Starting epoch totals sync job...`);
    let acquired = false;

    try {
      if (shouldSkipForDbPressure("epoch-totals-sync")) {
        return;
      }
      acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
        source: "cron",
      });
      if (!acquired) {
        console.log(
          `[${timestamp}] Epoch totals sync skipped because another instance already holds the DB lock.`
        );
        return;
      }

      const result = await syncEpochTotalsStep(prisma);

      console.log(
        `[${timestamp}] Epoch totals sync result (currentEpoch=${result.currentEpoch}, epochToSync=${result.epochToSync}):`
      );

      if (result.previousEpochTotals) {
        const prev = result.previousEpochTotals;
        console.log(
          `  Totals (previous epoch=${result.epochToSync}): upserted=${prev.upserted}, circulation=${prev.circulation?.toString() ?? "null"}, treasury=${prev.treasury?.toString() ?? "null"}, delegatedDrepPower=${prev.delegatedDrepPower?.toString() ?? "null"}, totalPoolVotePower=${prev.totalPoolVotePower?.toString() ?? "null"}`
        );
        console.log(
          `  Timestamps (previous epoch): startTime=${prev.startTime?.toISOString() ?? "null"}, endTime=${prev.endTime?.toISOString() ?? "null"}, blocks=${prev.blockCount ?? "null"}, txs=${prev.txCount ?? "null"}`
        );
      } else {
        console.log(
          `  Totals (previous epoch): skipped=${result.skippedPrevious}`
        );
      }

      const cur = result.currentEpochTotals;
      console.log(
        `  Totals (current epoch=${result.currentEpoch}): upserted=${cur.upserted}, circulation=${cur.circulation?.toString() ?? "null"}, treasury=${cur.treasury?.toString() ?? "null"}, delegatedDrepPower=${cur.delegatedDrepPower?.toString() ?? "null"}, totalPoolVotePower=${cur.totalPoolVotePower?.toString() ?? "null"}`
      );
      console.log(
        `  Timestamps (current epoch): startTime=${cur.startTime?.toISOString() ?? "null"}, endTime=${cur.endTime?.toISOString() ?? "null"}, blocks=${cur.blockCount ?? "null"}, txs=${cur.txCount ?? "null"}`
      );

      await releaseJobLock(
        JOB_NAME,
        "success",
        result.skippedPrevious ? 1 : 2
      );
    } catch (error: any) {
      console.error(
        `[${timestamp}] Epoch totals sync job failed:`,
        error?.message ?? String(error)
      );
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
            `[${timestamp}] Failed to release epoch totals sync lock:`,
            releaseError?.message ?? releaseError
          );
        }
      }
    } finally {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const finishedTimestamp = new Date().toISOString();
      console.log(
        `[${finishedTimestamp}] Epoch totals sync job finished (duration=${durationSeconds}s)`
      );
      isRunning = false;
    }
  });

  console.log(
    `[Cron] Epoch totals sync job scheduled with cron: ${schedule}`
  );
}
