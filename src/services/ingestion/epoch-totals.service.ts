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
import {
  getAllPoolVotingPowerHistoryForEpoch,
  getDrepEpochSummary,
  getEpochInfo,
  getTotalsForEpoch,
  listAllDrepDelegators,
  listDrepVotingPowerHistory,
} from "../governanceProvider";
import {
  toBigIntOrNull,
  getKoiosCurrentEpoch,
  EPOCH_TOTALS_BACKFILL_CONCURRENCY,
} from "./sync-utils";
import { withIngestionDbWrite } from "./dbSession";
import { processInParallel } from "./parallel";

const KOIOS_HEAVY_DREP_DELEGATORS_LANE_JOB_NAME =
  "koios-heavy-drep-delegators-lane";
const SPECIAL_DREP_DELEGATORS_GUARD_ENABLED =
  process.env.EPOCH_TOTALS_DEFER_SPECIAL_DREP_DELEGATORS_WHEN_LANE_BUSY !==
  "false";

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
  // Special DReps (we compute these as per-epoch aggregates without storing stake addresses)
  drepAlwaysNoConfidenceDelegatorCount: number | null;
  drepAlwaysNoConfidenceVotingPower: bigint | null;
  drepAlwaysAbstainDelegatorCount: number | null;
  drepAlwaysAbstainVotingPower: bigint | null;
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

export type SyncMissingEpochAnalyticsMode = "missing" | "all";

export interface SyncMissingEpochAnalyticsOptions {
  /** Inclusive lower bound (default 0). Clamped to >= 0. */
  startEpoch?: number;
  /** Inclusive upper bound for closed epochs (default currentEpoch - 1). Clamped to <= currentEpoch - 1. */
  endEpoch?: number;
  /** `missing`: only epochs without rows, checkpoint, or incomplete (after508). `all`: every epoch in range. */
  mode?: SyncMissingEpochAnalyticsMode;
}

export const EPOCH_TOTALS_SELF_HEALING_AFTER_EPOCH = 508;

const EPOCH_TOTALS_NULL_FIELD_FILTER: Prisma.EpochTotalsWhereInput[] = [
  { circulation: null },
  { treasury: null },
  { reward: null },
  { supply: null },
  { reserves: null },
  { delegatedDrepPower: null },
  { totalPoolVotePower: null },
  { drepAlwaysNoConfidenceDelegatorCount: null },
  { drepAlwaysNoConfidenceVotingPower: null },
  { drepAlwaysAbstainDelegatorCount: null },
  { drepAlwaysAbstainVotingPower: null },
  { startTime: null },
  { endTime: null },
  { firstBlockTime: null },
  { lastBlockTime: null },
  { blockCount: null },
  { txCount: null },
];

export function shouldRequireCompleteEpochTotals(epochNo: number): boolean {
  return epochNo > EPOCH_TOTALS_SELF_HEALING_AFTER_EPOCH;
}

export function isEpochTotalsResultComplete(
  totals: SyncEpochTotalsResult
): boolean {
  return (
    totals.circulation != null &&
    totals.treasury != null &&
    totals.reward != null &&
    totals.supply != null &&
    totals.reserves != null &&
    totals.delegatedDrepPower != null &&
    totals.totalPoolVotePower != null &&
    totals.drepAlwaysNoConfidenceDelegatorCount != null &&
    totals.drepAlwaysNoConfidenceVotingPower != null &&
    totals.drepAlwaysAbstainDelegatorCount != null &&
    totals.drepAlwaysAbstainVotingPower != null &&
    totals.startTime != null &&
    totals.endTime != null &&
    totals.blockCount != null &&
    totals.txCount != null
  );
}

export async function hasIncompleteEpochTotals(
  prisma: Prisma.TransactionClient,
  epochNo: number
): Promise<boolean> {
  if (!shouldRequireCompleteEpochTotals(epochNo)) {
    return false;
  }

  const row = await prisma.epochTotals.findFirst({
    where: {
      epoch: epochNo,
      OR: EPOCH_TOTALS_NULL_FIELD_FILTER,
    },
    select: { epoch: true },
  });

  return !!row;
}

// ============================================================
// Private Helpers
// ============================================================

/**
 * Sums pool voting power for a specific epoch from Koios.
 */
async function sumPoolVotingPowerForEpoch(epochNo: number): Promise<bigint> {
  const rows = await getAllPoolVotingPowerHistoryForEpoch({
    epochNo,
    source: "ingestion.epoch-totals.pool-voting-power",
  });

  let total = BigInt(0);
  // Dedupe by pool_id_bech32: koiosGetAll uses ORDER BY pool_id_bech32.asc when
  // available, but guard against any server-side duplicates across page boundaries.
  const seenPoolIds = new Set<string>();

  for (const row of rows) {
    // Defensive: if the epoch filter is ignored/unsupported, only sum the target epoch.
    if (row?.epoch_no !== epochNo) continue;

    const poolId = row?.pool_id_bech32;
    if (typeof poolId === "string" && poolId) {
      if (seenPoolIds.has(poolId)) continue;
      seenPoolIds.add(poolId);
    }

    if (row?.amount) {
      try {
        total += BigInt(row.amount);
      } catch {
        // ignore parse errors
      }
    }
  }

  return total;
}

/**
 * Computes delegator count + total voting power for a DRep for delegations
 * that were made in a specific epoch, by paging through /drep_delegators.
 *
 * Important: we intentionally do NOT persist stake addresses for these special DReps,
 * to avoid ballooning the stake address inventory.
 */
async function getDrepDelegatorAggregatesForEpoch(
  prisma: Prisma.TransactionClient,
  epochNo: number,
  drepId: string
): Promise<{ delegatorCount: number | null; votingPower: bigint }> {
  if (SPECIAL_DREP_DELEGATORS_GUARD_ENABLED) {
    const laneStatus = await (prisma as Prisma.TransactionClient & {
      syncStatus: any;
    }).syncStatus.findUnique({
      where: { jobName: KOIOS_HEAVY_DREP_DELEGATORS_LANE_JOB_NAME },
      select: { isRunning: true },
    });
    if (laneStatus?.isRunning) {
      console.log(
        `[Epoch Totals] Skipping special DRep /drep_delegators fetch for ${drepId} (shared heavy lane busy)`
      );
      return { delegatorCount: null, votingPower: BigInt(0) };
    }
  }

  // We intentionally do not retain stake addresses in memory; we only aggregate.
  // Koios /drep_delegators is expected to return one row per stake address.
  // `epoch_no` here represents the epoch when the vote delegation was made
  // (per Koios OpenAPI schema), so we filter on epoch_no=eq.<epoch>.
  let delegatorCount = 0;

  const rows = await listAllDrepDelegators({
    drepId,
    epochNo,
    source: "ingestion.epoch-totals.special-drep-delegators",
  });

  for (const row of rows) {
    const stakeAddress = row?.stake_address;
    if (typeof stakeAddress === "string" && stakeAddress) {
      delegatorCount += 1;
    }
  }

  // Voting power should be sourced from /drep_voting_power_history, not summed here.
  return { delegatorCount, votingPower: BigInt(0) };
}

async function getDrepVotingPowerForEpoch(
  epochNo: number,
  drepId: string
): Promise<bigint> {
  const history = await listDrepVotingPowerHistory({
    epochNo,
    drepId,
    source: "ingestion.epoch-totals.special-drep-voting-power",
  });
  const lovelace = history?.[0]?.amount;
  return lovelace ? BigInt(lovelace) : BigInt(0);
}

async function getSpecialDrepAggregatesForEpoch(
  prisma: Prisma.TransactionClient,
  epochNo: number,
  drepId: string
): Promise<{ delegatorCount: number | null; votingPower: bigint | null }> {
  try {
    // Delegator count is "delegations made in epoch" (from /drep_delegators + epoch_no filter).
    // Voting power is the DRep's epoch voting power snapshot (from /drep_voting_power_history).
    const [delegatorAgg, votingPower] = await Promise.all([
      getDrepDelegatorAggregatesForEpoch(prisma, epochNo, drepId),
      getDrepVotingPowerForEpoch(epochNo, drepId),
    ]);
    return { delegatorCount: delegatorAgg.delegatorCount, votingPower };
  } catch (error: any) {
    const status = error?.response?.status as number | undefined;
    // These aggregates are nice-to-have; we should not fail the entire epoch sync
    // if Koios rejects the query (404) or times out (504).
    console.warn(
      `[Epoch Totals] Failed to fetch special DRep aggregates for drepId=${drepId} epoch=${epochNo} status=${status ?? "unknown"}: ${error?.message ?? String(error)}`
    );
    return { delegatorCount: null, votingPower: null };
  }
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

function areDatesEqual(a: Date | null, b: Date | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.getTime() === b.getTime();
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
  const [
    totals,
    drepSummary,
    epochInfo,
    totalPoolVotePower,
    drepAlwaysAbstainAgg,
    drepAlwaysNoConfidenceAgg,
  ] = await Promise.all([
    getTotalsForEpoch(epochNo, {
      source: "ingestion.epoch-totals.fetch-row./totals",
    }),
    getDrepEpochSummary(epochNo, {
      source: "ingestion.epoch-totals.fetch-row./drep_epoch_summary",
    }),
    getEpochInfo(epochNo, {
      source: "ingestion.epoch-totals.fetch-row./epoch_info",
    }),
    sumPoolVotingPowerForEpoch(epochNo),
    getSpecialDrepAggregatesForEpoch(
      prisma,
      epochNo,
      "drep_always_abstain"
    ),
    getSpecialDrepAggregatesForEpoch(
      prisma,
      epochNo,
      "drep_always_no_confidence"
    ),
  ]);

  // Financial totals
  const circulation = toBigIntOrNull(totals?.circulation);
  const treasury = toBigIntOrNull(totals?.treasury);
  const reward = toBigIntOrNull(totals?.reward);
  const supply = toBigIntOrNull(totals?.supply);
  const reserves = toBigIntOrNull(totals?.reserves);
  const delegatedDrepPower = toBigIntOrNull(drepSummary?.amount);

  // Special DReps (aggregated)
  const drepAlwaysAbstainDelegatorCount = drepAlwaysAbstainAgg.delegatorCount;
  const drepAlwaysAbstainVotingPower = drepAlwaysAbstainAgg.votingPower;
  const drepAlwaysNoConfidenceDelegatorCount =
    drepAlwaysNoConfidenceAgg.delegatorCount;
  const drepAlwaysNoConfidenceVotingPower = drepAlwaysNoConfidenceAgg.votingPower;

  // Epoch timestamps
  const startTime = unixToDate(epochInfo?.start_time);
  const endTime = unixToDate(epochInfo?.end_time);
  const firstBlockTime = epochInfo?.first_block_time ?? null;
  const lastBlockTime = epochInfo?.last_block_time ?? null;
  const blockCount = epochInfo?.blk_count ?? null;
  const txCount = epochInfo?.tx_count ?? null;

  const payload = {
    circulation,
    treasury,
    reward,
    supply,
    reserves,
    delegatedDrepPower,
    totalPoolVotePower,
    drepAlwaysNoConfidenceDelegatorCount,
    drepAlwaysNoConfidenceVotingPower,
    drepAlwaysAbstainDelegatorCount,
    drepAlwaysAbstainVotingPower,
    startTime,
    endTime,
    firstBlockTime,
    lastBlockTime,
    blockCount,
    txCount,
  };
  const existing = await prisma.epochTotals.findUnique({
    where: { epoch: epochNo },
    select: {
      circulation: true,
      treasury: true,
      reward: true,
      supply: true,
      reserves: true,
      delegatedDrepPower: true,
      totalPoolVotePower: true,
      drepAlwaysNoConfidenceDelegatorCount: true,
      drepAlwaysNoConfidenceVotingPower: true,
      drepAlwaysAbstainDelegatorCount: true,
      drepAlwaysAbstainVotingPower: true,
      startTime: true,
      endTime: true,
      firstBlockTime: true,
      lastBlockTime: true,
      blockCount: true,
      txCount: true,
    },
  });

  if (!existing) {
    await withIngestionDbWrite(prisma, "epoch-totals.row.create", () =>
      prisma.epochTotals.create({
        data: {
          epoch: epochNo,
          ...payload,
        },
      })
    );
    console.log(`[Epoch Totals] epoch=${epochNo} action=create`);
  } else {
    const changed =
      existing.circulation !== payload.circulation ||
      existing.treasury !== payload.treasury ||
      existing.reward !== payload.reward ||
      existing.supply !== payload.supply ||
      existing.reserves !== payload.reserves ||
      existing.delegatedDrepPower !== payload.delegatedDrepPower ||
      existing.totalPoolVotePower !== payload.totalPoolVotePower ||
      existing.drepAlwaysNoConfidenceDelegatorCount !==
        payload.drepAlwaysNoConfidenceDelegatorCount ||
      existing.drepAlwaysNoConfidenceVotingPower !==
        payload.drepAlwaysNoConfidenceVotingPower ||
      existing.drepAlwaysAbstainDelegatorCount !==
        payload.drepAlwaysAbstainDelegatorCount ||
      existing.drepAlwaysAbstainVotingPower !==
        payload.drepAlwaysAbstainVotingPower ||
      !areDatesEqual(existing.startTime, payload.startTime) ||
      !areDatesEqual(existing.endTime, payload.endTime) ||
      existing.firstBlockTime !== payload.firstBlockTime ||
      existing.lastBlockTime !== payload.lastBlockTime ||
      existing.blockCount !== payload.blockCount ||
      existing.txCount !== payload.txCount;

    if (changed) {
      await withIngestionDbWrite(prisma, "epoch-totals.row.update", () =>
        prisma.epochTotals.update({
          where: { epoch: epochNo },
          data: payload,
        })
      );
      console.log(`[Epoch Totals] epoch=${epochNo} action=update`);
    } else {
      console.log(
        `[Epoch Totals] epoch=${epochNo} action=skip-unchanged`
      );
    }
  }

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
    drepAlwaysNoConfidenceDelegatorCount,
    drepAlwaysNoConfidenceVotingPower,
    drepAlwaysAbstainDelegatorCount,
    drepAlwaysAbstainVotingPower,
    startTime,
    endTime,
    blockCount,
    txCount,
  };
}

/**
 * Fill missing epochs for totals by comparing DB epochs to current epoch.
 * Pass `options.mode: "all"` to resync every epoch in the resolved range (e.g. after a truncate).
 */
export async function syncMissingEpochAnalytics(
  prisma: Prisma.TransactionClient,
  options?: SyncMissingEpochAnalyticsOptions
): Promise<SyncMissingEpochsResult> {
  const currentEpoch = await getKoiosCurrentEpoch();
  const maxClosed = currentEpoch - 1;

  const rangeStart = Math.max(0, options?.startEpoch ?? 0);
  const rangeEnd = Math.min(
    options?.endEpoch !== undefined ? options.endEpoch : maxClosed,
    maxClosed
  );

  if (maxClosed < 0) {
    return {
      currentEpoch,
      startEpoch: rangeStart,
      endEpoch: maxClosed,
      totals: { missing: [], attempted: [], synced: [], failed: [] },
    };
  }

  if (rangeStart > rangeEnd) {
    return {
      currentEpoch,
      startEpoch: rangeStart,
      endEpoch: rangeEnd,
      totals: { missing: [], attempted: [], synced: [], failed: [] },
    };
  }

  const mode: SyncMissingEpochAnalyticsMode = options?.mode ?? "missing";

  let totalsMissing: number[];

  if (mode === "all") {
    totalsMissing = [];
    for (let epoch = rangeStart; epoch <= rangeEnd; epoch += 1) {
      totalsMissing.push(epoch);
    }
  } else {
    const [totalsRows, syncStates, incompleteTotalsRows] = await Promise.all([
      prisma.epochTotals.findMany({
        where: { epoch: { gte: rangeStart, lte: rangeEnd } },
        select: { epoch: true },
      }),
      prisma.epochAnalyticsSync.findMany({
        where: { epoch: { gte: rangeStart, lte: rangeEnd } },
      }),
      prisma.epochTotals.findMany({
        where: {
          epoch: {
            gt: EPOCH_TOTALS_SELF_HEALING_AFTER_EPOCH,
            gte: rangeStart,
            lte: rangeEnd,
          },
          OR: EPOCH_TOTALS_NULL_FIELD_FILTER,
        },
        select: { epoch: true },
      }),
    ]);

    const totalsSet = new Set(totalsRows.map((row) => row.epoch));
    const syncStateMap = new Map(syncStates.map((row) => [row.epoch, row]));
    const incompleteSet = new Set(incompleteTotalsRows.map((row) => row.epoch));

    totalsMissing = [];
    for (let epoch = rangeStart; epoch <= rangeEnd; epoch += 1) {
      const state = syncStateMap.get(epoch);

      if (
        !totalsSet.has(epoch) ||
        !state?.totalsSyncedAt ||
        incompleteSet.has(epoch)
      ) {
        totalsMissing.push(epoch);
      }
    }
  }

  const totalsToSync = totalsMissing;

  const totalsSynced: number[] = [];
  const totalsFailed: Array<{ epoch: number; error: string }> = [];

  const syncResult = await processInParallel(
    totalsToSync,
    (epoch) => `${epoch}`,
    async (epoch) => {
      await withIngestionDbWrite(prisma, "epoch-totals.checkpoint.upsert", () =>
        prisma.epochAnalyticsSync.upsert({
          where: { epoch },
          update: {},
          create: { epoch },
        })
      );

      const totals = await syncEpochTotals(prisma, epoch);

      if (
        shouldRequireCompleteEpochTotals(epoch) &&
        !isEpochTotalsResultComplete(totals)
      ) {
        throw new Error(
          `Epoch ${epoch} totals still incomplete after sync (one or more required fields are null)`
        );
      }

      await withIngestionDbWrite(
        prisma,
        "epoch-totals.checkpoint.mark-totals-synced",
        () =>
          prisma.epochAnalyticsSync.update({
            where: { epoch },
            data: { totalsSyncedAt: new Date() },
          })
      );
      return epoch;
    },
    EPOCH_TOTALS_BACKFILL_CONCURRENCY
  );

  totalsSynced.push(...syncResult.successful);
  for (const failed of syncResult.failed) {
    totalsFailed.push({
      epoch: Number.parseInt(failed.id, 10),
      error: failed.error,
    });
  }

  return {
    currentEpoch,
    startEpoch: rangeStart,
    endEpoch: rangeEnd,
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
