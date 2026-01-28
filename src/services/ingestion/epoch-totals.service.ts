/**
 * Epoch Totals Service
 *
 * Handles epoch-level totals, denominators, and timestamps synchronization from Koios.
 * - syncEpochTotals: Syncs totals + timestamps for a specific epoch
 * - syncMissingEpochAnalytics: Backfills missing epoch totals
 *
 * Includes epoch timestamps from /epoch_info for wall-clock calculations
 * (enables Time-to-Enactment KPI in calendar time).
 */

import type { Prisma } from "@prisma/client";
import { koiosGet } from "../koios";
import type { KoiosDrepEpochSummary, KoiosTotals, KoiosEpochInfo } from "../../types/koios.types";
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
  // Epoch timestamps
  startTime: Date | null;
  endTime: Date | null;
  blockCount: number | null;
  txCount: number | null;
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
// Private Helpers - Timestamp conversion
// ============================================================

/**
 * Converts Unix timestamp to Date, or returns null if invalid
 */
function unixToDate(timestamp: number | null | undefined): Date | null {
  if (timestamp == null || timestamp <= 0) return null;
  return new Date(timestamp * 1000);
}

// ============================================================
// Public API
// ============================================================

/**
 * Sync epoch denominators/totals used by analytics.
 * Stores:
 * - Koios /totals fields (circulation, treasury, supply, reserves, reward)
 * - delegatedDrepPower from /drep_epoch_summary
 * - totalPoolVotePower summed from /pool_voting_power_history
 * - Epoch timestamps from /epoch_info (start_time, end_time, block_count, tx_count)
 */
export async function syncEpochTotals(
  prisma: Prisma.TransactionClient,
  epochNo: number
): Promise<SyncEpochTotalsResult> {
  const [totalsArr, drepSummaryArr, epochInfoArr, totalPoolVotePower] = await Promise.all([
    koiosGet<KoiosTotals[]>("/totals", { _epoch_no: epochNo }),
    koiosGet<KoiosDrepEpochSummary[]>("/drep_epoch_summary", { _epoch_no: epochNo }),
    koiosGet<KoiosEpochInfo[]>("/epoch_info", { _epoch_no: epochNo }),
    sumPoolVotingPowerForEpoch(epochNo),
  ]);

  const totals = totalsArr?.[0] ?? null;
  const drepSummary = drepSummaryArr?.[0] ?? null;
  const epochInfo = epochInfoArr?.[0] ?? null;

  // Financial totals
  const circulation = toBigIntOrNull(totals?.circulation);
  const treasury = toBigIntOrNull(totals?.treasury);
  const reward = toBigIntOrNull(totals?.reward);
  const supply = toBigIntOrNull(totals?.supply);
  const reserves = toBigIntOrNull(totals?.reserves);
  const delegatedDrepPower = toBigIntOrNull(drepSummary?.amount);

  // Epoch timestamps
  const startTime = unixToDate(epochInfo?.start_time);
  const endTime = unixToDate(epochInfo?.end_time);
  const firstBlockTime = epochInfo?.first_block_time ?? null;
  const lastBlockTime = epochInfo?.last_block_time ?? null;
  const blockCount = epochInfo?.blk_count ?? null;
  const txCount = epochInfo?.tx_count ?? null;

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
      startTime,
      endTime,
      firstBlockTime,
      lastBlockTime,
      blockCount,
      txCount,
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
      startTime,
      endTime,
      firstBlockTime,
      lastBlockTime,
      blockCount,
      txCount,
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
    startTime,
    endTime,
    blockCount,
    txCount,
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

// ============================================================
// Epoch Timestamp Utilities
// ============================================================

/**
 * Gets epoch timestamps for a list of epochs.
 * Useful for converting epoch numbers to dates in analytics queries.
 */
export async function getEpochTimestamps(
  prisma: Prisma.TransactionClient,
  epochNumbers: number[]
): Promise<Map<number, { startTime: Date; endTime: Date }>> {
  const rows = await prisma.epochTotals.findMany({
    where: { epoch: { in: epochNumbers } },
    select: { epoch: true, startTime: true, endTime: true },
  });

  const result = new Map<number, { startTime: Date; endTime: Date }>();
  for (const row of rows) {
    if (row.startTime && row.endTime) {
      result.set(row.epoch, {
        startTime: row.startTime,
        endTime: row.endTime,
      });
    }
  }

  return result;
}

/**
 * Calculates wall-clock duration between two epochs.
 * Returns null if epoch timestamps are not available for either epoch.
 */
export async function getEpochDuration(
  prisma: Prisma.TransactionClient,
  startEpoch: number,
  endEpoch: number
): Promise<{
  durationMs: number;
  durationDays: number;
  startTime: Date;
  endTime: Date;
} | null> {
  const timestamps = await getEpochTimestamps(prisma, [startEpoch, endEpoch]);

  const start = timestamps.get(startEpoch);
  const end = timestamps.get(endEpoch);

  if (!start || !end) {
    return null;
  }

  // Duration from start of startEpoch to end of endEpoch
  const durationMs = end.endTime.getTime() - start.startTime.getTime();
  const durationDays = durationMs / (1000 * 60 * 60 * 24);

  return {
    durationMs,
    durationDays,
    startTime: start.startTime,
    endTime: end.endTime,
  };
}
