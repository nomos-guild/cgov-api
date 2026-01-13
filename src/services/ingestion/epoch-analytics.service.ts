/**
 * Governance Analytics Epoch Sync Service
 *
 * Purpose:
 * - Inventory ALL DReps (not just those who voted) into the DB.
 * - Persist epoch-based denominators/totals so dashboards can be DB-first.
 * - (Optionally) snapshot DRep delegators per epoch for wallet-level KPIs.
 *
 * Koios mainnet base: https://api.koios.rest/api/v1
 */

import type { Prisma } from "@prisma/client";
import { koiosGet, koiosPost } from "../koios";
import type {
  KoiosDrepInfo,
  KoiosDrepListEntry,
  KoiosDrepDelegator,
  KoiosDrepEpochSummary,
  KoiosTotals,
  KoiosTip,
} from "../../types/koios.types";
import { processInParallel } from "./parallel";

export interface SyncDrepInventoryResult {
  koiosTotal: number;
  existingInDb: number;
  created: number;
  updatedFromInfo: number;
  failedInfoBatches: number;
}

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

export interface SyncDelegatorSnapshotResult {
  epoch: number;
  drepsProcessed: number;
  rowsInserted: number;
  failed: Array<{ drepId: string; error: string }>;
}

export interface SyncGovernanceAnalyticsEpochResult {
  epoch: number;
  currentEpoch: number;
  dreps?: SyncDrepInventoryResult;
  totals?: SyncEpochTotalsResult;
  delegators?: SyncDelegatorSnapshotResult;
  skipped: {
    dreps: boolean;
    totals: boolean;
    delegators: boolean;
  };
}

function parseEnvInt(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toBigIntOrNull(value: string | null | undefined): bigint | null {
  if (value == null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

async function getKoiosCurrentEpoch(): Promise<number> {
  const tip = await koiosGet<KoiosTip[]>("/tip");
  return tip?.[0]?.epoch_no ?? 0;
}

async function fetchAllKoiosDrepIds(): Promise<string[]> {
  const pageSize = parseEnvInt("KOIOS_DREP_LIST_PAGE_SIZE", 1000, 100, 2000);
  let offset = 0;
  let hasMore = true;
  const ids: string[] = [];

  while (hasMore) {
    const page = await koiosGet<KoiosDrepListEntry[]>("/drep_list", {
      limit: pageSize,
      offset,
    });

    if (page && page.length > 0) {
      for (const row of page) {
        if (row?.drep_id) ids.push(row.drep_id);
      }
      offset += page.length;
      hasMore = page.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return ids;
}

/**
 * Inventory all DReps from Koios into the DB (creates missing rows).
 * Then bulk-refreshes DRep fields from Koios POST /drep_info for the new IDs.
 */
export async function syncAllDrepsInventory(
  prisma: Prisma.TransactionClient
): Promise<SyncDrepInventoryResult> {
  const koiosIds = await fetchAllKoiosDrepIds();

  // Snapshot existing DReps
  const existing = await prisma.drep.findMany({ select: { drepId: true } });
  const existingSet = new Set(existing.map((d) => d.drepId));

  const missing = koiosIds.filter((id) => !existingSet.has(id));

  let created = 0;
  if (missing.length > 0) {
    const createManyResult = await prisma.drep.createMany({
      data: missing.map((drepId) => ({
        drepId,
        // votingPower defaulted to 0 in schema, but set explicitly for clarity
        votingPower: BigInt(0),
      })),
      skipDuplicates: true,
    });
    created = createManyResult.count;
  }

  // Bulk update (only for the missing IDs we just created).
  // This avoids hammering Koios for all existing DReps every epoch.
  const batchSize = parseEnvInt("KOIOS_DREP_INFO_BATCH_SIZE", 50, 10, 200);
  let updatedFromInfo = 0;
  let failedInfoBatches = 0;

  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    try {
      const infos = await koiosPost<KoiosDrepInfo[]>("/drep_info", {
        _drep_ids: batch,
      });

      if (!Array.isArray(infos)) {
        failedInfoBatches++;
        continue;
      }

      for (const info of infos) {
        if (!info?.drep_id) continue;

        await prisma.drep.update({
          where: { drepId: info.drep_id },
          data: {
            votingPower: toBigIntOrNull(info.amount) ?? BigInt(0),
            registered: info.registered ?? undefined,
            active: info.active ?? undefined,
            expiresEpoch: info.expires_epoch_no ?? undefined,
            metaUrl: info.meta_url ?? undefined,
            metaHash: info.meta_hash ?? undefined,
          },
        });
        updatedFromInfo++;
      }
    } catch {
      failedInfoBatches++;
    }
  }

  return {
    koiosTotal: koiosIds.length,
    existingInDb: existing.length,
    created,
    updatedFromInfo,
    failedInfoBatches,
  };
}

async function sumPoolVotingPowerForEpoch(epochNo: number): Promise<bigint> {
  const pageSize = parseEnvInt("KOIOS_POOL_VP_PAGE_SIZE", 1000, 100, 2000);
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

async function fetchDelegatorsForDrep(drepId: string): Promise<KoiosDrepDelegator[]> {
  const pageSize = parseEnvInt("KOIOS_DREP_DELEGATORS_PAGE_SIZE", 1000, 100, 2000);
  let offset = 0;
  let hasMore = true;
  const rows: KoiosDrepDelegator[] = [];

  while (hasMore) {
    const page = await koiosGet<KoiosDrepDelegator[]>("/drep_delegators", {
      _drep_id: drepId,
      limit: pageSize,
      offset,
    });

    if (page && page.length > 0) {
      rows.push(...page);
      offset += page.length;
      hasMore = page.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return rows;
}

/**
 * Snapshot DRep delegators for an epoch.
 *
 * This can be very heavy; control via env:
 * - ENABLE_DREP_DELEGATOR_SNAPSHOT_SYNC (default: true)
 * - DREP_DELEGATOR_SYNC_CONCURRENCY (default: 2)
 */
export async function syncDrepDelegatorSnapshots(
  prisma: Prisma.TransactionClient,
  epochNo: number
): Promise<SyncDelegatorSnapshotResult> {
  const dreps = await prisma.drep.findMany({ select: { drepId: true } });

  if (dreps.length === 0) {
    return { epoch: epochNo, drepsProcessed: 0, rowsInserted: 0, failed: [] };
  }

  const concurrency = parseEnvInt("DREP_DELEGATOR_SYNC_CONCURRENCY", 2, 1, 5);
  const insertChunkSize = parseEnvInt("DREP_DELEGATOR_INSERT_CHUNK_SIZE", 1000, 200, 5000);

  let rowsInserted = 0;

  const result = await processInParallel(
    dreps,
    (d) => d.drepId,
    async (d) => {
      const delegators = await fetchDelegatorsForDrep(d.drepId);

      if (!delegators || delegators.length === 0) {
        return 0;
      }

      // Insert in chunks to keep query payloads reasonable.
      for (let i = 0; i < delegators.length; i += insertChunkSize) {
        const chunk = delegators.slice(i, i + insertChunkSize);
        const data = chunk
          .filter((row) => row?.stake_address && row?.amount)
          .map((row) => ({
            epoch: epochNo,
            drepId: d.drepId,
            stakeAddress: row.stake_address,
            amount: BigInt(row.amount),
          }));

        if (data.length === 0) continue;

        const inserted = await prisma.drepDelegatorSnapshot.createMany({
          data,
          skipDuplicates: true,
        });
        rowsInserted += inserted.count;
      }

      return delegators.length;
    },
    concurrency
  );

  return {
    epoch: epochNo,
    drepsProcessed: result.successful.length + result.failed.length,
    rowsInserted,
    failed: result.failed.map((f) => ({ drepId: f.id, error: f.error })),
  };
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

  if (epochToSync < 0) {
    return {
      epoch: epochToSync,
      currentEpoch,
      skipped: { dreps: true, totals: true, delegators: true },
    };
  }

  // Ensure a per-epoch sync state row exists.
  const state = await prisma.epochAnalyticsSync.upsert({
    where: { epoch: epochToSync },
    update: {},
    create: { epoch: epochToSync },
  });

  const enableDelegators =
    (process.env.ENABLE_DREP_DELEGATOR_SNAPSHOT_SYNC ?? "false").toLowerCase() !==
    "false";

  const res: SyncGovernanceAnalyticsEpochResult = {
    epoch: epochToSync,
    currentEpoch,
    skipped: {
      dreps: !!state.drepsSyncedAt,
      totals: !!state.totalsSyncedAt,
      delegators: !!state.delegatorsSyncedAt || !enableDelegators,
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

  // 2) Epoch denominators/totals
  if (!state.totalsSyncedAt) {
    res.totals = await syncEpochTotals(prisma, epochToSync);
    await prisma.epochAnalyticsSync.update({
      where: { epoch: epochToSync },
      data: { totalsSyncedAt: new Date() },
    });
  }

  // 3) Delegator snapshot (optional; very heavy)
  if (enableDelegators && !state.delegatorsSyncedAt) {
    res.delegators = await syncDrepDelegatorSnapshots(prisma, epochToSync);
    await prisma.epochAnalyticsSync.update({
      where: { epoch: epochToSync },
      data: { delegatorsSyncedAt: new Date() },
    });
  }

  return res;
}

