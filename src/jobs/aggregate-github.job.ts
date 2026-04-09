import {
  aggregateRecentToHistorical,
  precomputeNetworkGraphs,
} from "../services/ingestion/github-aggregation";
import { getBoundedIntEnv } from "../services/ingestion/syncLock";
import { GITHUB_LOCK_KEYS } from "../services/ingestion/githubLockKeys";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = GITHUB_LOCK_KEYS.aggregation;
const LOCK_TTL_MS = getBoundedIntEnv(
  "GITHUB_AGGREGATION_LOCK_TTL_MS",
  30 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000
);

export const startAggregateGithubJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "GitHub Aggregation Sync",
    scheduleEnvKey: "GITHUB_AGGREGATION_SCHEDULE",
    defaultSchedule: "0 4 * * *",
    skipDbPressure: true,
    lockOptions: { ttlMs: LOCK_TTL_MS, source: "cron" },
    run: async () => {
      const ts = new Date().toISOString();
      const result = await aggregateRecentToHistorical();
      console.log(
        `[${ts}] Aggregation completed: daysRolledUp=${result.daysRolledUp} rowsDeleted=${result.rowsDeleted} developersUpdated=${result.developersUpdated}`
      );
      await precomputeNetworkGraphs();
      return {
        itemsProcessed: result.daysRolledUp + result.developersUpdated,
      };
    },
  });
