/**
 * Backfill DrepEpochSnapshot table with historical data.
 *
 * Phase 1: Ensure EpochTotals rows have startTime for epoch→date mapping.
 * Phase 2: Fetch voting power history from Koios and create snapshot rows
 *          (delegatorCount set to 0 as placeholder).
 * Phase 3: Reconstruct exact historical delegator counts from the
 *          StakeDelegationChange log (pure DB, no API calls).
 *
 * Prerequisites:
 *   - The DRep delegation sync (syncDrepDelegationChanges) must have completed
 *     at least one full run so that StakeDelegationChange records exist.
 *
 * Usage:
 *   npx ts-node src/scripts/backfill-drep-snapshots.ts
 */

import "dotenv/config";
import { prisma } from "../services/prisma";
import { koiosGet } from "../services/koios";
import { withRetry } from "../services/ingestion/utils";
import { processInParallel } from "../services/ingestion/parallel";
import type {
  KoiosDrepVotingPower,
  KoiosEpochInfo,
} from "../types/koios.types";
import {
  getKoiosCurrentEpoch,
  chunkArray,
} from "../services/ingestion/sync-utils";

// Conway era started at epoch 507 — no DReps before that
const CONWAY_START_EPOCH = 507;
const VOTING_POWER_CONCURRENCY = 3;
const DELEGATOR_CONCURRENCY = 5;
const DB_CHUNK_SIZE = 500;
const KOIOS_PAGE_SIZE = 1000;

// ============================================================
// Koios Helpers
// ============================================================

/**
 * Fetches ALL voting power history entries for a single DRep across all epochs.
 * Pages through the result set (PostgREST max 1000 per page).
 */
async function fetchVotingPowerHistory(
  drepId: string
): Promise<KoiosDrepVotingPower[]> {
  let offset = 0;
  let hasMore = true;
  const rows: KoiosDrepVotingPower[] = [];

  while (hasMore) {
    const page = await withRetry(() =>
      koiosGet<KoiosDrepVotingPower[]>("/drep_voting_power_history", {
        _drep_id: drepId,
        limit: KOIOS_PAGE_SIZE,
        offset,
      })
    );

    if (page && page.length > 0) {
      rows.push(...page);
      offset += page.length;
      hasMore = page.length === KOIOS_PAGE_SIZE;
    } else {
      hasMore = false;
    }
  }

  return rows;
}

/**
 * Fetches epoch info from Koios for a single epoch.
 */
async function fetchEpochInfo(epochNo: number): Promise<KoiosEpochInfo | null> {
  try {
    const rows = await withRetry(() =>
      koiosGet<KoiosEpochInfo[]>("/epoch_info", { _epoch_no: epochNo })
    );
    return rows?.find((r) => r.epoch_no === epochNo) ?? rows?.[0] ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// Phase 1: Epoch Timestamps
// ============================================================

async function phase1EpochTimestamps(currentEpoch: number) {
  console.log(
    `[Phase 1] Ensuring EpochTotals rows exist for epochs ${CONWAY_START_EPOCH}–${currentEpoch}...`
  );

  const allEpochs: number[] = [];
  for (let e = CONWAY_START_EPOCH; e <= currentEpoch; e++) {
    allEpochs.push(e);
  }

  const existingRows = await prisma.epochTotals.findMany({
    where: {
      epoch: { in: allEpochs },
      startTime: { not: null },
    },
    select: { epoch: true },
  });
  const existingSet = new Set(existingRows.map((r) => r.epoch));
  const missingEpochs = allEpochs.filter((e) => !existingSet.has(e));

  if (missingEpochs.length === 0) {
    console.log("[Phase 1] All epoch timestamps already present");
    return;
  }

  console.log(
    `[Phase 1] Backfilling timestamps for ${missingEpochs.length} epochs...`
  );

  const result = await processInParallel(
    missingEpochs,
    (e) => `${e}`,
    async (epochNo) => {
      const info = await fetchEpochInfo(epochNo);
      if (!info) return null;

      const startTime =
        info.start_time != null && info.start_time > 0
          ? new Date(info.start_time * 1000)
          : null;
      const endTime =
        info.end_time != null && info.end_time > 0
          ? new Date(info.end_time * 1000)
          : null;

      await prisma.epochTotals.upsert({
        where: { epoch: epochNo },
        update: {
          startTime,
          endTime,
          firstBlockTime: info.first_block_time ?? null,
          lastBlockTime: info.last_block_time ?? null,
          blockCount: info.blk_count ?? null,
          txCount: info.tx_count ?? null,
        },
        create: {
          epoch: epochNo,
          startTime,
          endTime,
          firstBlockTime: info.first_block_time ?? null,
          lastBlockTime: info.last_block_time ?? null,
          blockCount: info.blk_count ?? null,
          txCount: info.tx_count ?? null,
        },
      });

      return epochNo;
    },
    VOTING_POWER_CONCURRENCY
  );

  console.log(
    `[Phase 1] Done: ${result.successful.length} synced, ${result.failed.length} failed`
  );
}

// ============================================================
// Phase 2: Voting Power Snapshots (delegatorCount = 0 placeholder)
// ============================================================

async function phase2VotingPowerSnapshots(currentEpoch: number) {
  const dreps = await prisma.drep.findMany({
    select: { drepId: true },
    orderBy: { drepId: "asc" },
  });
  console.log(
    `[Phase 2] Fetching voting power history for ${dreps.length} DReps (concurrency=${VOTING_POWER_CONCURRENCY})...`
  );

  let totalSnapshotted = 0;
  let totalDrepsProcessed = 0;

  const result = await processInParallel(
    dreps,
    (d) => d.drepId,
    async (drep) => {
      const history = await fetchVotingPowerHistory(drep.drepId);

      const conwayHistory = history.filter(
        (h) => h.epoch_no >= CONWAY_START_EPOCH && h.epoch_no <= currentEpoch
      );

      if (conwayHistory.length === 0) {
        return { drepId: drep.drepId, snapshotted: 0 };
      }

      // delegatorCount = 0 as placeholder; Phase 3 will fill actual values
      const snapshotData = conwayHistory.map((h) => ({
        drepId: drep.drepId,
        epoch: h.epoch_no,
        delegatorCount: 0,
        votingPower: BigInt(h.amount),
      }));

      let snapshotted = 0;
      const chunks = chunkArray(snapshotData, DB_CHUNK_SIZE);
      for (const chunk of chunks) {
        const res = await prisma.drepEpochSnapshot.createMany({
          data: chunk,
          skipDuplicates: true,
        });
        snapshotted += res.count;
      }

      totalDrepsProcessed++;
      totalSnapshotted += snapshotted;

      if (totalDrepsProcessed % 50 === 0) {
        console.log(
          `[Phase 2] Progress: ${totalDrepsProcessed}/${dreps.length} DReps, ${totalSnapshotted} snapshots inserted`
        );
      }

      return { drepId: drep.drepId, snapshotted };
    },
    VOTING_POWER_CONCURRENCY
  );

  console.log(
    `[Phase 2] Done: ${result.successful.length} DReps processed, ${totalSnapshotted} snapshots inserted, ${result.failed.length} failures`
  );

  if (result.failed.length > 0) {
    console.error(
      "[Phase 2] Failed DReps:",
      result.failed.slice(0, 20)
    );
  }
}

// ============================================================
// Phase 3: Exact Delegator Counts from StakeDelegationChange
// ============================================================

/**
 * Reconstructs exact historical delegator counts from the StakeDelegationChange
 * log. For each DRep, incoming delegations (+1) and outgoing delegations (-1)
 * are aggregated per epoch into a running sum = exact delegator count.
 */
async function phase3ExactDelegatorCounts() {
  // Find DReps with snapshots that still have placeholder delegator counts
  const needsUpdate: Array<{ drep_id: string }> = await prisma.$queryRaw`
    SELECT "drep_id"
    FROM "drep_epoch_snapshot"
    GROUP BY "drep_id"
    HAVING COUNT(DISTINCT "delegator_count") = 1
  `;

  if (needsUpdate.length === 0) {
    console.log("[Phase 3] All DReps already have varied delegator counts — skipping");
    return;
  }

  // Check that StakeDelegationChange data exists
  const changeCount = await prisma.stakeDelegationChange.count();
  if (changeCount === 0) {
    console.error(
      "[Phase 3] No StakeDelegationChange records found. " +
      "Run the DRep delegation sync (syncDrepDelegationChanges) first."
    );
    return;
  }

  console.log(
    `[Phase 3] Reconstructing delegator counts for ${needsUpdate.length} DReps ` +
    `from ${changeCount} delegation change records (concurrency=${DELEGATOR_CONCURRENCY})...`
  );

  let totalUpdated = 0;
  let drepsProcessed = 0;
  let drepsSkippedNoData = 0;

  const result = await processInParallel(
    needsUpdate,
    (d) => d.drep_id,
    async (row) => {
      const drepId = row.drep_id;

      // Get snapshot epochs for this DRep
      const snapshots = await prisma.drepEpochSnapshot.findMany({
        where: { drepId },
        select: { id: true, epoch: true },
        orderBy: { epoch: "asc" },
      });

      if (snapshots.length === 0) {
        drepsProcessed++;
        return { drepId, updated: 0 };
      }

      // Incoming delegations: someone delegated TO this DRep → +1
      const incoming = await prisma.stakeDelegationChange.findMany({
        where: { toDrepId: drepId },
        select: { delegatedEpoch: true },
      });

      // Outgoing delegations: someone left this DRep → -1
      const outgoing = await prisma.stakeDelegationChange.findMany({
        where: { fromDrepId: drepId },
        select: { delegatedEpoch: true },
      });

      if (incoming.length === 0 && outgoing.length === 0) {
        drepsProcessed++;
        drepsSkippedNoData++;
        return { drepId, updated: 0 };
      }

      // Build epoch → net delta map
      const deltaByEpoch = new Map<number, number>();
      for (const { delegatedEpoch } of incoming) {
        if (delegatedEpoch < 0) continue; // skip -1 sentinel (unknown epoch)
        deltaByEpoch.set(
          delegatedEpoch,
          (deltaByEpoch.get(delegatedEpoch) ?? 0) + 1
        );
      }
      for (const { delegatedEpoch } of outgoing) {
        if (delegatedEpoch < 0) continue;
        deltaByEpoch.set(
          delegatedEpoch,
          (deltaByEpoch.get(delegatedEpoch) ?? 0) - 1
        );
      }

      // Sort by epoch and compute running cumulative sum
      const sortedEpochs = Array.from(deltaByEpoch.keys()).sort((a, b) => a - b);
      const cumulativeAtEpoch = new Map<number, number>();
      let running = 0;
      for (const epoch of sortedEpochs) {
        running += deltaByEpoch.get(epoch)!;
        cumulativeAtEpoch.set(epoch, running);
      }

      // For each snapshot epoch, find the delegator count
      // (the cumulative value at the latest delta epoch <= snapshot epoch)
      let updated = 0;
      for (const snap of snapshots) {
        let count = 0;
        for (const epoch of sortedEpochs) {
          if (epoch > snap.epoch) break;
          count = cumulativeAtEpoch.get(epoch)!;
        }
        // Guard against negative counts from incomplete data
        count = Math.max(0, count);

        await prisma.drepEpochSnapshot.update({
          where: { id: snap.id },
          data: { delegatorCount: count },
        });
        updated++;
      }

      drepsProcessed++;
      totalUpdated += updated;

      if (drepsProcessed % 50 === 0) {
        console.log(
          `[Phase 3] Progress: ${drepsProcessed}/${needsUpdate.length} DReps, ${totalUpdated} rows updated`
        );
      }

      return { drepId, updated };
    },
    DELEGATOR_CONCURRENCY
  );

  console.log(
    `[Phase 3] Done: ${result.successful.length} DReps processed, ` +
    `${totalUpdated} snapshot rows updated, ` +
    `${drepsSkippedNoData} DReps skipped (no change data), ` +
    `${result.failed.length} failures`
  );

  if (drepsSkippedNoData > 0) {
    console.warn(
      `[Phase 3] ${drepsSkippedNoData} DReps had no StakeDelegationChange records. ` +
      `Their delegator counts remain at 0. Ensure the delegation sync has completed a full run.`
    );
  }

  if (result.failed.length > 0) {
    console.error("[Phase 3] Failed DReps:", result.failed.slice(0, 20));
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log("[Backfill] Starting DRep epoch snapshot backfill...");

  const currentEpoch = await getKoiosCurrentEpoch();
  console.log(`[Backfill] Current epoch: ${currentEpoch}`);

  await phase1EpochTimestamps(currentEpoch);
  await phase2VotingPowerSnapshots(currentEpoch);
  await phase3ExactDelegatorCounts();

  console.log("[Backfill] All phases complete.");
}

main()
  .catch((error) => {
    console.error("[Backfill] Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
