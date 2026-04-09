import { backfillRepositories } from "../services/ingestion/github-backfill";
import { getBoundedIntEnv } from "../services/ingestion/syncLock";
import { GITHUB_LOCK_KEYS } from "../services/ingestion/githubLockKeys";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = GITHUB_LOCK_KEYS.backfill;
const LOCK_TTL_MS = getBoundedIntEnv(
  "GITHUB_BACKFILL_LOCK_TTL_MS",
  45 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000
);

export const startBackfillGithubJob = () => {
  const batchSize = parseInt(process.env.GITHUB_BACKFILL_BATCH_SIZE || "10", 10);

  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "GitHub Backfill Sync",
    scheduleEnvKey: "GITHUB_BACKFILL_SCHEDULE",
    defaultSchedule: "15 * * * *",
    skipDbPressure: true,
    lockOptions: { ttlMs: LOCK_TTL_MS, source: "cron" },
    run: async () => {
      const ts = new Date().toISOString();
      const result = await backfillRepositories({ limit: batchSize, minStars: 0 });
      console.log(
        `[${ts}] Backfill batch complete: processed=${result.success}/${result.total} failed=${result.failed} skipped=${result.skipped}`
      );
      if (result.errors.length > 0) {
        console.error(`[${ts}] Backfill errors:`, result.errors.slice(0, 5));
      }
      if (result.total === 0) {
        console.log(
          `[${ts}] All repositories have been backfilled. Job will continue checking on schedule.`
        );
      }
      return { itemsProcessed: result.success };
    },
  });
};
