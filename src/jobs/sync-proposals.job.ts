/**
 * Proposal Sync Cron Job
 * Periodically syncs all proposals from Koios API to database
 */

import cron from "node-cron";
import { syncAllProposals } from "../services/ingestion/proposal.service";

// Simple in-process guard to prevent overlapping runs in a single Node process
let isProposalSyncRunning = false;

/**
 * Starts the proposal sync cron job
 * Schedule is configurable via PROPOSAL_SYNC_SCHEDULE env variable
 * Defaults to every 5 minutes
 */
export const startProposalSyncJob = () => {
  const schedule = process.env.PROPOSAL_SYNC_SCHEDULE || "*/5 * * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] Proposal sync job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  // Validate cron schedule
  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: */5 * * * *`
    );
    return startProposalSyncJobWithSchedule("*/5 * * * *");
  }

  startProposalSyncJobWithSchedule(schedule);
};

/**
 * Internal function to start the job with a specific schedule
 */
function startProposalSyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    // In-process guard: skip this run if the previous one is still in progress
    if (isProposalSyncRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] Proposal sync job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isProposalSyncRunning = true;
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Starting proposal sync job...`);

    try {
      const results = await syncAllProposals();

      console.log(
        `[${timestamp}] Proposal sync completed:`,
        `\n  - Total: ${results.total}`,
        `\n  - Success: ${results.success}`,
        `\n  - Failed: ${results.failed}`
      );

      // Log errors if any
      if (results.errors.length > 0) {
        console.error(
          `[${timestamp}] Errors encountered during sync:`,
          results.errors
        );
      }
    } catch (error: any) {
      console.error(
        `[${timestamp}] Proposal sync job failed:`,
        error.message
      );
    } finally {
      isProposalSyncRunning = false;
    }
  });

  console.log(`[Cron] Proposal sync job scheduled with cron: ${schedule}`);
  console.log(`[Cron] Next execution times:`);

  // Show next 3 execution times
  const cronJob = cron.schedule(schedule, () => {});
  console.log(`  - Job will run at the specified schedule`);
  cronJob.stop();
}
