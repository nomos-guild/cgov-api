/**
 * Job Registry
 * Central place to start all cron jobs
 */

import { startProposalSyncJob } from "./sync-proposals.job";

/**
 * Starts all registered cron jobs
 * Called from main server initialization (src/index.ts)
 */
export const startAllJobs = () => {
  console.log("[Cron] Initializing all cron jobs...");

  // Start proposal sync job
  startProposalSyncJob();

  // Add more jobs here as needed
  // Example:
  // startVoteCleanupJob();
  // startMetricsJob();

  console.log("[Cron] All cron jobs initialized");
};