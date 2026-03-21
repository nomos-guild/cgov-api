/**
 * Proposal Sync Cron Job
 * Periodically syncs all proposals from Koios API to database
 * Also updates NCL (Net Change Limit) data for treasury withdrawals
 */

import cron from "node-cron";
import { syncAllProposals } from "../services/ingestion/proposal.service";
import { updateNCL } from "../services/ingestion/ncl.service";
import {
  releaseProposalSyncLock,
  tryAcquireProposalSyncLock,
} from "../services/ingestion/proposalSyncLock";

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
        `[${timestamp}] Proposal sync job is still running locally. Skipping this run.`
      );
      return;
    }

    isProposalSyncRunning = true;
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Starting proposal sync job...`);

    try {
      const acquired = await tryAcquireProposalSyncLock("cron.proposal-sync");
      if (!acquired) {
        console.log(
          `[${timestamp}] Proposal sync skipped because another instance already holds the DB lock.`
        );
        return;
      }

      const results = await syncAllProposals();

      console.log(
        `[${timestamp}] Proposal sync completed:`,
        `\n  - Total: ${results.total}`,
        `\n  - Success: ${results.success}`,
        `\n  - Partial: ${results.partial}`,
        `\n  - Failed: ${results.failed}`
      );

      // Log errors if any
      if (results.errors.length > 0) {
        console.error(
          `[${timestamp}] Errors encountered during sync:`,
          results.errors
        );
      }

      // Update NCL (Net Change Limit) after proposal sync
      try {
        const nclResult = await updateNCL();
        console.log(
          `[${timestamp}] NCL update completed:`,
          `\n  - Year: ${nclResult.year}`,
          `\n  - Epoch: ${nclResult.epoch}`,
          `\n  - Current: ${nclResult.currentValue.toLocaleString()} ADA`,
          `\n  - Proposals included: ${nclResult.proposalsIncluded}`
        );
      } catch (nclError: any) {
        console.error(
          `[${timestamp}] NCL update failed:`,
          nclError.message
        );
      }

      await releaseProposalSyncLock({
        status: "success",
        itemsProcessed: results.success,
      });
    } catch (error: any) {
      console.error(
        `[${timestamp}] Proposal sync job failed:`,
        error.message
      );
      try {
        await releaseProposalSyncLock({
          status: "failed",
          errorMessage: error?.message ?? "Unknown error",
        });
      } catch (releaseError: any) {
        console.error(
          `[${timestamp}] Failed to release proposal sync lock:`,
          releaseError?.message ?? releaseError
        );
      }
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
