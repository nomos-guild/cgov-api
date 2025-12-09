/**
 * Voter Power Sync Cron Job
 * Periodically syncs DRep and SPO voting power from Koios API
 * Updates voting power based on the latest epoch data
 */

import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import { syncAllVoterVotingPower } from "../services/ingestion/voter.service";

const prisma = new PrismaClient();

// Simple in-process guard to prevent overlapping runs in a single Node process
let isVoterPowerSyncRunning = false;

/**
 * Starts the voter power sync cron job
 * Schedule is configurable via VOTER_POWER_SYNC_SCHEDULE env variable
 * Defaults to every 6 hours (at minute 30 to offset from proposal sync)
 */
export const startVoterPowerSyncJob = () => {
  const schedule = process.env.VOTER_POWER_SYNC_SCHEDULE || "30 */6 * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] Voter power sync job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  // Validate cron schedule
  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: 30 */6 * * *`
    );
    return startVoterPowerSyncJobWithSchedule("30 */6 * * *");
  }

  startVoterPowerSyncJobWithSchedule(schedule);
};

/**
 * Internal function to start the job with a specific schedule
 */
function startVoterPowerSyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    // In-process guard: skip this run if the previous one is still in progress
    if (isVoterPowerSyncRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] Voter power sync job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isVoterPowerSyncRunning = true;
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Starting voter power sync job...`);

    try {
      const results = await syncAllVoterVotingPower(prisma);

      console.log(
        `[${timestamp}] Voter power sync completed for epoch ${results.epoch}:`,
        `\n  DReps:`,
        `\n    - Total: ${results.dreps.total}`,
        `\n    - Updated: ${results.dreps.updated}`,
        `\n    - Failed: ${results.dreps.failed}`,
        `\n  SPOs:`,
        `\n    - Total: ${results.spos.total}`,
        `\n    - Updated: ${results.spos.updated}`,
        `\n    - Failed: ${results.spos.failed}`
      );

      // Log errors if any
      if (results.dreps.errors.length > 0) {
        console.error(
          `[${timestamp}] DRep sync errors:`,
          results.dreps.errors.slice(0, 10) // Limit to first 10 errors
        );
      }
      if (results.spos.errors.length > 0) {
        console.error(
          `[${timestamp}] SPO sync errors:`,
          results.spos.errors.slice(0, 10) // Limit to first 10 errors
        );
      }
    } catch (error: any) {
      console.error(
        `[${timestamp}] Voter power sync job failed:`,
        error.message
      );
    } finally {
      isVoterPowerSyncRunning = false;
    }
  });

  console.log(`[Cron] Voter power sync job scheduled with cron: ${schedule}`);
  console.log(`[Cron] Next execution times:`);

  // Show next execution info
  const cronJob = cron.schedule(schedule, () => {});
  console.log(`  - Job will run at the specified schedule`);
  cronJob.stop();
}
