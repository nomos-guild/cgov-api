/**
 * Job Registry
 * Central place to start all cron jobs
 */

import { startProposalSyncJob } from "./sync-proposals.job";
import { startVoterPowerSyncJob } from "./sync-voter-power.job";
import { startDiscoverGithubJob } from "./discover-github.job";
import { startSyncGithubActivityJob } from "./sync-github-activity.job";
import { startAggregateGithubJob } from "./aggregate-github.job";
import { startBackfillGithubJob } from "./backfill-github.job";
import { startSnapshotGithubJob } from "./snapshot-github.job";

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

  // Start GitHub discovery job (weekly)
  startDiscoverGithubJob();

  // Start GitHub activity sync job (every 30 min)
  startSyncGithubActivityJob();

  // Start GitHub aggregation job (daily)
  startAggregateGithubJob();

  // Start GitHub backfill job (hourly, until all repos are backfilled)
  startBackfillGithubJob();

  // Start GitHub daily snapshot job (stars/forks for all repos)
  startSnapshotGithubJob();

  console.log("[Cron] All cron jobs initialized");
};
