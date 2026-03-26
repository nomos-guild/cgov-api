import {
  syncActiveRepos,
  syncModerateRepos,
  syncDormantRepos,
  reTierRepos,
} from "../services/ingestion/github-activity";
import { getBoundedIntEnv } from "../services/ingestion/syncLock";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = "github-activity-sync";
const LOCK_TTL_MS = getBoundedIntEnv(
  "GITHUB_SYNC_LOCK_TTL_MS",
  25 * 60 * 1000,
  30_000,
  2 * 60 * 60 * 1000
);

export const startSyncGithubActivityJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "GitHub Activity Sync",
    scheduleEnvKey: "GITHUB_SYNC_SCHEDULE",
    defaultSchedule: "*/30 * * * *",
    skipDbPressure: true,
    lockOptions: { ttlMs: LOCK_TTL_MS, source: "cron" },
    run: async () => {
      const ts = new Date().toISOString();
      const activeResult = await syncActiveRepos();
      logSyncResult("Active", activeResult, ts);

      const hour = new Date().getUTCHours();
      if (hour === 4) {
        logSyncResult("Moderate", await syncModerateRepos(), ts);
      }
      const day = new Date().getUTCDay();
      if (day === 0 && hour === 5) {
        logSyncResult("Dormant", await syncDormantRepos(), ts);
      }
      if (hour === 6) {
        const tierResult = await reTierRepos();
        console.log(
          `[${ts}] Re-tier: ${tierResult.promoted} promoted, ${tierResult.demoted} demoted`
        );
      }
      return { itemsProcessed: activeResult.success };
    },
  });

function logSyncResult(
  tier: string,
  result: { total: number; success: number; failed: number; eventsCreated: number; errors: Array<{ repo: string; error: string }> },
  ts: string
): void {
  console.log(
    `[${ts}] ${tier} sync:`,
    `\n  - Repos: ${result.success}/${result.total}`,
    `\n  - Events: ${result.eventsCreated}`,
    `\n  - Failed: ${result.failed}`
  );
  if (result.errors.length > 0) {
    console.error(`[${ts}] ${tier} sync errors:`, result.errors.slice(0, 5));
  }
}
