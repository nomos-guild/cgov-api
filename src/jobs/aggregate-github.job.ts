import cron from "node-cron";
import {
  aggregateRecentToHistorical,
  precomputeNetworkGraphs,
} from "../services/ingestion/github-aggregation";
import {
  acquireJobLock,
  getBoundedIntEnv,
  releaseJobLock,
} from "../services/ingestion/syncLock";
import { shouldSkipForDbPressure } from "./dbPressureGuard";

let isRunning = false;
const JOB_NAME = "github-aggregation-sync";
const DISPLAY_NAME = "GitHub Aggregation Sync";
const LOCK_TTL_MS = getBoundedIntEnv(
  "GITHUB_AGGREGATION_LOCK_TTL_MS",
  30 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000
);

export const startAggregateGithubJob = () => {
  const schedule = process.env.GITHUB_AGGREGATION_SCHEDULE || "0 4 * * *"; // Daily 4am UTC
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log("[Cron] GitHub aggregation job disabled via ENABLE_CRON_JOBS");
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(`[Cron] Invalid aggregation schedule: ${schedule}. Using default.`);
    return startWithSchedule("0 4 * * *");
  }

  startWithSchedule(schedule);
};

function startWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isRunning) {
      console.log(`[${new Date().toISOString()}] GitHub aggregation still running. Skipping.`);
      return;
    }

    isRunning = true;
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] Starting GitHub aggregation job...`);
    let acquired = false;

    try {
      if (shouldSkipForDbPressure("github-aggregation-sync")) {
        return;
      }
      acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
        ttlMs: LOCK_TTL_MS,
        source: "cron",
      });
      if (!acquired) {
        console.log(
          `[${ts}] GitHub aggregation skipped because another instance already holds the DB lock.`
        );
        return;
      }

      const result = await aggregateRecentToHistorical();
      console.log(
        `[${ts}] Aggregation completed:`,
        `\n  - Days rolled up: ${result.daysRolledUp}`,
        `\n  - Rows deleted: ${result.rowsDeleted}`,
        `\n  - Developers updated: ${result.developersUpdated}`
      );

      await precomputeNetworkGraphs();
      await releaseJobLock(
        JOB_NAME,
        "success",
        result.daysRolledUp + result.developersUpdated
      );
    } catch (error: any) {
      console.error(`[${ts}] GitHub aggregation job failed:`, error.message);
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
            `[${ts}] Failed to release GitHub aggregation lock:`,
            releaseError?.message ?? releaseError
          );
        }
      }
    } finally {
      isRunning = false;
    }
  });

  console.log(`[Cron] GitHub aggregation job scheduled: ${schedule}`);
}
