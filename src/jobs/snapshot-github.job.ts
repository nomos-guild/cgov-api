import { snapshotAllRepos } from "../services/ingestion/github-activity";
import { getBoundedIntEnv } from "../services/ingestion/syncLock";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = "github-snapshot-sync";
const LOCK_TTL_MS = getBoundedIntEnv(
  "GITHUB_SNAPSHOT_LOCK_TTL_MS",
  45 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000
);

export const startSnapshotGithubJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "GitHub Snapshot Sync",
    scheduleEnvKey: "GITHUB_SNAPSHOT_SCHEDULE",
    defaultSchedule: "0 1 * * *",
    skipDbPressure: true,
    lockOptions: { ttlMs: LOCK_TTL_MS, source: "cron" },
    run: async () => {
      const ts = new Date().toISOString();
      const result = await snapshotAllRepos();
      console.log(
        `[${ts}] Snapshot complete: repos=${result.success}/${result.total} failed=${result.failed}`
      );
      if (result.errors.length > 0) {
        console.error(`[${ts}] Snapshot errors:`, result.errors.slice(0, 5));
      }
      return { itemsProcessed: result.success };
    },
  });
