/**
 * Epoch Analytics Service
 *
 * Orchestration layer for governance analytics sync jobs.
 * Re-exports functions from domain-specific services for backward compatibility.
 *
 * Domain services:
 * - drep-sync.service.ts: DRep inventory and info sync
 * - epoch-totals.service.ts: Epoch totals, timestamps, and missing epochs backfill
 * - delegation-sync.service.ts: Stake address delegation tracking
 * - drep-lifecycle.service.ts: DRep registration/deregistration events
 * - pool-groups.service.ts: Multi-pool operator groupings
 * - sync-utils.ts: Shared utilities and constants
 */

import type { Prisma } from "@prisma/client";
import { getKoiosCurrentEpoch } from "./sync-utils";

// Re-export from drep-sync.service
export {
  syncAllDrepsInventory,
  syncAllDrepsInfo,
  type SyncDrepInventoryResult,
  type SyncDrepInfoResult,
} from "./drep-sync.service";

// Re-export from epoch-totals.service (includes epoch timestamps)
export {
  syncEpochTotals,
  syncMissingEpochAnalytics,
  getEpochTimestamps,
  getEpochDuration,
  type SyncEpochTotalsResult,
  type SyncMissingEpochsResult,
} from "./epoch-totals.service";

// Re-export from delegation-sync.service
export {
  syncDrepDelegationChanges,
  type SyncDrepDelegationChangesResult,
} from "./delegation-sync.service";

// Re-export from drep-lifecycle.service
export {
  syncDrepLifecycleEvents,
  syncDrepLifecycleEventsForEpochRange,
  type SyncDrepLifecycleResult,
} from "./drep-lifecycle.service";

// Re-export from pool-groups.service
export {
  syncPoolGroups,
  getPoolGroupStats,
  type SyncPoolGroupsResult,
} from "./pool-groups.service";

// Import for orchestration
import { syncAllDrepsInventory, syncAllDrepsInfo, type SyncDrepInventoryResult, type SyncDrepInfoResult } from "./drep-sync.service";
import { syncEpochTotals, type SyncEpochTotalsResult } from "./epoch-totals.service";
import { syncDrepLifecycleEvents, type SyncDrepLifecycleResult } from "./drep-lifecycle.service";
import { syncPoolGroups, type SyncPoolGroupsResult } from "./pool-groups.service";

// ============================================================
// Orchestration Types
// ============================================================

export interface SyncGovernanceAnalyticsEpochResult {
  epoch: number;
  currentEpoch: number;
  dreps?: SyncDrepInventoryResult;
  drepInfo?: SyncDrepInfoResult;
  totals?: SyncEpochTotalsResult; // Now includes epoch timestamps
  drepLifecycle?: SyncDrepLifecycleResult;
  poolGroups?: SyncPoolGroupsResult;
  skipped: {
    dreps: boolean;
    drepInfo: boolean;
    totals: boolean;
    drepLifecycle: boolean;
    poolGroups: boolean;
  };
}

export interface SyncGovernanceAnalyticsPreviousAndCurrentResult {
  currentEpoch: number;
  previousEpoch: SyncGovernanceAnalyticsEpochResult;
  currentEpochTotals: SyncEpochTotalsResult;
}

// ============================================================
// Orchestration Functions
// ============================================================

/**
 * Sync governance analytics for a specific epoch.
 * Uses per-step checkpoints to avoid re-running completed work.
 *
 * Note: Epoch timestamps are now fetched as part of the totals sync (step 3),
 * so there's no separate epoch info sync step.
 */
async function syncGovernanceAnalyticsForEpoch(
  prisma: Prisma.TransactionClient,
  epochToSync: number,
  currentEpoch: number
): Promise<SyncGovernanceAnalyticsEpochResult> {
  if (epochToSync < 0 || epochToSync >= currentEpoch) {
    return {
      epoch: epochToSync,
      currentEpoch,
      skipped: {
        dreps: true,
        drepInfo: true,
        totals: true,
        drepLifecycle: true,
        poolGroups: true,
      },
    };
  }

  // Ensure a per-epoch sync state row exists.
  const state = await prisma.epochAnalyticsSync.upsert({
    where: { epoch: epochToSync },
    update: {},
    create: { epoch: epochToSync },
  });

  const res: SyncGovernanceAnalyticsEpochResult = {
    epoch: epochToSync,
    currentEpoch,
    skipped: {
      dreps: !!state.drepsSyncedAt,
      drepInfo: !!state.drepInfoSyncedAt,
      totals: !!state.totalsSyncedAt,
      drepLifecycle: !!state.drepLifecycleSyncedAt,
      poolGroups: !!state.poolGroupsSyncedAt,
    },
  };

  // 1) DRep inventory (all DReps, not just voters)
  if (!state.drepsSyncedAt) {
    res.dreps = await syncAllDrepsInventory(prisma);
    await prisma.epochAnalyticsSync.update({
      where: { epoch: epochToSync },
      data: { drepsSyncedAt: new Date() },
    });
  }

  // 2) DRep info sync (update ALL DReps from /drep_info for this epoch)
  if (!state.drepInfoSyncedAt) {
    res.drepInfo = await syncAllDrepsInfo(prisma);
    await prisma.epochAnalyticsSync.update({
      where: { epoch: epochToSync },
      data: { drepInfoSyncedAt: new Date() },
    });
  }

  // 3) Epoch denominators/totals + timestamps (from /totals, /drep_epoch_summary, /epoch_info)
  if (!state.totalsSyncedAt) {
    res.totals = await syncEpochTotals(prisma, epochToSync);
    await prisma.epochAnalyticsSync.update({
      where: { epoch: epochToSync },
      data: { totalsSyncedAt: new Date() },
    });
  }

  // 4) DRep lifecycle events (registrations, deregistrations, updates)
  if (!state.drepLifecycleSyncedAt) {
    res.drepLifecycle = await syncDrepLifecycleEvents(prisma);
    // Mark checkpoint if we successfully talked to Koios (i.e., fetched any updates)
    // or if we actually ingested rows. This avoids "false success" where Koios calls
    // systematically fail/return empty and we mark the epoch as done anyway.
    const fetchedAnyUpdates = res.drepLifecycle.totalUpdatesFetched > 0;
    const hadAnySuccess = res.drepLifecycle.drepsProcessed > 0;

    if (hadAnySuccess && (res.drepLifecycle.eventsIngested > 0 || fetchedAnyUpdates)) {
      await prisma.epochAnalyticsSync.update({
        where: { epoch: epochToSync },
        data: { drepLifecycleSyncedAt: new Date() },
      });
    } else {
      console.error(
        `[Epoch Analytics] DRep lifecycle sync appears to have fetched 0 updates total for epoch ${epochToSync}; ` +
          `not marking drepLifecycleSyncedAt so it can retry next run. ` +
          `(drepsAttempted=${res.drepLifecycle.drepsAttempted}, drepsProcessed=${res.drepLifecycle.drepsProcessed}, ` +
          `drepsWithNoUpdates=${res.drepLifecycle.drepsWithNoUpdates}, updatesFetched=${res.drepLifecycle.totalUpdatesFetched}, ` +
          `eventsIngested=${res.drepLifecycle.eventsIngested}, failed=${res.drepLifecycle.failed.length})`
      );
    }
  }

  // 5) Pool groups (multi-pool operator mappings)
  if (!state.poolGroupsSyncedAt) {
    res.poolGroups = await syncPoolGroups(prisma);
    await prisma.epochAnalyticsSync.update({
      where: { epoch: epochToSync },
      data: { poolGroupsSyncedAt: new Date() },
    });
  }

  return res;
}

/**
 * High-level orchestration for a single epoch.
 * Designed to be called at the *start* of a new epoch to sync the previous one.
 */
export async function syncGovernanceAnalyticsForPreviousEpoch(
  prisma: Prisma.TransactionClient
): Promise<SyncGovernanceAnalyticsEpochResult> {
  const currentEpoch = await getKoiosCurrentEpoch();
  const epochToSync = currentEpoch - 1;

  return syncGovernanceAnalyticsForEpoch(prisma, epochToSync, currentEpoch);
}

/**
 * Sync governance analytics for the previous epoch (checkpointed) AND
 * always upsert current epoch totals/timestamps on every run.
 *
 * Rationale: current epoch totals evolve as the chain progresses, so we want
 * to keep the current epoch row up-to-date until the epoch rolls over.
 */
export async function syncGovernanceAnalyticsForPreviousAndCurrentEpoch(
  prisma: Prisma.TransactionClient
): Promise<SyncGovernanceAnalyticsPreviousAndCurrentResult> {
  const currentEpoch = await getKoiosCurrentEpoch();

  const previousEpoch = await syncGovernanceAnalyticsForEpoch(
    prisma,
    currentEpoch - 1,
    currentEpoch
  );

  // Always refresh current-epoch totals (these change throughout the epoch).
  const currentEpochTotals = await syncEpochTotals(prisma, currentEpoch);

  return {
    currentEpoch,
    previousEpoch,
    currentEpochTotals,
  };
}
