/**
 * Job Registry
 * Central place to start all cron jobs
 */

import { startProposalSyncJob } from "./sync-proposals.job";
import { startVoterPowerSyncJob } from "./sync-voter-power.job";

/**
 * Starts all registered cron jobs
 * Called from main server initialization (src/index.ts)
 */
export const startAllJobs = () => {
  console.log("[Cron] Initializing all cron jobs...");

  // Start proposal sync job
  startProposalSyncJob();

  // Start voter power sync job (DRep and SPO voting power updates)
  startVoterPowerSyncJob();

  // Add more jobs here as needed
  // Example:
  // startVoteCleanupJob();
  // startMetricsJob();

  console.log("[Cron] All cron jobs initialized");
};
