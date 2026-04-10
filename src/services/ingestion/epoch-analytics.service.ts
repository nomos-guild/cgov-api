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
import { withIngestionDbWrite } from "./dbSession";
import { getKoiosCurrentEpoch } from "./sync-utils";

// Re-export from drep-sync.service
export {
  syncAllDrepsInventory,
  syncAllDrepsInfo,
  snapshotDrepEpoch,
  type SyncDrepInventoryResult,
  type SyncDrepInfoResult,
  type SnapshotDrepEpochResult,
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
import { syncAllDrepsInventory, syncAllDrepsInfo, snapshotDrepEpoch, type SyncDrepInventoryResult, type SyncDrepInfoResult, type SnapshotDrepEpochResult } from "./drep-sync.service";
import {
  hasIncompleteEpochTotals,
  isEpochTotalsResultComplete,
  shouldRequireCompleteEpochTotals,
  syncEpochTotals,
  type SyncEpochTotalsResult,
} from "./epoch-totals.service";
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
  drepSnapshot?: SnapshotDrepEpochResult;
  totals?: SyncEpochTotalsResult; // Now includes epoch timestamps
  drepLifecycle?: SyncDrepLifecycleResult;
  poolGroups?: SyncPoolGroupsResult;
  skipped: {
    dreps: boolean;
    drepInfo: boolean;
    drepSnapshot: boolean;
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
// Per-Step Result Types (for individual jobs)
// ============================================================

export interface StepDrepInventoryResult {
  currentEpoch: number;
  epochToSync: number;
  inventory?: SyncDrepInventoryResult;
  snapshot?: SnapshotDrepEpochResult;
  skippedInventory: boolean;
  skippedSnapshot: boolean;
}

export interface StepDrepInfoResult {
  currentEpoch: number;
  epochToSync: number;
  drepInfo?: SyncDrepInfoResult;
  skipped: boolean;
}

export interface StepEpochTotalsResult {
  currentEpoch: number;
  epochToSync: number;
  previousEpochTotals?: SyncEpochTotalsResult;
  currentEpochTotals: SyncEpochTotalsResult;
  skippedPrevious: boolean;
}

export interface StepDrepLifecycleResult {
  currentEpoch: number;
  epochToSync: number;
  drepLifecycle?: SyncDrepLifecycleResult;
  skipped: boolean;
}

export interface StepPoolGroupsResult {
  currentEpoch: number;
  epochToSync: number;
  poolGroups?: SyncPoolGroupsResult;
  skipped: boolean;
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
        drepSnapshot: true,
        totals: true,
        drepLifecycle: true,
        poolGroups: true,
      },
    };
  }

  // Ensure a per-epoch sync state row exists.
  const state = await withIngestionDbWrite(
    prisma,
    "epoch-analytics.checkpoint.ensure",
    () =>
      prisma.epochAnalyticsSync.upsert({
        where: { epoch: epochToSync },
        update: {},
        create: { epoch: epochToSync },
      })
  );

  const res: SyncGovernanceAnalyticsEpochResult = {
    epoch: epochToSync,
    currentEpoch,
    skipped: {
      dreps: !!state.drepsSyncedAt,
      drepInfo: !!state.drepInfoSyncedAt,
      drepSnapshot: !!state.drepSnapshotSyncedAt,
      totals: !!state.totalsSyncedAt,
      drepLifecycle: !!state.drepLifecycleSyncedAt,
      poolGroups: !!state.poolGroupsSyncedAt,
    },
  };

  // 1) DRep inventory (all DReps, not just voters)
  if (!state.drepsSyncedAt) {
    res.dreps = await syncAllDrepsInventory(prisma);
    await withIngestionDbWrite(prisma, "epoch-analytics.checkpoint.mark-dreps-synced", () =>
      prisma.epochAnalyticsSync.update({
        where: { epoch: epochToSync },
        data: { drepsSyncedAt: new Date() },
      })
    );
  }

  // 2) DRep info sync (update ALL DReps from /drep_info for this epoch)
  if (!state.drepInfoSyncedAt) {
    res.drepInfo = await syncAllDrepsInfo(prisma);
    await withIngestionDbWrite(prisma, "epoch-analytics.checkpoint.mark-drep-info-synced", () =>
      prisma.epochAnalyticsSync.update({
        where: { epoch: epochToSync },
        data: { drepInfoSyncedAt: new Date() },
      })
    );
  }

  // 3) DRep epoch snapshot (delegatorCount + votingPower for every DRep)
  if (!state.drepSnapshotSyncedAt) {
    res.drepSnapshot = await snapshotDrepEpoch(prisma, epochToSync);
    await withIngestionDbWrite(
      prisma,
      "epoch-analytics.checkpoint.mark-drep-snapshot-synced",
      () =>
        prisma.epochAnalyticsSync.update({
          where: { epoch: epochToSync },
          data: { drepSnapshotSyncedAt: new Date() },
        })
    );
  }

  // 4) Epoch denominators/totals + timestamps (from /totals, /drep_epoch_summary, /epoch_info)
  if (!state.totalsSyncedAt) {
    res.totals = await syncEpochTotals(prisma, epochToSync);
    await withIngestionDbWrite(prisma, "epoch-analytics.checkpoint.mark-totals-synced", () =>
      prisma.epochAnalyticsSync.update({
        where: { epoch: epochToSync },
        data: { totalsSyncedAt: new Date() },
      })
    );
  }

  // 5) DRep lifecycle events (registrations, deregistrations, updates)
  if (!state.drepLifecycleSyncedAt) {
    res.drepLifecycle = await syncDrepLifecycleEvents(prisma);
    // Mark checkpoint only when Koios returned meaningful data AND every DRep worker
    // succeeded. Partial failures must not mark the epoch done (skipDuplicates makes retry safe).
    const fetchedAnyUpdates = res.drepLifecycle.totalUpdatesFetched > 0;
    const hadAnySuccess = res.drepLifecycle.drepsProcessed > 0;
    const noPerDrepFailures = res.drepLifecycle.failed.length === 0;

    if (
      hadAnySuccess &&
      noPerDrepFailures &&
      (res.drepLifecycle.eventsIngested > 0 || fetchedAnyUpdates)
    ) {
      await withIngestionDbWrite(
        prisma,
        "epoch-analytics.checkpoint.mark-drep-lifecycle-synced",
        () =>
          prisma.epochAnalyticsSync.update({
            where: { epoch: epochToSync },
            data: { drepLifecycleSyncedAt: new Date() },
          })
      );
    } else if (!noPerDrepFailures) {
      console.error(
        `[Epoch Analytics] DRep lifecycle sync had ${res.drepLifecycle.failed.length} failed DRep(s) for epoch ${epochToSync}; ` +
          `not marking drepLifecycleSyncedAt so the next run retries (idempotent). ` +
          `(drepsAttempted=${res.drepLifecycle.drepsAttempted}, drepsProcessed=${res.drepLifecycle.drepsProcessed}, ` +
          `updatesFetched=${res.drepLifecycle.totalUpdatesFetched}, eventsIngested=${res.drepLifecycle.eventsIngested})`
      );
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

  // 6) Pool groups (multi-pool operator mappings)
  if (!state.poolGroupsSyncedAt) {
    res.poolGroups = await syncPoolGroups(prisma);
    await withIngestionDbWrite(
      prisma,
      "epoch-analytics.checkpoint.mark-pool-groups-synced",
      () =>
        prisma.epochAnalyticsSync.update({
          where: { epoch: epochToSync },
          data: { poolGroupsSyncedAt: new Date() },
        })
    );
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
 * @deprecated Use the individual step functions instead for better timeout isolation.
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

// ============================================================
// Per-Step Checkpoint Functions (for individual cron jobs)
// ============================================================

/**
 * Ensures the EpochAnalyticsSync checkpoint row exists for the given epoch.
 * Returns the current state of the checkpoint.
 */
async function ensureEpochCheckpoint(
  prisma: Prisma.TransactionClient,
  epochToSync: number
) {
  return withIngestionDbWrite(prisma, "epoch-analytics.checkpoint.ensure", () =>
    prisma.epochAnalyticsSync.upsert({
      where: { epoch: epochToSync },
      update: {},
      create: { epoch: epochToSync },
    })
  );
}

/**
 * Step: DRep inventory + epoch snapshot.
 * Fetches new DReps from Koios /drep_list and snapshots all DReps for the epoch.
 */
export async function syncDrepInventoryStep(
  prisma: Prisma.TransactionClient
): Promise<StepDrepInventoryResult> {
  const currentEpoch = await getKoiosCurrentEpoch();
  const epochToSync = currentEpoch - 1;

  if (epochToSync < 0) {
    return { currentEpoch, epochToSync, skippedInventory: true, skippedSnapshot: true };
  }

  const state = await ensureEpochCheckpoint(prisma, epochToSync);
  const result: StepDrepInventoryResult = {
    currentEpoch,
    epochToSync,
    skippedInventory: !!state.drepsSyncedAt,
    skippedSnapshot: !!state.drepSnapshotSyncedAt,
  };

  if (!state.drepsSyncedAt) {
    result.inventory = await syncAllDrepsInventory(prisma);
    await withIngestionDbWrite(prisma, "epoch-analytics.checkpoint.mark-dreps-synced", () =>
      prisma.epochAnalyticsSync.update({
        where: { epoch: epochToSync },
        data: { drepsSyncedAt: new Date() },
      })
    );
  }

  if (!state.drepSnapshotSyncedAt) {
    result.snapshot = await snapshotDrepEpoch(prisma, epochToSync);
    await withIngestionDbWrite(
      prisma,
      "epoch-analytics.checkpoint.mark-drep-snapshot-synced",
      () =>
        prisma.epochAnalyticsSync.update({
          where: { epoch: epochToSync },
          data: { drepSnapshotSyncedAt: new Date() },
        })
    );
  }

  return result;
}

/**
 * Step: Full DRep info refresh.
 * Updates ALL DReps from Koios /drep_info + /drep_updates metadata.
 * This is the slowest step — isolated to avoid timing out other steps.
 */
export async function syncDrepInfoStep(
  prisma: Prisma.TransactionClient
): Promise<StepDrepInfoResult> {
  const currentEpoch = await getKoiosCurrentEpoch();
  const epochToSync = currentEpoch - 1;

  if (epochToSync < 0) {
    return { currentEpoch, epochToSync, skipped: true };
  }

  const state = await ensureEpochCheckpoint(prisma, epochToSync);

  if (state.drepInfoSyncedAt) {
    return { currentEpoch, epochToSync, skipped: true };
  }

  const drepInfo = await syncAllDrepsInfo(prisma);
  await withIngestionDbWrite(prisma, "epoch-analytics.checkpoint.mark-drep-info-synced", () =>
    prisma.epochAnalyticsSync.update({
      where: { epoch: epochToSync },
      data: { drepInfoSyncedAt: new Date() },
    })
  );

  return { currentEpoch, epochToSync, drepInfo, skipped: false };
}

/**
 * Step: Epoch totals for previous + current epoch.
 * Previous epoch totals are checkpointed; current epoch totals always refresh.
 */
export async function syncEpochTotalsStep(
  prisma: Prisma.TransactionClient
): Promise<StepEpochTotalsResult> {
  const currentEpoch = await getKoiosCurrentEpoch();
  const epochToSync = currentEpoch - 1;

  const result: StepEpochTotalsResult = {
    currentEpoch,
    epochToSync,
    skippedPrevious: false,
    currentEpochTotals: undefined as unknown as SyncEpochTotalsResult,
  };

  if (epochToSync >= 0) {
    const state = await ensureEpochCheckpoint(prisma, epochToSync);
    const requiresCompleteness = shouldRequireCompleteEpochTotals(epochToSync);

    if (state.totalsSyncedAt) {
      const hasIncomplete = await hasIncompleteEpochTotals(prisma, epochToSync);

      if (hasIncomplete) {
        result.previousEpochTotals = await syncEpochTotals(prisma, epochToSync);

        if (requiresCompleteness && !isEpochTotalsResultComplete(result.previousEpochTotals)) {
          console.warn(
            `[Epoch Totals] Previous epoch ${epochToSync} is still incomplete after retry; leaving totalsSyncedAt unchanged so it retries next run.`
          );
        } else {
          await withIngestionDbWrite(
            prisma,
            "epoch-analytics.checkpoint.mark-totals-synced",
            () =>
              prisma.epochAnalyticsSync.update({
                where: { epoch: epochToSync },
                data: { totalsSyncedAt: new Date() },
              })
          );
        }

        result.skippedPrevious = false;
      } else {
        result.skippedPrevious = true;
      }
    } else {
      result.previousEpochTotals = await syncEpochTotals(prisma, epochToSync);

      if (requiresCompleteness && !isEpochTotalsResultComplete(result.previousEpochTotals)) {
        console.warn(
          `[Epoch Totals] Previous epoch ${epochToSync} is incomplete after sync; not setting totalsSyncedAt so it retries next run.`
        );
      } else {
        await withIngestionDbWrite(prisma, "epoch-analytics.checkpoint.mark-totals-synced", () =>
          prisma.epochAnalyticsSync.update({
            where: { epoch: epochToSync },
            data: { totalsSyncedAt: new Date() },
          })
        );
      }
    }
  } else {
    result.skippedPrevious = true;
  }

  // Always refresh current epoch totals (they change throughout the epoch).
  result.currentEpochTotals = await syncEpochTotals(prisma, currentEpoch);

  return result;
}

/**
 * Step: DRep lifecycle events (registrations, deregistrations, updates).
 * Uses conditional checkpoint — only marks done if Koios returned meaningful data.
 */
export async function syncDrepLifecycleStep(
  prisma: Prisma.TransactionClient
): Promise<StepDrepLifecycleResult> {
  const currentEpoch = await getKoiosCurrentEpoch();
  const epochToSync = currentEpoch - 1;

  if (epochToSync < 0) {
    return { currentEpoch, epochToSync, skipped: true };
  }

  const state = await ensureEpochCheckpoint(prisma, epochToSync);

  if (state.drepLifecycleSyncedAt) {
    return { currentEpoch, epochToSync, skipped: true };
  }

  const drepLifecycle = await syncDrepLifecycleEvents(prisma);

  const fetchedAnyUpdates = drepLifecycle.totalUpdatesFetched > 0;
  const hadAnySuccess = drepLifecycle.drepsProcessed > 0;
  const noPerDrepFailures = drepLifecycle.failed.length === 0;

  if (
    hadAnySuccess &&
    noPerDrepFailures &&
    (drepLifecycle.eventsIngested > 0 || fetchedAnyUpdates)
  ) {
    await withIngestionDbWrite(
      prisma,
      "epoch-analytics.checkpoint.mark-drep-lifecycle-synced",
      () =>
        prisma.epochAnalyticsSync.update({
          where: { epoch: epochToSync },
          data: { drepLifecycleSyncedAt: new Date() },
        })
    );
  } else if (!noPerDrepFailures) {
    console.error(
      `[Epoch Analytics] DRep lifecycle sync had ${drepLifecycle.failed.length} failed DRep(s) for epoch ${epochToSync}; ` +
        `not marking drepLifecycleSyncedAt so the next run retries (idempotent). ` +
        `(drepsAttempted=${drepLifecycle.drepsAttempted}, drepsProcessed=${drepLifecycle.drepsProcessed}, ` +
        `updatesFetched=${drepLifecycle.totalUpdatesFetched}, eventsIngested=${drepLifecycle.eventsIngested})`
    );
  } else {
    console.error(
      `[Epoch Analytics] DRep lifecycle sync appears to have fetched 0 updates total for epoch ${epochToSync}; ` +
      `not marking drepLifecycleSyncedAt so it can retry next run. ` +
      `(drepsAttempted=${drepLifecycle.drepsAttempted}, drepsProcessed=${drepLifecycle.drepsProcessed}, ` +
      `drepsWithNoUpdates=${drepLifecycle.drepsWithNoUpdates}, updatesFetched=${drepLifecycle.totalUpdatesFetched}, ` +
      `eventsIngested=${drepLifecycle.eventsIngested}, failed=${drepLifecycle.failed.length})`
    );
  }

  return { currentEpoch, epochToSync, drepLifecycle, skipped: false };
}

/**
 * Step: Pool groups (multi-pool operator mappings).
 */
export async function syncPoolGroupsStep(
  prisma: Prisma.TransactionClient
): Promise<StepPoolGroupsResult> {
  const currentEpoch = await getKoiosCurrentEpoch();
  const epochToSync = currentEpoch - 1;

  if (epochToSync < 0) {
    return { currentEpoch, epochToSync, skipped: true };
  }

  const state = await ensureEpochCheckpoint(prisma, epochToSync);

  if (state.poolGroupsSyncedAt) {
    return { currentEpoch, epochToSync, skipped: true };
  }

  const poolGroups = await syncPoolGroups(prisma);
  await withIngestionDbWrite(
    prisma,
    "epoch-analytics.checkpoint.mark-pool-groups-synced",
    () =>
      prisma.epochAnalyticsSync.update({
        where: { epoch: epochToSync },
        data: { poolGroupsSyncedAt: new Date() },
      })
  );

  return { currentEpoch, epochToSync, poolGroups, skipped: false };
}
