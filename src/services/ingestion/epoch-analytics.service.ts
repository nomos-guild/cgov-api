/**
 * Epoch Analytics Service
 *
 * Orchestration layer for governance analytics sync jobs.
 * Re-exports functions from domain-specific services for backward compatibility.
 *
 * Domain services:
 * - drep-sync.service.ts: DRep inventory and info sync
 * - epoch-totals.service.ts: Epoch totals and missing epochs backfill
 * - delegation-sync.service.ts: Stake address delegation tracking
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

// Re-export from epoch-totals.service
export {
  syncEpochTotals,
  syncMissingEpochAnalytics,
  type SyncEpochTotalsResult,
  type SyncMissingEpochsResult,
} from "./epoch-totals.service";

// Re-export from delegation-sync.service
export {
  syncStakeAddressInventory,
  syncDrepDelegationChanges,
  type SyncStakeAddressInventoryResult,
  type SyncDrepDelegationChangesResult,
} from "./delegation-sync.service";

// Import for orchestration
import { syncAllDrepsInventory, syncAllDrepsInfo, type SyncDrepInventoryResult, type SyncDrepInfoResult } from "./drep-sync.service";
import { syncEpochTotals, type SyncEpochTotalsResult } from "./epoch-totals.service";

// ============================================================
// Orchestration Types
// ============================================================

export interface SyncGovernanceAnalyticsEpochResult {
  epoch: number;
  currentEpoch: number;
  dreps?: SyncDrepInventoryResult;
  drepInfo?: SyncDrepInfoResult;
  totals?: SyncEpochTotalsResult;
  skipped: {
    dreps: boolean;
    drepInfo: boolean;
    totals: boolean;
  };
}

// ============================================================
// Orchestration Functions
// ============================================================

/**
 * Sync governance analytics for a specific epoch.
 * Uses per-step checkpoints to avoid re-running completed work.
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
      skipped: { dreps: true, drepInfo: true, totals: true },
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

  // 3) Epoch denominators/totals
  if (!state.totalsSyncedAt) {
    res.totals = await syncEpochTotals(prisma, epochToSync);
    await prisma.epochAnalyticsSync.update({
      where: { epoch: epochToSync },
      data: { totalsSyncedAt: new Date() },
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
