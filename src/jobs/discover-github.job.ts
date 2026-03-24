import cron from "node-cron";
import { discoverRepositories } from "../services/ingestion/github-discovery";
import {
  acquireJobLock,
  getBoundedIntEnv,
  releaseJobLock,
} from "../services/ingestion/syncLock";
import { shouldSkipForDbPressure } from "./dbPressureGuard";

let isRunning = false;
const JOB_NAME = "github-discovery-sync";
const DISPLAY_NAME = "GitHub Discovery Sync";
const LOCK_TTL_MS = getBoundedIntEnv(
  "GITHUB_DISCOVERY_LOCK_TTL_MS",
  30 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000
);

export const startDiscoverGithubJob = () => {
  const schedule = process.env.GITHUB_DISCOVERY_SCHEDULE || "0 3 * * 0"; // Weekly Sunday 3am
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log("[Cron] GitHub discovery job disabled via ENABLE_CRON_JOBS");
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(`[Cron] Invalid discovery schedule: ${schedule}. Using default.`);
    return startWithSchedule("0 3 * * 0");
  }

  startWithSchedule(schedule);
};

function startWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isRunning) {
      console.log(`[${new Date().toISOString()}] GitHub discovery still running. Skipping.`);
      return;
    }

    isRunning = true;
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] Starting GitHub discovery job...`);
    let acquired = false;

    try {
      if (shouldSkipForDbPressure("github-discovery-sync")) {
        return;
      }
      acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
        ttlMs: LOCK_TTL_MS,
        source: "cron",
      });
      if (!acquired) {
        console.log(
          `[${ts}] GitHub discovery skipped because another instance already holds the DB lock.`
        );
        return;
      }

      const results = await discoverRepositories();
      console.log(
        `[${ts}] Discovery completed:`,
        `\n  - Total: ${results.total}`,
        `\n  - New: ${results.newRepos}`,
        `\n  - Updated: ${results.updatedRepos}`,
        `\n  - Errors: ${results.errors.length}`
      );
      if (results.errors.length > 0) {
        console.error(`[${ts}] Discovery errors:`, results.errors);
      }
      await releaseJobLock(
        JOB_NAME,
        "success",
        results.newRepos + results.updatedRepos
      );
    } catch (error: any) {
      console.error(`[${ts}] GitHub discovery job failed:`, error.message);
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
            `[${ts}] Failed to release GitHub discovery lock:`,
            releaseError?.message ?? releaseError
          );
        }
      }
    } finally {
      isRunning = false;
    }
  });

  console.log(`[Cron] GitHub discovery job scheduled: ${schedule}`);
}

export { discoverRepositories };
