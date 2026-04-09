import { discoverRepositories } from "../services/ingestion/github-discovery";
import { getBoundedIntEnv } from "../services/ingestion/syncLock";
import { GITHUB_LOCK_KEYS } from "../services/ingestion/githubLockKeys";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = GITHUB_LOCK_KEYS.discovery;
const LOCK_TTL_MS = getBoundedIntEnv(
  "GITHUB_DISCOVERY_LOCK_TTL_MS",
  30 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000
);

export const startDiscoverGithubJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "GitHub Discovery Sync",
    scheduleEnvKey: "GITHUB_DISCOVERY_SCHEDULE",
    defaultSchedule: "0 3 * * 0",
    skipDbPressure: true,
    lockOptions: { ttlMs: LOCK_TTL_MS, source: "cron" },
    run: async () => {
      const ts = new Date().toISOString();
      const results = await discoverRepositories();
      console.log(
        `[${ts}] Discovery completed: total=${results.total} new=${results.newRepos} updated=${results.updatedRepos} errors=${results.errors.length}`
      );
      if (results.errors.length > 0) {
        console.error(`[${ts}] Discovery errors:`, results.errors);
      }
      return { itemsProcessed: results.newRepos + results.updatedRepos };
    },
  });

export { discoverRepositories };
