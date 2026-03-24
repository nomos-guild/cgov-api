import cron from "node-cron";
import { backfillRepositories } from "../services/ingestion/github-backfill";
import {
  acquireJobLock,
  getBoundedIntEnv,
  releaseJobLock,
} from "../services/ingestion/syncLock";
import { shouldSkipForDbPressure } from "./dbPressureGuard";

let isBackfillRunning = false;
const JOB_NAME = "github-backfill-sync";
const DISPLAY_NAME = "GitHub Backfill Sync";
const LOCK_TTL_MS = getBoundedIntEnv(
  "GITHUB_BACKFILL_LOCK_TTL_MS",
  45 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000
);

export const startBackfillGithubJob = () => {
  const schedule = process.env.GITHUB_BACKFILL_SCHEDULE || "15 * * * *"; // At minute 15 (between syncs at :00 and :30)
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";
  const batchSize = parseInt(process.env.GITHUB_BACKFILL_BATCH_SIZE || "10", 10);

  if (!enabled) {
    console.log("[Cron] GitHub backfill job disabled via ENABLE_CRON_JOBS");
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(`[Cron] Invalid backfill schedule: ${schedule}. Using default.`);
    return startWithSchedule("15 * * * *", batchSize);
  }

  startWithSchedule(schedule, batchSize);
};

function startWithSchedule(schedule: string, batchSize: number) {
  cron.schedule(schedule, async () => {
    if (isBackfillRunning) {
      console.log(`[${new Date().toISOString()}] GitHub backfill still running. Skipping.`);
      return;
    }

    isBackfillRunning = true;
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] Starting GitHub backfill batch (limit: ${batchSize})...`);
    let acquired = false;

    try {
      if (shouldSkipForDbPressure("github-backfill-sync")) {
        return;
      }
      acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
        ttlMs: LOCK_TTL_MS,
        source: "cron",
      });
      if (!acquired) {
        console.log(
          `[${ts}] GitHub backfill skipped because another instance already holds the DB lock.`
        );
        return;
      }

      const result = await backfillRepositories({ limit: batchSize, minStars: 0 });

      console.log(
        `[${ts}] Backfill batch complete:`,
        `\n  - Processed: ${result.success}/${result.total}`,
        `\n  - Failed: ${result.failed}`,
        `\n  - Skipped: ${result.skipped}`
      );

      if (result.errors.length > 0) {
        console.error(`[${ts}] Backfill errors:`, result.errors.slice(0, 5));
      }

      // If no repos were found to backfill, everything is done
      if (result.total === 0) {
        console.log(`[${ts}] All repositories have been backfilled. Job will continue checking on schedule.`);
      }
      await releaseJobLock(JOB_NAME, "success", result.success);
    } catch (error: any) {
      console.error(`[${ts}] GitHub backfill job failed:`, error.message);
      if (acquired) {
        try {
          await releaseJobLock(
            JOB_NAME,
            "failed",
            0,
            error?.message ?? "Unknown error"
          );
        } catch (releaseError: any) {
          console.error(
            `[${ts}] Failed to release GitHub backfill lock:`,
            releaseError?.message ?? releaseError
          );
        }
      }
    } finally {
      isBackfillRunning = false;
    }
  });

  console.log(`[Cron] GitHub backfill job scheduled: ${schedule} (batch size: ${batchSize})`);
}
