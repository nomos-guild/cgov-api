import cron from "node-cron";
import {
  aggregateRecentToHistorical,
  precomputeNetworkGraphs,
} from "../services/ingestion/github-aggregation";

let isRunning = false;

export const startAggregateGithubJob = () => {
  const schedule = process.env.GITHUB_AGGREGATION_SCHEDULE || "0 5 * * *"; // Daily 5am UTC
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log("[Cron] GitHub aggregation job disabled via ENABLE_CRON_JOBS");
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(`[Cron] Invalid aggregation schedule: ${schedule}. Using default.`);
    return startWithSchedule("0 5 * * *");
  }

  startWithSchedule(schedule);
};

function startWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isRunning) {
      console.log(`[${new Date().toISOString()}] GitHub aggregation still running. Skipping.`);
      return;
    }

    isRunning = true;
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] Starting GitHub aggregation job...`);

    try {
      const result = await aggregateRecentToHistorical();
      console.log(
        `[${ts}] Aggregation completed:`,
        `\n  - Days rolled up: ${result.daysRolledUp}`,
        `\n  - Rows deleted: ${result.rowsDeleted}`,
        `\n  - Developers updated: ${result.developersUpdated}`
      );

      await precomputeNetworkGraphs();
    } catch (error: any) {
      console.error(`[${ts}] GitHub aggregation job failed:`, error.message);
    } finally {
      isRunning = false;
    }
  });

  console.log(`[Cron] GitHub aggregation job scheduled: ${schedule}`);
}
