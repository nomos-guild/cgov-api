import cron from "node-cron";
import { snapshotAllRepos } from "../services/ingestion/github-activity";

let isSnapshotRunning = false;

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

    try {
      const result = await snapshotAllRepos();

      console.log(
        `[${ts}] Snapshot complete:`,
        `\n  - Repos: ${result.success}/${result.total}`,
        `\n  - Failed: ${result.failed}`
      );

      if (result.errors.length > 0) {
        console.error(`[${ts}] Snapshot errors:`, result.errors.slice(0, 5));
      }
    } catch (error: any) {
      console.error(`[${ts}] GitHub snapshot job failed:`, error.message);
    } finally {
      isSnapshotRunning = false;
    }
  });

  console.log(`[Cron] GitHub daily snapshot job scheduled: ${schedule}`);
}
