/**
 * Delegation Sync Service
 *
 * Handles stake address delegation tracking and change log.
 * - syncDrepDelegationChanges: Syncs delegation states and change log
 */

import { Prisma } from "@prisma/client";
import {
  getAccountUpdateHistoryBatch,
  getTxInfoBatch,
  listAllDrepDelegators,
} from "../governanceProvider";
import type {
  KoiosDrepDelegator,
  KoiosAccountUpdateHistoryEntry,
  KoiosTxInfo,
} from "../../types/koios.types";
import { processInParallel } from "./parallel";
import {
  DREP_DELEGATION_SYNC_CONCURRENCY,
  STAKE_DELEGATION_SYNC_STATE_ID,
  DREP_DELEGATION_BACKFILL_JOB_NAME,
  FORCE_DREP_DELEGATION_BACKFILL_JOB_NAME,
  DREP_DELEGATION_PHASE3_JOB_NAME,
  KOIOS_ACCOUNT_UPDATE_HISTORY_BATCH_SIZE,
  chunkArray,
  getKoiosCurrentEpoch,
  Phase3Checkpoint,
} from "./sync-utils";
import { getBoundedIntEnv } from "./syncLock";
import {
  syncAllDrepsInventory,
  ensureDrepsExist,
  refreshDrepDelegatorCountsFromDelegationState,
} from "./drep-sync.service";

const KOIOS_HEAVY_DREP_DELEGATORS_LANE_JOB_NAME =
  "koios-heavy-drep-delegators-lane";
const DELEGATION_FULL_SCAN_WINDOW_JOB_NAME =
  "drep-delegation-full-scan-window";
const DELEGATION_FULL_SCAN_WINDOW_DEFAULT_MS = 55 * 60 * 1000;
const DREP_DELEGATION_MAX_FETCH_FAILURES = 1;
const HEAVY_LANE_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

// ============================================================
// Result Types
// ============================================================

export interface SyncDrepDelegationChangesResult {
  currentEpoch: number;
  lastProcessedEpoch: number;
  maxDelegationEpoch: number;
  drepsProcessed: number;
  delegatorsProcessed: number;
  statesUpdated: number;
  changesInserted: number;
  failed: Array<{ drepId: string; error: string }>;
  skipped?: boolean;
  skipReason?: string;
}

// ============================================================
// Private Helpers
// ============================================================

async function fetchDelegatorsForDrep(drepId: string): Promise<KoiosDrepDelegator[]> {
  return listAllDrepDelegators({
    drepId,
    source: "ingestion.delegation-sync.fetch-delegators",
  });
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
  stakeEntries: KoiosAccountUpdateHistoryEntry[],
  options?: { txHashToDrepId?: Map<string, string> }
): {
  changes: Array<{
    stakeAddress: string;
    fromDrepId: string;      // "" = no previous DRep (sentinel)
    toDrepId: string;
    delegatedEpoch: number;  // -1 = unknown epoch (sentinel)
  }>;
  latest: { drepId: string; epochNo: number | null } | null;
} {
  const changes: Array<{
    stakeAddress: string;
    fromDrepId: string;
    toDrepId: string;
    delegatedEpoch: number;
  }> = [];

  let lastDrepId: string | null = null;
  let lastEpoch: number | null = null;
  const sorted = sortAccountUpdates(stakeEntries);
  const txHashToDrepId = options?.txHashToDrepId ?? new Map<string, string>();
  for (const entry of sorted) {
    if (!entry?.action_type?.includes("delegation_drep")) continue;
    const drepId =
      extractDelegatedDrepId(entry) ??
      (entry.tx_hash ? txHashToDrepId.get(entry.tx_hash) ?? null : null);
    if (!drepId || drepId === lastDrepId) continue;
    const delegatedEpoch =
      typeof entry.epoch_no === "number" ? entry.epoch_no : -1;
    changes.push({
      stakeAddress,
      fromDrepId: lastDrepId ?? "",  // Sentinel for no previous DRep
      toDrepId: drepId,
      delegatedEpoch,
    });
    lastDrepId = drepId;
    lastEpoch = typeof entry.epoch_no === "number" ? entry.epoch_no : null;
  }

  return {
    changes,
    latest: lastDrepId ? { drepId: lastDrepId, epochNo: lastEpoch } : null,
  };
}

async function fetchAccountUpdateHistoryForStakes(
  stakeAddresses: string[]
): Promise<Map<string, KoiosAccountUpdateHistoryEntry[]>> {
  const result = new Map<string, KoiosAccountUpdateHistoryEntry[]>();
  if (stakeAddresses.length === 0) return result;

  const rows = await getAccountUpdateHistoryBatch(stakeAddresses, {
    source: "ingestion.delegation-sync.account-update-history",
  });

  for (const row of rows) {
    const stakeAddress = row?.stake_address;
    if (typeof stakeAddress !== "string" || !stakeAddress) continue;
    const existing = result.get(stakeAddress);
    if (existing) existing.push(row);
    else result.set(stakeAddress, [row]);
  }

  return result;
}

function extractVoteDelegationDrepIdFromTxInfo(
  tx: KoiosTxInfo,
  stakeAddress: string
): string | null {
  const certs = tx?.certificates ?? [];
  if (!Array.isArray(certs) || certs.length === 0) return null;

  for (const cert of certs) {
    const type = (cert as any)?.type as unknown;
    if (typeof type !== "string") continue;
    if (!type.toLowerCase().includes("vote_delegation")) continue;

    const info = (cert as any)?.info as any;
    if (!info || typeof info !== "object") continue;

    // Koios uses `stake_address` in certificate info for vote delegation.
    const certStake =
      (info.stake_address as unknown) ?? (info.stake_addr as unknown);
    if (typeof certStake === "string" && certStake && certStake !== stakeAddress) {
      continue;
    }

    const direct =
      (info.drep_id as unknown) ??
      (info.delegated_drep as unknown) ??
      (info.drep as unknown);
    if (typeof direct === "string" && direct) return direct;

    // Fallback: search all string fields for a plausible DRep identifier.
    for (const value of Object.values(info)) {
      if (typeof value === "string" && value) {
        if (value.startsWith("drep")) return value;
      }
    }
  }

  return null;
}

async function fetchTxInfoByHashes(txHashes: string[]): Promise<KoiosTxInfo[]> {
  if (txHashes.length === 0) return [];

  return getTxInfoBatch(txHashes, {
    includeInputs: false,
    includeMetadata: false,
    includeAssets: false,
    includeWithdrawals: false,
    includeCerts: true,
    includeScripts: false,
    includeBytecode: false,
    source: "ingestion.delegation-sync.tx-info",
  });
}

function delegationChangeKey(entry: {
  stakeAddress: string;
  fromDrepId: string;
  toDrepId: string;
  delegatedEpoch: number;
}): string {
  return `${entry.stakeAddress}|${entry.fromDrepId}|${entry.toDrepId}|${entry.delegatedEpoch}`;
}

async function updateStakeDelegationStateBatch(
  prisma: Prisma.TransactionClient,
  rows: Array<{
    stakeAddress: string;
    drepId: string;
    amount: bigint;
    delegatedEpoch: number | null;
  }>
): Promise<number> {
  if (rows.length === 0) return 0;

  const values = Prisma.join(
    rows.map((row) =>
      Prisma.sql`(${row.stakeAddress}, ${row.drepId}, ${row.amount}, ${row.delegatedEpoch})`
    )
  );

  const updated = await prisma.$executeRaw`
    UPDATE "stake_delegation_state" AS s
    SET
      "drep_id" = v."drep_id",
      "amount" = v."amount",
      "delegated_epoch_no" = v."delegated_epoch_no"
    FROM (
      VALUES ${values}
    ) AS v("stake_address", "drep_id", "amount", "delegated_epoch_no")
    WHERE s."stake_address" = v."stake_address"
  `;

  return Number(updated);
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
  const STATUS_UPDATE_INTERVAL = 100;
  // Cache (stakeAddress, tx_hash) -> resolved drep_id for this backfill run to reduce /tx_info calls.
  // Note: a single tx_hash can (rarely) include multiple vote_delegation certs for different stake keys.
  const txStakeDrepCache = new Map<string, string | null>();

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
  let lastCursorUpdate: string | null = null;
  try {
    const stakeBatches = chunkArray(
      remainingAddresses,
      KOIOS_ACCOUNT_UPDATE_HISTORY_BATCH_SIZE
    );

    for (const stakeBatch of stakeBatches) {
      // Batch-fetch history for multiple stake addresses to cut request overhead.
      const historyByStake = await fetchAccountUpdateHistoryForStakes(stakeBatch);

      // Build (tx_hash -> stakeAddresses needing resolution) for this batch.
      const txHashToStakesNeeding = new Map<string, string[]>();
      const txHashesNeedingResolutionByStake = new Map<string, string[]>();
      for (const stakeAddress of stakeBatch) {
        const stakeEntries = historyByStake.get(stakeAddress) ?? [];
        const txHashesNeedingResolution = Array.from(
          new Set(
            (stakeEntries ?? [])
              .filter((e) => e?.action_type?.includes("delegation_drep"))
              .filter((e) => !extractDelegatedDrepId(e))
              .map((e) => e?.tx_hash)
              .filter((h): h is string => typeof h === "string" && h.length > 0)
          )
        );
        txHashesNeedingResolutionByStake.set(stakeAddress, txHashesNeedingResolution);

        for (const h of txHashesNeedingResolution) {
          const cacheKey = `${stakeAddress}:${h}`;
          if (txStakeDrepCache.has(cacheKey)) continue;
          const existing = txHashToStakesNeeding.get(h);
          if (existing) existing.push(stakeAddress);
          else txHashToStakesNeeding.set(h, [stakeAddress]);
        }
      }

      const missingTxHashes = Array.from(txHashToStakesNeeding.keys());
      if (missingTxHashes.length > 0) {
        const txInfos = await fetchTxInfoByHashes(missingTxHashes);
        const txInfoByHash = new Map<string, KoiosTxInfo>();
        for (const tx of txInfos) {
          if (tx?.tx_hash) txInfoByHash.set(tx.tx_hash, tx);
        }

        // Resolve and cache (stakeAddress, tx_hash) -> drep_id for this batch.
        for (const txHash of missingTxHashes) {
          const tx = txInfoByHash.get(txHash);
          const stakeList = txHashToStakesNeeding.get(txHash) ?? [];
          for (const stakeAddress of stakeList) {
            const cacheKey = `${stakeAddress}:${txHash}`;
            if (txStakeDrepCache.has(cacheKey)) continue;
            const drepId = tx ? extractVoteDelegationDrepIdFromTxInfo(tx, stakeAddress) : null;
            txStakeDrepCache.set(cacheKey, drepId);
          }
        }
      }

      // Ensure every requested hash is cached (even if null) to prevent re-fetching.
      for (const [txHash, stakeList] of txHashToStakesNeeding.entries()) {
        for (const stakeAddress of stakeList) {
          const cacheKey = `${stakeAddress}:${txHash}`;
          if (!txStakeDrepCache.has(cacheKey)) txStakeDrepCache.set(cacheKey, null);
        }
      }

      // Process stake addresses in-order (preserves cursor semantics).
      for (const stakeAddress of stakeBatch) {
        const stakeEntries = historyByStake.get(stakeAddress) ?? [];

        const txHashesNeedingResolution =
          txHashesNeedingResolutionByStake.get(stakeAddress) ?? [];

        const txHashToDrepId = new Map<string, string>();
        for (const h of txHashesNeedingResolution) {
          const resolved = txStakeDrepCache.get(`${stakeAddress}:${h}`) ?? null;
          if (typeof resolved === "string" && resolved) {
            txHashToDrepId.set(h, resolved);
          }
        }

        const { changes, latest } = buildDrepChangeLogForStake(
          stakeAddress,
          stakeEntries,
          { txHashToDrepId }
        );

        if (changes.length > 0) {
          const chunkSize = 1000;
          for (let i = 0; i < changes.length; i += chunkSize) {
            const chunk = changes.slice(i, i + chunkSize);
            const result = await statusClient.stakeDelegationChange.createMany({
              data: chunk,
              skipDuplicates: true,
            });
            changesInserted += result.count;
          }
        }

        if (latest) {
          latestByStake.set(stakeAddress, latest);
        }

        if (options?.jobName) {
          processed += 1;
          lastCursorUpdate = stakeAddress;
          if (processed % STATUS_UPDATE_INTERVAL === 0) {
            await statusClient.syncStatus.update({
              where: { jobName: options.jobName },
              data: {
                backfillCursor: lastCursorUpdate,
                backfillItemsProcessed: processed,
              },
            });
            lastCursorUpdate = null;
          }
        }
      }
    }
    if (options?.jobName && lastCursorUpdate) {
      await statusClient.syncStatus.update({
        where: { jobName: options.jobName },
        data: {
          backfillCursor: lastCursorUpdate,
          backfillItemsProcessed: processed,
        },
      });
      lastCursorUpdate = null;
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

// ============================================================
// Public API
// ============================================================

/**
 * Sync stake address delegation changes based on current DRep delegators.
 * This keeps a compact change log and a current-state table instead of per-epoch snapshots.
 *
 * Three-phase approach:
 * - Phase 1: Collect all delegators from all DReps (only /drep_delegators calls)
 * - Phase 2: Identify NEW stake addresses and backfill history only for those
 * - Phase 3: Process delegator data to update states and detect changes (with checkpointing)
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

  // Force full history backfill (via env var). This is designed to be enabled temporarily.
  // When enabled, it uses a separate SyncStatus row so the force-backfill runs once and can be resumed.
  const forceBackfillEnabled = process.env.FORCE_DREP_DELEGATION_BACKFILL === "true";
  const forceBackfillStatus = forceBackfillEnabled
    ? await (prisma as any).syncStatus.findUnique({
      where: { jobName: FORCE_DREP_DELEGATION_BACKFILL_JOB_NAME },
    })
    : null;
  const shouldForceBackfill =
    forceBackfillEnabled && !forceBackfillStatus?.backfillCompletedAt;

  // Check backfill status first to determine if this is an initial backfill
  const backfillStatus = (await (prisma as any).syncStatus.findUnique({
    where: { jobName: DREP_DELEGATION_BACKFILL_JOB_NAME },
  })) as any;
  const backfillCompleted = !!backfillStatus?.backfillCompletedAt;
  const hasBackfillCheckpoint =
    !!backfillStatus?.backfillCursor && !backfillCompleted;
  const shouldBackfill = !backfillCompleted;

  const fullScanThrottleEnabled =
    process.env.DELEGATION_SYNC_FULL_SCAN_THROTTLE_ENABLED !== "false";
  const fullScanMinIntervalMs = getBoundedIntEnv(
    "DELEGATION_SYNC_FULL_SCAN_MIN_INTERVAL_MS",
    DELEGATION_FULL_SCAN_WINDOW_DEFAULT_MS,
    0,
    24 * 60 * 60 * 1000
  );
  const fullScanWindowStatus = await (prisma as any).syncStatus.findUnique({
    where: { jobName: DELEGATION_FULL_SCAN_WINDOW_JOB_NAME },
  });
  const lastFullScanAt = fullScanWindowStatus?.completedAt
    ? new Date(fullScanWindowStatus.completedAt).getTime()
    : 0;
  const fullScanAgeMs = lastFullScanAt > 0 ? Date.now() - lastFullScanAt : null;
  const shouldThrottleThisRun =
    fullScanThrottleEnabled &&
    fullScanMinIntervalMs > 0 &&
    !shouldForceBackfill &&
    !shouldBackfill &&
    fullScanAgeMs !== null &&
    fullScanAgeMs < fullScanMinIntervalMs;
  if (shouldThrottleThisRun) {
    const remainingMs = fullScanMinIntervalMs - (fullScanAgeMs ?? 0);
    console.log(
      `[DRep Delegation Sync] Skipping full scan due to throttle window: remainingMs=${remainingMs}`
    );
    return {
      currentEpoch,
      lastProcessedEpoch,
      maxDelegationEpoch: lastProcessedEpoch,
      drepsProcessed: 0,
      delegatorsProcessed: 0,
      statesUpdated: 0,
      changesInserted: 0,
      failed: [],
      skipped: true,
      skipReason: "full-scan-throttle-window",
    };
  }

  // For initial backfill, ensure DRep inventory is complete before proceeding.
  // Check if EpochAnalyticsSync has a recent drepsSyncedAt entry.
  if (shouldBackfill) {
    const recentDrepSync = await (prisma as any).epochAnalyticsSync.findFirst({
      where: { drepsSyncedAt: { not: null } },
      orderBy: { epoch: "desc" },
    });

    if (!recentDrepSync) {
      console.log(
        `[DRep Delegation Sync] Initial backfill: No completed DRep inventory sync found. Syncing DReps first...`
      );
      const drepSyncResult = await syncAllDrepsInventory(prisma);
      console.log(
        `[DRep Delegation Sync] DRep inventory sync complete: koios=${drepSyncResult.koiosTotal}, created=${drepSyncResult.created}`
      );
    } else {
      console.log(
        `[DRep Delegation Sync] Initial backfill: DRep inventory confirmed synced for epoch ${recentDrepSync.epoch}`
      );
    }
  }

  // These "special" DRep options can have massive delegator sets.
  // We intentionally exclude them from stake-address delegation tracking to avoid
  // ballooning the stake address inventory; we ingest only per-epoch aggregates elsewhere.
  const excludedDrepIds = ["drep_always_abstain", "drep_always_no_confidence"];
  let drepRows = await prisma.drep.findMany({
    select: { drepId: true },
    where: { drepId: { notIn: excludedDrepIds } },
    orderBy: { drepId: "asc" },
  });

  // Fallback: Ensure DRep inventory exists if still empty.
  if (drepRows.length === 0) {
    await syncAllDrepsInventory(prisma);
    drepRows = await prisma.drep.findMany({
      select: { drepId: true },
      where: { drepId: { notIn: excludedDrepIds } },
      orderBy: { drepId: "asc" },
    });
  }

  const drepIds = drepRows.map((row) => row.drepId).filter(Boolean);

  console.log(
    `[DRep Delegation Sync] currentEpoch=${currentEpoch} lastProcessedEpoch=${lastProcessedEpoch} drepCount=${drepIds.length}`
  );

  // ============================================================
  // PHASE 1: Collect all delegators from all DReps
  // ============================================================
  console.log(`[DRep Delegation Sync] Phase 1: Collecting delegators from all DReps...`);

  const allDelegatorsByStake = new Map<
    string,
    { drepId: string; delegator: KoiosDrepDelegator }
  >();
  const allStakeAddresses = new Set<string>();
  let phase1DelegatorRows = 0;
  const heavyLaneClient = prisma as Prisma.TransactionClient & { syncStatus: any };
  const heavyLaneStartedAt = new Date();
  await heavyLaneClient.syncStatus.upsert({
    where: { jobName: KOIOS_HEAVY_DREP_DELEGATORS_LANE_JOB_NAME },
    create: {
      jobName: KOIOS_HEAVY_DREP_DELEGATORS_LANE_JOB_NAME,
      displayName: "Koios Heavy /drep_delegators Lane",
      isRunning: true,
      startedAt: heavyLaneStartedAt,
      completedAt: null,
      expiresAt: new Date(heavyLaneStartedAt.getTime() + HEAVY_LANE_LOCK_TTL_MS),
      errorMessage: null,
    },
    update: {
      isRunning: true,
      startedAt: heavyLaneStartedAt,
      completedAt: null,
      expiresAt: new Date(heavyLaneStartedAt.getTime() + HEAVY_LANE_LOCK_TTL_MS),
      errorMessage: null,
    },
  });

  let delegatorFetchResult: {
    successful: Array<{ drepId: string; delegators: KoiosDrepDelegator[] }>;
    failed: Array<{ id: string; error: string }>;
  };
  try {
    delegatorFetchResult = await processInParallel(
      drepIds,
      (drepId) => drepId,
      async (drepId) => {
        const delegators = await fetchDelegatorsForDrep(drepId);
        const validDelegators = (delegators ?? []).filter(
          (row) => row?.stake_address && row?.amount
        );
        phase1DelegatorRows += validDelegators.length;
        return { drepId, delegators: validDelegators };
      },
      DREP_DELEGATION_SYNC_CONCURRENCY
    );
  } finally {
    await heavyLaneClient.syncStatus.update({
      where: { jobName: KOIOS_HEAVY_DREP_DELEGATORS_LANE_JOB_NAME },
      data: {
        isRunning: false,
        completedAt: new Date(),
        expiresAt: null,
      },
    });
  }

  if (delegatorFetchResult.failed.length > 0) {
    console.warn(
      `[DRep Delegation Sync] Phase 1 fetch failures: ${delegatorFetchResult.failed.length}`
    );
  }

  for (const { drepId, delegators } of delegatorFetchResult.successful) {
    for (const delegator of delegators) {
      const stakeAddress = delegator.stake_address;
      allStakeAddresses.add(stakeAddress);
      allDelegatorsByStake.set(stakeAddress, { drepId, delegator });
    }
  }

  const failed = delegatorFetchResult.failed.map((f) => ({
    drepId: f.id,
    error: f.error,
  }));
  const maxFetchFailures = Math.min(
    DREP_DELEGATION_MAX_FETCH_FAILURES,
    Math.max(1, drepIds.length)
  );
  const shouldFailClosed = failed.length > maxFetchFailures;
  if (failed.length > 0) {
    const failureSummary = JSON.stringify({
      type: "phase1-fetch-failures",
      failedCount: failed.length,
      maxAllowedFailures: maxFetchFailures,
      failClosed: shouldFailClosed,
      drepIds: failed.slice(0, 20).map((entry) => entry.drepId),
    });
    await (prisma as any).syncStatus.upsert({
      where: { jobName: DELEGATION_FULL_SCAN_WINDOW_JOB_NAME },
      create: {
        jobName: DELEGATION_FULL_SCAN_WINDOW_JOB_NAME,
        displayName: "DRep Delegation Full Scan Window",
        isRunning: false,
        completedAt: new Date(),
        lastResult: shouldFailClosed ? "error" : "success",
        itemsProcessed: allDelegatorsByStake.size,
        errorMessage: failureSummary,
      },
      update: {
        isRunning: false,
        completedAt: new Date(),
        lastResult: shouldFailClosed ? "error" : "success",
        itemsProcessed: allDelegatorsByStake.size,
        errorMessage: failureSummary,
      },
    });
    if (shouldFailClosed) {
      return {
        currentEpoch,
        lastProcessedEpoch,
        maxDelegationEpoch: lastProcessedEpoch,
        drepsProcessed: delegatorFetchResult.successful.length,
        delegatorsProcessed: allDelegatorsByStake.size,
        statesUpdated: 0,
        changesInserted: 0,
        failed,
      };
    }
    console.warn(
      `[DRep Delegation Sync] Continuing with partial data: failures=${failed.length} maxAllowedFailures=${maxFetchFailures}`
    );
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

  const allStakeAddressArray = Array.from(allStakeAddresses);
  const existingStakeAddressSet = new Set<string>();
  const existingStakeAddressChunks = chunkArray(allStakeAddressArray, 5000);
  for (const chunk of existingStakeAddressChunks) {
    const existingStakeAddressRows: Array<{ stakeAddress: string }> =
      await delegationClient.stakeAddress.findMany({
        where: { stakeAddress: { in: chunk } },
        select: { stakeAddress: true },
      });
    for (const row of existingStakeAddressRows) {
      existingStakeAddressSet.add(row.stakeAddress);
    }
  }
  const newStakeAddresses = allStakeAddressArray.filter(
    (addr) => !existingStakeAddressSet.has(addr)
  );

  console.log(
    `[DRep Delegation Sync] Found ${newStakeAddresses.length} new stake addresses (existing: ${existingStakeAddressSet.size})`
  );

  if (newStakeAddresses.length > 0) {
    await delegationClient.stakeAddress.createMany({
      data: newStakeAddresses.map((stakeAddress) => ({ stakeAddress })),
      skipDuplicates: true,
    });
  }

  // Handle initial backfill vs incremental sync
  if (shouldForceBackfill) {
    console.log(
      `[DRep Delegation Sync] FORCE backfill enabled: fetching history for all ${allStakeAddressArray.length} stake addresses...`
    );
    const backfill = await backfillStakeDelegationHistory(
      delegationClient,
      allStakeAddressArray,
      {
        jobName: FORCE_DREP_DELEGATION_BACKFILL_JOB_NAME,
        displayName: "DRep Delegation Backfill (Force)",
      }
    );
    for (const [stakeAddress, latest] of backfill.latestByStake.entries()) {
      latestHistoryByStake.set(stakeAddress, latest);
      backfilledStakeAddresses.add(stakeAddress);
    }
    console.log(
      `[DRep Delegation Sync] FORCE backfill complete: changesInserted=${backfill.changesInserted}`
    );
  } else if (shouldBackfill && existingStakeAddressSet.size === 0) {
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

  const existingStateMap = new Map<
    string,
    {
      stakeAddress: string;
      drepId: string | null;
      amount: bigint | null;
      delegatedEpoch: number | null;
    }
  >();
  const existingStateChunks = chunkArray(allStakeAddressArray, 5000);
  for (const chunk of existingStateChunks) {
    const existingStates: Array<{
      stakeAddress: string;
      drepId: string | null;
      amount: bigint | null;
      delegatedEpoch: number | null;
    }> = await delegationClient.stakeDelegationState.findMany({
      where: { stakeAddress: { in: chunk } },
      select: {
        stakeAddress: true,
        drepId: true,
        amount: true,
        delegatedEpoch: true,
      },
    });
    for (const row of existingStates) {
      existingStateMap.set(row.stakeAddress, row);
    }
  }

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
  const toClear: string[] = [];
  const changeLog: Array<{
    stakeAddress: string;
    fromDrepId: string;      // "" = no previous DRep (sentinel)
    toDrepId: string;
    delegatedEpoch: number;  // -1 = unknown epoch (sentinel)
  }> = [];

  let maxDelegationEpoch = lastProcessedEpoch;

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

    const historyLatest = latestHistoryByStake.get(stakeAddress);
    const historyMatchesCurrent =
      historyLatest?.drepId === drepId &&
      backfilledStakeAddresses.has(stakeAddress);

    if (stateChanged && !historyMatchesCurrent) {
      changeLog.push({
        stakeAddress,
        fromDrepId: currentState?.drepId ?? "",  // Sentinel for no previous DRep
        toDrepId: drepId,
        delegatedEpoch: delegatedEpoch ?? -1,    // Sentinel for unknown epoch
      });
    }

    if (stateNeedsUpdate) {
      if (!currentState) {
        toCreate.push({ stakeAddress, drepId, amount, delegatedEpoch });
      } else {
        toUpdate.push({ stakeAddress, drepId, amount, delegatedEpoch });
      }
    }
  }

  // Reconcile stale states only when we have a complete snapshot.
  // If there are fetch failures, skip this destructive step to avoid false clears.
  if (failed.length === 0) {
    const activeDelegationStates: Array<{ stakeAddress: string }> =
      await delegationClient.stakeDelegationState.findMany({
        where: { drepId: { not: null } },
        select: { stakeAddress: true },
      });
    for (const row of activeDelegationStates) {
      if (!allStakeAddresses.has(row.stakeAddress)) {
        toClear.push(row.stakeAddress);
      }
    }
  } else {
    console.warn(
      `[DRep Delegation Sync] Skipping stale-state reconciliation due to fetch failures=${failed.length}`
    );
  }

  // Deduplicate: skip Phase 3 change log entries when a row for (stakeAddress, toDrepId, delegatedEpoch)
  // already exists (e.g. from backfill), so we don't insert a second row with amount for the same delegation.
  let changeLogToInsert = changeLog;
  if (changeLog.length > 0) {
    const dedupeLookupChunkSize = getBoundedIntEnv(
      "DELEGATION_CHANGE_DEDUPE_LOOKUP_CHUNK_SIZE",
      400,
      50,
      2000
    );
    const dedupedCandidates = Array.from(
      new Map(changeLog.map((entry) => [delegationChangeKey(entry), entry])).values()
    );
    const existingRows: Array<{
      stakeAddress: string;
      fromDrepId: string;
      toDrepId: string;
      delegatedEpoch: number;
    }> = [];
    const candidateChunks = chunkArray(dedupedCandidates, dedupeLookupChunkSize);
    for (const chunk of candidateChunks) {
      if (chunk.length === 0) continue;
      const rows = await delegationClient.stakeDelegationChange.findMany({
        where: {
          OR: chunk.map((entry) => ({
            stakeAddress: entry.stakeAddress,
            fromDrepId: entry.fromDrepId,
            toDrepId: entry.toDrepId,
            delegatedEpoch: entry.delegatedEpoch,
          })),
        },
        select: {
          stakeAddress: true,
          fromDrepId: true,
          toDrepId: true,
          delegatedEpoch: true,
        },
      });
      existingRows.push(...rows);
    }
    const existingKeySet = new Set(existingRows.map((entry) => delegationChangeKey(entry)));
    changeLogToInsert = dedupedCandidates.filter(
      (entry) => !existingKeySet.has(delegationChangeKey(entry))
    );
  }

  // Initialize or load Phase 3 checkpoint
  const syncStatusClient = delegationClient as Prisma.TransactionClient & { syncStatus: any };
  const transactionClient = prisma as Prisma.TransactionClient & {
    $transaction?: (args: any) => Promise<any>;
  };
  let checkpoint: Phase3Checkpoint = {
    epoch: currentEpoch,
    createsComplete: false,
    updateChunkIndex: 0,
    changesChunkIndex: 0,
  };

  const existingStatus = await syncStatusClient.syncStatus.findUnique({
    where: { jobName: DREP_DELEGATION_PHASE3_JOB_NAME },
  });

  if (existingStatus?.backfillCursor) {
    try {
      const savedCheckpoint = JSON.parse(existingStatus.backfillCursor) as Phase3Checkpoint;
      if (savedCheckpoint.epoch === currentEpoch) {
        checkpoint = savedCheckpoint;
        console.log(
          `[DRep Delegation Sync] Resuming Phase 3 from checkpoint: creates=${checkpoint.createsComplete}, updateChunk=${checkpoint.updateChunkIndex}, changesChunk=${checkpoint.changesChunkIndex}`
        );
      }
    } catch {
      // Invalid checkpoint, start fresh
    }
  }

  await syncStatusClient.syncStatus.upsert({
    where: { jobName: DREP_DELEGATION_PHASE3_JOB_NAME },
    create: {
      jobName: DREP_DELEGATION_PHASE3_JOB_NAME,
      displayName: "DRep Delegation Phase 3",
      backfillCursor: JSON.stringify(checkpoint),
    },
    update: {},
  });

  const buildCheckpointData = (updates: Partial<Phase3Checkpoint>) => {
    const next = { ...checkpoint, ...updates };
    return { next, data: { backfillCursor: JSON.stringify(next) } };
  };

  // Batch create new states (with checkpoint)
  if (toCreate.length > 0 && !checkpoint.createsComplete) {
    const { next, data: checkpointData } = buildCheckpointData({ createsComplete: true });
    if (transactionClient.$transaction) {
      await transactionClient.$transaction([
        delegationClient.stakeDelegationState.createMany({
          data: toCreate,
          skipDuplicates: true,
        }),
        syncStatusClient.syncStatus.update({
          where: { jobName: DREP_DELEGATION_PHASE3_JOB_NAME },
          data: checkpointData,
        }),
      ]);
    } else {
      await delegationClient.stakeDelegationState.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
      await syncStatusClient.syncStatus.update({
        where: { jobName: DREP_DELEGATION_PHASE3_JOB_NAME },
        data: checkpointData,
      });
    }
    checkpoint = next;
  }

  // Batch update existing states (with per-chunk checkpoint)
  if (toUpdate.length > 0) {
    const updateChunkSize = getBoundedIntEnv(
      "DELEGATION_PHASE3_UPDATE_CHUNK_SIZE",
      100,
      20,
      1000
    );
    const startChunkIndex = checkpoint.updateChunkIndex;
    for (let i = startChunkIndex * updateChunkSize; i < toUpdate.length; i += updateChunkSize) {
      const chunkIndex = Math.floor(i / updateChunkSize);
      const chunk = toUpdate.slice(i, i + updateChunkSize);
      const { next, data: checkpointData } = buildCheckpointData({ updateChunkIndex: chunkIndex + 1 });
      await updateStakeDelegationStateBatch(delegationClient, chunk);
      await syncStatusClient.syncStatus.update({
        where: { jobName: DREP_DELEGATION_PHASE3_JOB_NAME },
        data: checkpointData,
      });
      checkpoint = next;
    }
  }

  if (toClear.length > 0) {
    const clearChunkSize = getBoundedIntEnv(
      "DELEGATION_PHASE3_CLEAR_CHUNK_SIZE",
      500,
      50,
      5000
    );
    for (let i = 0; i < toClear.length; i += clearChunkSize) {
      const chunk = toClear.slice(i, i + clearChunkSize);
      await delegationClient.stakeDelegationState.updateMany({
        where: {
          stakeAddress: { in: chunk },
          drepId: { not: null },
        },
        data: {
          drepId: null,
          amount: null,
          delegatedEpoch: null,
        },
      });
    }
  }

  // Ensure all from/to DReps referenced in the change log exist in the DRep table (e.g. retired "from" DReps).
  if (changeLogToInsert.length > 0) {
    const drepIdsFromChanges = new Set<string>();
    for (const c of changeLogToInsert) {
      if (c.fromDrepId?.trim()) drepIdsFromChanges.add(c.fromDrepId);
      if (c.toDrepId?.trim()) drepIdsFromChanges.add(c.toDrepId);
    }
    if (drepIdsFromChanges.size > 0) {
      const ensureResult = await ensureDrepsExist(prisma, [...drepIdsFromChanges]);
      if (ensureResult.created > 0) {
        console.log(
          `[DRep Delegation Sync] Ensured ${ensureResult.created} DRep(s) in inventory for delegation change from/to refs`
        );
      }
    }
  }

  // Batch insert change log entries (with per-chunk checkpoint).
  if (changeLogToInsert.length > 0) {
    const changesChunkSize = 1000;
    const startChunkIndex = checkpoint.changesChunkIndex;
    for (let i = startChunkIndex * changesChunkSize; i < changeLogToInsert.length; i += changesChunkSize) {
      const chunkIndex = Math.floor(i / changesChunkSize);
      const chunk = changeLogToInsert.slice(i, i + changesChunkSize);
      const changeData = chunk.map((c) => ({
        stakeAddress: c.stakeAddress,
        fromDrepId: c.fromDrepId,
        toDrepId: c.toDrepId,
        delegatedEpoch: c.delegatedEpoch,
      }));
      const { next, data: checkpointData } = buildCheckpointData({ changesChunkIndex: chunkIndex + 1 });
      if (transactionClient.$transaction) {
        await transactionClient.$transaction([
          delegationClient.stakeDelegationChange.createMany({
            data: changeData,
            skipDuplicates: true,
          }),
          syncStatusClient.syncStatus.update({
            where: { jobName: DREP_DELEGATION_PHASE3_JOB_NAME },
            data: checkpointData,
          }),
        ]);
      } else {
        await delegationClient.stakeDelegationChange.createMany({
          data: changeData,
          skipDuplicates: true,
        });
        await syncStatusClient.syncStatus.update({
          where: { jobName: DREP_DELEGATION_PHASE3_JOB_NAME },
          data: checkpointData,
        });
      }
      checkpoint = next;
    }
  }

  // Clear checkpoint on successful completion
  await syncStatusClient.syncStatus.update({
    where: { jobName: DREP_DELEGATION_PHASE3_JOB_NAME },
    data: { backfillCursor: null, backfillCompletedAt: new Date() },
  });

  // Always refresh DRep delegator_count after a successful reconciliation pass.
  const refreshResult = await refreshDrepDelegatorCountsFromDelegationState(
    delegationClient as Prisma.TransactionClient
  );
  if (refreshResult.updated > 0) {
    console.log(
      `[DRep Delegation Sync] Refreshed delegator_count for ${refreshResult.updated} DRep(s)`
    );
  }

  console.log(
    `[DRep Delegation Sync] Phase 3 complete: created=${toCreate.length}, updated=${toUpdate.length}, cleared=${toClear.length}, changes=${changeLogToInsert.length}`
  );

  // Update sync state
  if (failed.length === 0 && maxDelegationEpoch >= lastProcessedEpoch) {
    await delegationClient.stakeDelegationSyncState.update({
      where: { id: STAKE_DELEGATION_SYNC_STATE_ID },
      data: { lastProcessedEpoch: maxDelegationEpoch },
    });
  }

  await (prisma as any).syncStatus.upsert({
    where: { jobName: DELEGATION_FULL_SCAN_WINDOW_JOB_NAME },
    create: {
      jobName: DELEGATION_FULL_SCAN_WINDOW_JOB_NAME,
      displayName: "DRep Delegation Full Scan Window",
      isRunning: false,
      completedAt: new Date(),
      lastResult: "success",
      itemsProcessed: allDelegatorsByStake.size,
      errorMessage: null,
    },
    update: {
      isRunning: false,
      completedAt: new Date(),
      lastResult: "success",
      itemsProcessed: allDelegatorsByStake.size,
      errorMessage: null,
    },
  });

  console.log(
    `[DRep Delegation Sync] metrics phase1Dreps=${drepIds.length} phase1Rows=${phase1DelegatorRows} uniqueStakes=${allStakeAddresses.size} newStakes=${newStakeAddresses.length} creates=${toCreate.length} updates=${toUpdate.length} cleared=${toClear.length} changesCandidate=${changeLog.length} changesInserted=${changeLogToInsert.length} fetchFailures=${failed.length}`
  );

  return {
    currentEpoch,
    lastProcessedEpoch,
    maxDelegationEpoch,
    drepsProcessed: delegatorFetchResult.successful.length,
    delegatorsProcessed: allDelegatorsByStake.size,
    statesUpdated: toCreate.length + toUpdate.length + toClear.length,
    changesInserted: changeLogToInsert.length,
    failed,
  };
}
