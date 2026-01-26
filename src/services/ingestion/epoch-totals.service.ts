/**
 * Epoch Totals Service
 *
 * Handles epoch-level totals and denominators synchronization from Koios.
 * - syncEpochTotals: Syncs totals for a specific epoch
 * - syncMissingEpochAnalytics: Backfills missing epoch totals
 */

import type { Prisma } from "@prisma/client";
import { koiosGet } from "../koios";
import type { KoiosDrepEpochSummary, KoiosTotals } from "../../types/koios.types";
import {
  KOIOS_POOL_VP_PAGE_SIZE,
  toBigIntOrNull,
  getKoiosCurrentEpoch,
} from "./sync-utils";

// ============================================================
// Result Types
// ============================================================

export interface SyncEpochTotalsResult {
  epoch: number;
  upserted: boolean;
  circulation: bigint | null;
  treasury: bigint | null;
  supply: bigint | null;
  reserves: bigint | null;
  reward: bigint | null;
  delegatedDrepPower: bigint | null;
  totalPoolVotePower: bigint | null;
}

export interface SyncMissingEpochsResult {
  currentEpoch: number;
  startEpoch: number;
  endEpoch: number;
  totals: {
    missing: number[];
    attempted: number[];
    synced: number[];
    failed: Array<{ epoch: number; error: string }>;
  };
}

// ============================================================
// Private Helpers
// ============================================================

/**
 * Sums pool voting power for a specific epoch from Koios.
 */
async function sumPoolVotingPowerForEpoch(epochNo: number): Promise<bigint> {
  const pageSize = KOIOS_POOL_VP_PAGE_SIZE;
  let offset = 0;
  let hasMore = true;
  let total = BigInt(0);

  while (hasMore) {
    const page = await koiosGet<
      Array<{ pool_id_bech32: string; epoch_no: number; amount: string }>
    >("/pool_voting_power_history", {
      _epoch_no: epochNo,
      limit: pageSize,
      offset,
    });

    if (page && page.length > 0) {
      for (const row of page) {
        if (row?.amount) {
          try {
            total += BigInt(row.amount);
          } catch {
            // ignore parse errors
          }
        }
      }
      offset += page.length;
      hasMore = page.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return total;
}

// ============================================================
// Public API
// ============================================================

/**
 * Sync epoch denominators/totals used by analytics.
 * Stores:
 * - Koios /totals fields
 * - delegatedDrepPower from /drep_epoch_summary (stored as amount)
 * - totalPoolVotePower summed from /pool_voting_power_history
 */
export async function syncEpochTotals(
  prisma: Prisma.TransactionClient,
  epochNo: number
): Promise<SyncEpochTotalsResult> {
  const [totalsArr, drepSummaryArr, totalPoolVotePower] = await Promise.all([
    koiosGet<KoiosTotals[]>("/totals", { _epoch_no: epochNo }),
    koiosGet<KoiosDrepEpochSummary[]>("/drep_epoch_summary", { _epoch_no: epochNo }),
    sumPoolVotingPowerForEpoch(epochNo),
  ]);

  const totals = totalsArr?.[0] ?? null;
  const drepSummary = drepSummaryArr?.[0] ?? null;

  const circulation = toBigIntOrNull(totals?.circulation);
  const treasury = toBigIntOrNull(totals?.treasury);
  const reward = toBigIntOrNull(totals?.reward);
  const supply = toBigIntOrNull(totals?.supply);
  const reserves = toBigIntOrNull(totals?.reserves);
  const delegatedDrepPower = toBigIntOrNull(drepSummary?.amount);

  await prisma.epochTotals.upsert({
    where: { epoch: epochNo },
    update: {
      circulation,
      treasury,
      reward,
      supply,
      reserves,
      delegatedDrepPower,
      totalPoolVotePower,
    },
    create: {
      epoch: epochNo,
      circulation,
      treasury,
      reward,
      supply,
      reserves,
      delegatedDrepPower,
      totalPoolVotePower,
    },
  });

  return {
    epoch: epochNo,
    upserted: true,
    circulation,
    treasury,
    reward,
    supply,
    reserves,
    delegatedDrepPower,
    totalPoolVotePower,
  };
}

/**
 * Fill missing epochs for totals by comparing DB epochs to current epoch.
 */
export async function syncMissingEpochAnalytics(
  prisma: Prisma.TransactionClient
): Promise<SyncMissingEpochsResult> {
  const currentEpoch = await getKoiosCurrentEpoch();
  const endEpoch = currentEpoch - 1;

  if (endEpoch < 0) {
    return {
      currentEpoch,
      startEpoch: 0,
      endEpoch,
      totals: { missing: [], attempted: [], synced: [], failed: [] },
    };
  }

  const startEpoch = 0;
  const [totalsRows, syncStates] = await Promise.all([
    prisma.epochTotals.findMany({
      where: { epoch: { gte: startEpoch, lte: endEpoch } },
      select: { epoch: true },
    }),
    prisma.epochAnalyticsSync.findMany({
      where: { epoch: { gte: startEpoch, lte: endEpoch } },
    }),
  ]);

  const totalsSet = new Set(totalsRows.map((row) => row.epoch));
  const syncStateMap = new Map(syncStates.map((row) => [row.epoch, row]));

  const totalsMissing: number[] = [];

  for (let epoch = startEpoch; epoch <= endEpoch; epoch += 1) {
    const state = syncStateMap.get(epoch);

    if (!totalsSet.has(epoch) || !state?.totalsSyncedAt) {
      totalsMissing.push(epoch);
    }
  }

  const totalsToSync = totalsMissing;

  const totalsSynced: number[] = [];
  const totalsFailed: Array<{ epoch: number; error: string }> = [];

  for (const epoch of totalsToSync) {
    try {
      await prisma.epochAnalyticsSync.upsert({
        where: { epoch },
        update: {},
        create: { epoch },
      });
      await syncEpochTotals(prisma, epoch);
      await prisma.epochAnalyticsSync.update({
        where: { epoch },
        data: { totalsSyncedAt: new Date() },
      });
      totalsSynced.push(epoch);
    } catch (error: any) {
      totalsFailed.push({ epoch, error: error?.message ?? String(error) });
    }
  }

  return {
    currentEpoch,
    startEpoch,
    endEpoch,
    totals: {
      missing: totalsMissing,
      attempted: totalsToSync,
      synced: totalsSynced,
      failed: totalsFailed,
    },
  };
}
