import cron from "node-cron";
import { snapshotAllRepos } from "../services/ingestion/github-activity";
import {
  acquireJobLock,
  getBoundedIntEnv,
  releaseJobLock,
} from "../services/ingestion/syncLock";
import { shouldSkipForDbPressure } from "./dbPressureGuard";

let isSnapshotRunning = false;
const JOB_NAME = "github-snapshot-sync";
const DISPLAY_NAME = "GitHub Snapshot Sync";
const LOCK_TTL_MS = getBoundedIntEnv(
  "GITHUB_SNAPSHOT_LOCK_TTL_MS",
  45 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000
);

export const startSnapshotGithubJob = () => {
  const schedule = process.env.GITHUB_SNAPSHOT_SCHEDULE || "0 1 * * *"; // Daily at 1am UTC
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log("[Cron] GitHub snapshot job disabled via ENABLE_CRON_JOBS");
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(`[Cron] Invalid snapshot schedule: ${schedule}. Using default.`);
    return startWithSchedule("0 1 * * *");
  }

  startWithSchedule(schedule);
};

function startWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isSnapshotRunning) {
      console.log(`[${new Date().toISOString()}] GitHub snapshot still running. Skipping.`);
      return;
    }

    isSnapshotRunning = true;
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] Starting daily GitHub snapshot (all repos)...`);
    let acquired = false;

    try {
      if (shouldSkipForDbPressure("github-snapshot-sync")) {
        return;
      }
      acquired = await acquireJobLock(JOB_NAME, DISPLAY_NAME, {
        ttlMs: LOCK_TTL_MS,
        source: "cron",
      });
      if (!acquired) {
        console.log(
          `[${ts}] GitHub snapshot skipped because another instance already holds the DB lock.`
        );
        return;
      }

      const result = await snapshotAllRepos();

      console.log(
        `[${ts}] Snapshot complete:`,
        `\n  - Repos: ${result.success}/${result.total}`,
        `\n  - Failed: ${result.failed}`
      );

      if (result.errors.length > 0) {
        console.error(`[${ts}] Snapshot errors:`, result.errors.slice(0, 5));
      }
      await releaseJobLock(JOB_NAME, "success", result.success);
    } catch (error: any) {
      console.error(`[${ts}] GitHub snapshot job failed:`, error.message);
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
            `[${ts}] Failed to release GitHub snapshot lock:`,
            releaseError?.message ?? releaseError
          );
        }
      }
    } finally {
      isSnapshotRunning = false;
    }
  });

  console.log(`[Cron] GitHub daily snapshot job scheduled: ${schedule}`);
}
