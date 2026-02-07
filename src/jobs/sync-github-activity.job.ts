import cron from "node-cron";
import {
  syncActiveRepos,
  syncModerateRepos,
  syncDormantRepos,
  reTierRepos,
} from "../services/ingestion/github-activity";

let isSyncRunning = false;

export const startSyncGithubActivityJob = () => {
  const schedule = process.env.GITHUB_SYNC_SCHEDULE || "*/30 * * * *"; // Every 30 min
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log("[Cron] GitHub activity sync job disabled via ENABLE_CRON_JOBS");
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(`[Cron] Invalid sync schedule: ${schedule}. Using default.`);
    return startWithSchedule("*/30 * * * *");
  }

  startWithSchedule(schedule);
};

function startWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isSyncRunning) {
      console.log(`[${new Date().toISOString()}] GitHub sync still running. Skipping.`);
      return;
    }

    isSyncRunning = true;
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] Starting GitHub activity sync...`);

    try {
      // Always sync active repos
      const activeResult = await syncActiveRepos();
      logSyncResult("Active", activeResult, ts);

      // Moderate repos: sync once per day (check if hour is 4am UTC)
      const hour = new Date().getUTCHours();
      if (hour === 4) {
        const moderateResult = await syncModerateRepos();
        logSyncResult("Moderate", moderateResult, ts);
      }

      // Dormant repos: sync once per week (Sunday 5am UTC)
      const day = new Date().getUTCDay();
      if (day === 0 && hour === 5) {
        const dormantResult = await syncDormantRepos();
        logSyncResult("Dormant", dormantResult, ts);
      }

      // Re-tier repos daily at 6am UTC
      if (hour === 6) {
        const tierResult = await reTierRepos();
        console.log(
          `[${ts}] Re-tier: ${tierResult.promoted} promoted, ${tierResult.demoted} demoted`
        );
      }

    } catch (error: any) {
      console.error(`[${ts}] GitHub sync job failed:`, error.message);
    } finally {
      isSyncRunning = false;
    }
  });

  console.log(`[Cron] GitHub activity sync job scheduled: ${schedule}`);
}

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
