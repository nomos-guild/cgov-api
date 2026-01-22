/**
 * Job Registry
 * Central place to start all cron jobs
 */

import { startProposalSyncJob } from "./sync-proposals.job";
import { startVoterPowerSyncJob } from "./sync-voter-power.job";
import { startEpochAnalyticsSyncJob } from "./sync-epoch-analytics.job";
import { startDrepDelegatorSyncJob } from "./sync-drep-delegators.job";

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

  // Start governance analytics epoch sync job (DRep inventory + epoch snapshots)
  startEpochAnalyticsSyncJob();

  // Start DRep delegation change sync job
  startDrepDelegatorSyncJob();

  // Add more jobs here as needed
  // Example:
  // startVoteCleanupJob();
  // startMetricsJob();

  console.log("[Cron] All cron jobs initialized");
};
