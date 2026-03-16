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
import { startDrepInventorySyncJob } from "./sync-drep-inventory.job";
import { startDrepInfoSyncJob } from "./sync-drep-info.job";
import { startEpochTotalsSyncJob } from "./sync-epoch-totals.job";
import { startDrepLifecycleSyncJob } from "./sync-drep-lifecycle.job";
import { startPoolGroupsSyncJob } from "./sync-pool-groups.job";
import { startMissingEpochsSyncJob } from "./sync-missing-epochs.job";
import { startDrepDelegatorSyncJob } from "./sync-drep-delegators.job";

/**
 * Starts all registered cron jobs
 * Called from main server initialization (src/index.ts)
 */
export const startAllJobs = () => {
  console.log("[Cron] Initializing all cron jobs...");

  // Start proposal sync job
  startProposalSyncJob();

  // Start voter power sync job (DRep and SPO voting power updates; daily at 00:08 UTC by default)
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

  // --- Governance analytics epoch sync jobs (split for timeout isolation) ---

  // DRep inventory + epoch snapshot (hourly at :02)
  startDrepInventorySyncJob();

  // DRep info full refresh (hourly at :22) — slowest step, isolated
  startDrepInfoSyncJob();

  // DRep lifecycle events (hourly at :37)
  startDrepLifecycleSyncJob();

  // Epoch totals for previous + current epoch (hourly at :42)
  startEpochTotalsSyncJob();

  // Pool group mappings (hourly at :47)
  startPoolGroupsSyncJob();

  // Missing epochs backfill (twice daily at 01:05 and 13:05 UTC by default)
  startMissingEpochsSyncJob();

  // DRep delegation change sync (hourly at :52)
  startDrepDelegatorSyncJob();

  console.log("[Cron] All cron jobs initialized");
};
