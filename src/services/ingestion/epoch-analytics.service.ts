/**
 * Governance Analytics Epoch Sync Service
 *
 * Purpose:
 * - Inventory ALL DReps (not just those who voted) into the DB.
 * - Persist epoch-based denominators/totals so dashboards can be DB-first.
 * - Track stake address delegation changes (not per-epoch snapshots)
 *   so DRep delegator views can be derived from current state + change log.
 *
 * Koios mainnet base: https://api.koios.rest/api/v1
 */

import type { Prisma } from "@prisma/client";
import { koiosGet, koiosPost } from "../koios";
import type {
  KoiosAccountListEntry,
  KoiosDrepInfo,
  KoiosDrepListEntry,
  KoiosDrepDelegator,
  KoiosAccountUpdateHistoryEntry,
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

export interface SyncGovernanceAnalyticsEpochResult {
  epoch: number;
  currentEpoch: number;
  dreps?: SyncDrepInventoryResult;
  totals?: SyncEpochTotalsResult;
  skipped: {
    dreps: boolean;
    totals: boolean;
  };
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

export interface SyncStakeAddressInventoryResult {
  totalFetched: number;
  created: number;
}

export interface SyncDrepDelegationChangesResult {
  currentEpoch: number;
  lastProcessedEpoch: number;
  maxDelegationEpoch: number;
  drepsProcessed: number;
  delegatorsProcessed: number;
  statesUpdated: number;
  changesInserted: number;
  failed: Array<{ drepId: string; error: string }>;
}

const KOIOS_DREP_LIST_PAGE_SIZE = 1000;
const KOIOS_DREP_INFO_BATCH_SIZE = 50;
const KOIOS_POOL_VP_PAGE_SIZE = 1000;
const KOIOS_DREP_DELEGATORS_PAGE_SIZE = 1000;
const KOIOS_ACCOUNT_LIST_PAGE_SIZE = 1000;
const KOIOS_ACCOUNT_UPDATE_HISTORY_BATCH_SIZE = 10;
const DREP_DELEGATOR_MIN_VOTING_POWER = BigInt(0);
const DREP_DELEGATION_SYNC_CONCURRENCY = 2;
const STAKE_DELEGATION_SYNC_STATE_ID = "current";
const DREP_DELEGATION_BACKFILL_JOB_NAME = "drep-delegation-backfill";

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
  const pageSize = KOIOS_DREP_LIST_PAGE_SIZE;
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
  const batchSize = KOIOS_DREP_INFO_BATCH_SIZE;
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
  const pageSize = KOIOS_DREP_DELEGATORS_PAGE_SIZE;
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

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function extractDelegatedDrepId(entry: KoiosAccountUpdateHistoryEntry): string | null {
  return (
    entry.delegated_drep ??
    entry.drep_id ??
    entry.drep ??
    entry.info?.delegated_drep ??
    entry.info?.drep_id ??
    entry.info?.drep ??
    null
  );
}

function sortAccountUpdates(
  entries: KoiosAccountUpdateHistoryEntry[]
): KoiosAccountUpdateHistoryEntry[] {
  return [...entries].sort((a, b) => {
    const epochA = a.epoch_no ?? -1;
    const epochB = b.epoch_no ?? -1;
    if (epochA !== epochB) return epochA - epochB;
    const slotA = a.epoch_slot ?? -1;
    const slotB = b.epoch_slot ?? -1;
    if (slotA !== slotB) return slotA - slotB;
    const absA = a.absolute_slot ?? -1;
    const absB = b.absolute_slot ?? -1;
    if (absA !== absB) return absA - absB;
    const timeA = a.block_time ?? -1;
    const timeB = b.block_time ?? -1;
    return timeA - timeB;
  });
}

function buildDrepChangeLogForStake(
  stakeAddress: string,
  stakeEntries: KoiosAccountUpdateHistoryEntry[]
): {
  changes: Array<{
    stakeAddress: string;
    fromDrepId: string | null;
    toDrepId: string;
    delegatedEpoch: number | null;
    amount: bigint | null;
  }>;
  latest: { drepId: string; epochNo: number | null } | null;
} {
  const changes: Array<{
    stakeAddress: string;
    fromDrepId: string | null;
    toDrepId: string;
    delegatedEpoch: number | null;
    amount: bigint | null;
  }> = [];

  let lastDrepId: string | null = null;
  let lastEpoch: number | null = null;
  const sorted = sortAccountUpdates(stakeEntries);
  for (const entry of sorted) {
    if (!entry?.action_type?.includes("delegation_drep")) continue;
    const drepId = extractDelegatedDrepId(entry);
    if (!drepId || drepId === lastDrepId) continue;
    const delegatedEpoch =
      typeof entry.epoch_no === "number" ? entry.epoch_no : null;
    changes.push({
      stakeAddress,
      fromDrepId: lastDrepId,
      toDrepId: drepId,
      delegatedEpoch,
      amount: null,
    });
    lastDrepId = drepId;
    lastEpoch = delegatedEpoch;
  }

  return {
    changes,
    latest: lastDrepId ? { drepId: lastDrepId, epochNo: lastEpoch } : null,
  };
}

async function fetchAccountUpdateHistory(
  stakeAddresses: string[]
): Promise<KoiosAccountUpdateHistoryEntry[]> {
  if (stakeAddresses.length === 0) return [];
  const response = await koiosPost<KoiosAccountUpdateHistoryEntry[]>(
    "/account_update_history",
    { _stake_addresses: stakeAddresses }
  );
  return Array.isArray(response) ? response : [];
}

async function backfillStakeDelegationHistory(
  prisma: Prisma.TransactionClient,
  stakeAddresses: string[],
  options?: { jobName?: string; displayName?: string }
): Promise<{
  changesInserted: number;
  latestByStake: Map<string, { drepId: string; epochNo: number | null }>;
}> {
  if (stakeAddresses.length === 0) {
    return { changesInserted: 0, latestByStake: new Map() };
  }

  const statusClient = prisma as Prisma.TransactionClient & {
    syncStatus: any;
    stakeDelegationChange: any;
  };

  const latestByStake = new Map<string, { drepId: string; epochNo: number | null }>();
  let changesInserted = 0;

  let cursor: string | null = null;
  let processed = 0;
  let remainingAddresses = [...stakeAddresses].sort();
  const now = new Date();

  if (options?.jobName) {
    const status = await statusClient.syncStatus.upsert({
      where: { jobName: options.jobName },
      create: {
        jobName: options.jobName,
        displayName: options.displayName ?? options.jobName,
      },
      update: {},
    });
    cursor = status.backfillCursor ?? null;
    if (cursor) {
      remainingAddresses = remainingAddresses.filter(
        (address) => address > cursor!
      );
    }
    processed = status.backfillItemsProcessed ?? 0;
    await statusClient.syncStatus.update({
      where: { jobName: options.jobName },
      data: {
        backfillIsRunning: true,
        backfillStartedAt: now,
        backfillCompletedAt: null,
        backfillErrorMessage: null,
        backfillItemsTotal: remainingAddresses.length,
      },
    });
  }

  let backfillError: string | null = null;
  try {
    const batches = chunkArray(
      remainingAddresses,
      KOIOS_ACCOUNT_UPDATE_HISTORY_BATCH_SIZE
    );
    for (const batch of batches) {
      const entries = await fetchAccountUpdateHistory(batch);
      const entriesByStake = new Map<string, KoiosAccountUpdateHistoryEntry[]>();
      for (const entry of entries) {
        if (!entry?.stake_address) continue;
        const list = entriesByStake.get(entry.stake_address) ?? [];
        list.push(entry);
        entriesByStake.set(entry.stake_address, list);
      }

      for (const stakeAddress of batch) {
        const stakeEntries = entriesByStake.get(stakeAddress) ?? [];
        const { changes, latest } = buildDrepChangeLogForStake(
          stakeAddress,
          stakeEntries
        );

        if (changes.length > 0) {
          const chunkSize = 1000;
          for (let i = 0; i < changes.length; i += chunkSize) {
            const chunk = changes.slice(i, i + chunkSize);
            await statusClient.stakeDelegationChange.createMany({
              data: chunk,
            });
            changesInserted += chunk.length;
          }
        }

        if (latest) {
          latestByStake.set(stakeAddress, latest);
        }

        if (options?.jobName) {
          processed += 1;
          await statusClient.syncStatus.update({
            where: { jobName: options.jobName },
            data: {
              backfillCursor: stakeAddress,
              backfillItemsProcessed: processed,
            },
          });
        }
      }
    }
  } catch (error: any) {
    backfillError = error?.message ?? String(error);
    if (options?.jobName) {
      await statusClient.syncStatus.update({
        where: { jobName: options.jobName },
        data: {
          backfillIsRunning: false,
          backfillErrorMessage: backfillError,
        },
      });
    }
    throw error;
  } finally {
    if (options?.jobName && backfillError == null) {
      await statusClient.syncStatus.update({
        where: { jobName: options.jobName },
        data: {
          backfillIsRunning: false,
          backfillCompletedAt: new Date(),
        },
      });
    }
  }

  return { changesInserted, latestByStake };
}

/**
 * Inventory all stake addresses from Koios into the DB.
 */
export async function syncStakeAddressInventory(
  prisma: Prisma.TransactionClient
): Promise<SyncStakeAddressInventoryResult> {
  const delegationClient = prisma as Prisma.TransactionClient & {
    stakeAddress: any;
  };
  const pageSize = KOIOS_ACCOUNT_LIST_PAGE_SIZE;
  let offset = 0;
  let hasMore = true;
  let totalFetched = 0;
  let created = 0;

  while (hasMore) {
    const page = await koiosGet<KoiosAccountListEntry[]>("/account_list", {
      limit: pageSize,
      offset,
    });

    if (page && page.length > 0) {
      totalFetched += page.length;
      const data = page
        .map((row) => row?.stake_address)
        .filter((stakeAddress): stakeAddress is string => !!stakeAddress)
        .map((stakeAddress) => ({ stakeAddress }));

      if (data.length > 0) {
        const result = await delegationClient.stakeAddress.createMany({
          data,
          skipDuplicates: true,
        });
        created += result.count;
      }

      offset += page.length;
      hasMore = page.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return { totalFetched, created };
}

/**
 * Sync stake address delegation changes based on current DRep delegators.
 * This keeps a compact change log and a current-state table instead of per-epoch snapshots.
 *
 * Two-phase approach to reduce API rate limit pressure:
 * - Phase 1: Collect all delegators from all DReps (only /drep_delegators calls)
 * - Phase 2: Identify NEW stake addresses and backfill history only for those
 * - Phase 3: Process delegator data to update states and detect changes
 *
 * After initial backfill, history is only fetched for newly discovered stake addresses.
 * Changes for existing addresses are detected by comparing current delegator data to stored state.
 */
export async function syncDrepDelegationChanges(
  prisma: Prisma.TransactionClient
): Promise<SyncDrepDelegationChangesResult> {
  const delegationClient = prisma as Prisma.TransactionClient & {
    stakeAddress: any;
    stakeDelegationState: any;
    stakeDelegationChange: any;
    stakeDelegationSyncState: any;
  };
  const currentEpoch = await getKoiosCurrentEpoch();
  const syncState = await delegationClient.stakeDelegationSyncState.upsert({
    where: { id: STAKE_DELEGATION_SYNC_STATE_ID },
    update: {},
    create: { id: STAKE_DELEGATION_SYNC_STATE_ID },
  });
  const lastProcessedEpoch = syncState.lastProcessedEpoch ?? 0;

  const minVotingPower = DREP_DELEGATOR_MIN_VOTING_POWER;
  let drepRows = await prisma.drep.findMany({
    select: { drepId: true },
    where: { votingPower: { gt: minVotingPower } },
    orderBy: { drepId: "asc" },
  });

  // Ensure DRep inventory exists before we attempt delegation sync.
  if (drepRows.length === 0) {
    await syncAllDrepsInventory(prisma);
    drepRows = await prisma.drep.findMany({
      select: { drepId: true },
      where: { votingPower: { gt: minVotingPower } },
      orderBy: { drepId: "asc" },
    });
  }

  const drepIds = drepRows.map((row) => row.drepId).filter(Boolean);

  console.log(
    `[DRep Delegation Sync] currentEpoch=${currentEpoch} lastProcessedEpoch=${lastProcessedEpoch} minVotingPower=${minVotingPower.toString()} drepCount=${drepIds.length}`
  );

  // Check backfill status
  const backfillStatus = (await (prisma as any).syncStatus.findUnique({
    where: { jobName: DREP_DELEGATION_BACKFILL_JOB_NAME },
  })) as any;
  const backfillCompleted = !!backfillStatus?.backfillCompletedAt;
  const hasBackfillCheckpoint =
    !!backfillStatus?.backfillCursor && !backfillCompleted;
  const shouldBackfill = !backfillCompleted;

  // ============================================================
  // PHASE 1: Collect all delegators from all DReps
  // ============================================================
  console.log(`[DRep Delegation Sync] Phase 1: Collecting delegators from all DReps...`);

  // Map: stakeAddress -> { drepId, delegator data }
  const allDelegatorsByStake = new Map<
    string,
    { drepId: string; delegator: KoiosDrepDelegator }
  >();
  // Track all unique stake addresses
  const allStakeAddresses = new Set<string>();

  const delegatorFetchResult = await processInParallel(
    drepIds,
    (drepId) => drepId,
    async (drepId) => {
      const delegators = await fetchDelegatorsForDrep(drepId);
      const validDelegators = (delegators ?? []).filter(
        (row) => row?.stake_address && row?.amount
      );
      return { drepId, delegators: validDelegators };
    },
    DREP_DELEGATION_SYNC_CONCURRENCY
  );

  if (delegatorFetchResult.failed.length > 0) {
    console.warn(
      `[DRep Delegation Sync] Phase 1 fetch failures: ${delegatorFetchResult.failed.length}`
    );
  }

  // Aggregate all delegator data
  for (const { drepId, delegators } of delegatorFetchResult.successful) {
    for (const delegator of delegators) {
      const stakeAddress = delegator.stake_address;
      allStakeAddresses.add(stakeAddress);
      // If a stake address appears under multiple DReps, keep the latest one
      // (shouldn't happen normally, but handle gracefully)
      allDelegatorsByStake.set(stakeAddress, { drepId, delegator });
    }
  }

  console.log(
    `[DRep Delegation Sync] Phase 1 complete: ${allStakeAddresses.size} unique stake addresses from ${delegatorFetchResult.successful.length} DReps`
  );

  // ============================================================
  // PHASE 2: Identify NEW stake addresses and backfill history
  // ============================================================
  console.log(`[DRep Delegation Sync] Phase 2: Identifying new stake addresses...`);

  const backfilledStakeAddresses = new Set<string>();
  const latestHistoryByStake = new Map<
    string,
    { drepId: string; epochNo: number | null }
  >();

  // Get existing stake addresses from DB
  const existingStakeAddressRows: Array<{ stakeAddress: string }> =
    await delegationClient.stakeAddress.findMany({
      select: { stakeAddress: true },
    });
  const existingStakeAddressSet = new Set<string>(
    existingStakeAddressRows.map((row) => row.stakeAddress)
  );

  // Determine new stake addresses
  const allStakeAddressArray = Array.from(allStakeAddresses);
  const newStakeAddresses = allStakeAddressArray.filter(
    (addr) => !existingStakeAddressSet.has(addr)
  );

  console.log(
    `[DRep Delegation Sync] Found ${newStakeAddresses.length} new stake addresses (existing: ${existingStakeAddressSet.size})`
  );

  // Create all stake address records (new ones)
  if (newStakeAddresses.length > 0) {
    await delegationClient.stakeAddress.createMany({
      data: newStakeAddresses.map((stakeAddress) => ({ stakeAddress })),
      skipDuplicates: true,
    });
  }

  // Handle initial backfill vs incremental sync
  if (shouldBackfill && existingStakeAddressSet.size === 0) {
    // Initial backfill: fetch history for ALL stake addresses
    console.log(
      `[DRep Delegation Sync] Initial backfill: fetching history for all ${allStakeAddressArray.length} stake addresses...`
    );
    const backfill = await backfillStakeDelegationHistory(
      delegationClient,
      allStakeAddressArray,
      {
        jobName: DREP_DELEGATION_BACKFILL_JOB_NAME,
        displayName: "DRep Delegation Backfill",
      }
    );
    for (const [stakeAddress, latest] of backfill.latestByStake.entries()) {
      latestHistoryByStake.set(stakeAddress, latest);
      backfilledStakeAddresses.add(stakeAddress);
    }
    console.log(
      `[DRep Delegation Sync] Initial backfill complete: changesInserted=${backfill.changesInserted}`
    );
  } else if (shouldBackfill && hasBackfillCheckpoint) {
    // Resume interrupted backfill
    console.log(
      `[DRep Delegation Sync] Resuming backfill from cursor=${backfillStatus?.backfillCursor ?? "null"}`
    );
    const allExistingAddresses = Array.from(existingStakeAddressSet);
    const backfill = await backfillStakeDelegationHistory(
      delegationClient,
      allExistingAddresses,
      {
        jobName: DREP_DELEGATION_BACKFILL_JOB_NAME,
        displayName: "DRep Delegation Backfill",
      }
    );
    for (const [stakeAddress, latest] of backfill.latestByStake.entries()) {
      latestHistoryByStake.set(stakeAddress, latest);
      backfilledStakeAddresses.add(stakeAddress);
    }
    console.log(
      `[DRep Delegation Sync] Backfill resumed: changesInserted=${backfill.changesInserted}`
    );
  } else if (newStakeAddresses.length > 0) {
    // Incremental sync: only backfill history for NEW stake addresses
    console.log(
      `[DRep Delegation Sync] Incremental sync: backfilling history for ${newStakeAddresses.length} new stake addresses only...`
    );
    const backfill = await backfillStakeDelegationHistory(
      delegationClient,
      newStakeAddresses
    );
    for (const [stakeAddress, latest] of backfill.latestByStake.entries()) {
      latestHistoryByStake.set(stakeAddress, latest);
      backfilledStakeAddresses.add(stakeAddress);
    }
    console.log(
      `[DRep Delegation Sync] Incremental backfill complete: changesInserted=${backfill.changesInserted}`
    );
  } else {
    console.log(
      `[DRep Delegation Sync] No new stake addresses - skipping history backfill`
    );
  }

  // ============================================================
  // PHASE 3: Process delegator data - update states, detect changes
  // ============================================================
  console.log(`[DRep Delegation Sync] Phase 3: Processing delegator state updates...`);

  // Fetch all existing delegation states for the stake addresses we're processing
  const existingStates: Array<{
    stakeAddress: string;
    drepId: string | null;
    amount: bigint | null;
    delegatedEpoch: number | null;
  }> = await delegationClient.stakeDelegationState.findMany({
    where: { stakeAddress: { in: allStakeAddressArray } },
    select: {
      stakeAddress: true,
      drepId: true,
      amount: true,
      delegatedEpoch: true,
    },
  });
  const existingStateMap = new Map(
    existingStates.map((row) => [row.stakeAddress, row])
  );

  const toCreate: Array<{
    stakeAddress: string;
    drepId: string;
    amount: bigint;
    delegatedEpoch: number | null;
  }> = [];
  const toUpdate: Array<{
    stakeAddress: string;
    drepId: string;
    amount: bigint;
    delegatedEpoch: number | null;
  }> = [];
  const changeLog: Array<{
    stakeAddress: string;
    fromDrepId: string | null;
    toDrepId: string;
    delegatedEpoch: number | null;
    amount: bigint;
  }> = [];

  let maxDelegationEpoch = lastProcessedEpoch;

  // Process each delegator
  for (const [stakeAddress, { drepId, delegator }] of allDelegatorsByStake) {
    const epochNo =
      typeof delegator.epoch_no === "number" ? delegator.epoch_no : null;
    const normalizedEpoch = epochNo ?? Math.max(0, currentEpoch - 1);
    const delegatedEpoch = epochNo ?? normalizedEpoch;

    if (normalizedEpoch > maxDelegationEpoch) {
      maxDelegationEpoch = normalizedEpoch;
    }

    const amount = BigInt(delegator.amount);
    const currentState = existingStateMap.get(stakeAddress);
    const stateChanged = !currentState || currentState.drepId !== drepId;
    const stateNeedsUpdate =
      !currentState ||
      currentState.drepId !== drepId ||
      currentState.amount !== amount ||
      currentState.delegatedEpoch !== delegatedEpoch;

    // Check if this change was already recorded via history backfill
    const historyLatest = latestHistoryByStake.get(stakeAddress);
    const historyMatchesCurrent =
      historyLatest?.drepId === drepId &&
      backfilledStakeAddresses.has(stakeAddress);

    // Record change if DRep changed and not already in history
    if (stateChanged && !historyMatchesCurrent) {
      changeLog.push({
        stakeAddress,
        fromDrepId: currentState?.drepId ?? null,
        toDrepId: drepId,
        delegatedEpoch,
        amount,
      });
    }

    // Queue state update
    if (stateNeedsUpdate) {
      if (!currentState) {
        toCreate.push({ stakeAddress, drepId, amount, delegatedEpoch });
      } else {
        toUpdate.push({ stakeAddress, drepId, amount, delegatedEpoch });
      }
    }
  }

  // Batch create new states
  if (toCreate.length > 0) {
    await delegationClient.stakeDelegationState.createMany({
      data: toCreate,
      skipDuplicates: true,
    });
  }

  // Batch update existing states
  if (toUpdate.length > 0) {
    const chunkSize = 500;
    for (let i = 0; i < toUpdate.length; i += chunkSize) {
      const chunk = toUpdate.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map((row) =>
          delegationClient.stakeDelegationState.update({
            where: { stakeAddress: row.stakeAddress },
            data: {
              drepId: row.drepId,
              amount: row.amount,
              delegatedEpoch: row.delegatedEpoch,
            },
          })
        )
      );
    }
  }

  // Batch insert change log entries
  if (changeLog.length > 0) {
    const chunkSize = 1000;
    for (let i = 0; i < changeLog.length; i += chunkSize) {
      const chunk = changeLog.slice(i, i + chunkSize);
      await delegationClient.stakeDelegationChange.createMany({
        data: chunk,
      });
    }
  }

  console.log(
    `[DRep Delegation Sync] Phase 3 complete: created=${toCreate.length}, updated=${toUpdate.length}, changes=${changeLog.length}`
  );

  // Update sync state
  const failed = delegatorFetchResult.failed.map((f) => ({
    drepId: f.id,
    error: f.error,
  }));

  if (failed.length === 0 && maxDelegationEpoch >= lastProcessedEpoch) {
    await delegationClient.stakeDelegationSyncState.update({
      where: { id: STAKE_DELEGATION_SYNC_STATE_ID },
      data: { lastProcessedEpoch: maxDelegationEpoch },
    });
  }

  return {
    currentEpoch,
    lastProcessedEpoch,
    maxDelegationEpoch,
    drepsProcessed: delegatorFetchResult.successful.length,
    delegatorsProcessed: allDelegatorsByStake.size,
    statesUpdated: toCreate.length + toUpdate.length,
    changesInserted: changeLog.length,
    failed,
  };
}

async function syncGovernanceAnalyticsForEpoch(
  prisma: Prisma.TransactionClient,
  epochToSync: number,
  currentEpoch: number
): Promise<SyncGovernanceAnalyticsEpochResult> {
  if (epochToSync < 0 || epochToSync >= currentEpoch) {
    return {
      epoch: epochToSync,
      currentEpoch,
      skipped: { dreps: true, totals: true },
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

  // 2) Epoch denominators/totals
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

