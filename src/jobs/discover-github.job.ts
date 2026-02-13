import cron from "node-cron";
import { discoverRepositories } from "../services/ingestion/github-discovery";

let isRunning = false;

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

    try {
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
    } catch (error: any) {
      console.error(`[${ts}] GitHub discovery job failed:`, error.message);
    } finally {
      isRunning = false;
    }
  });

  console.log(`[Cron] GitHub discovery job scheduled: ${schedule}`);
}

export { discoverRepositories };
