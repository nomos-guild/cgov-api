/**
 * Backfill DrepEpochSnapshot table with historical data.
 *
 * For each DRep, fetches the full voting power history from Koios
 * /drep_voting_power_history (returns all epochs in one paginated call).
 *
 * Delegator counts: Koios /drep_delegators per epoch per DRep is prohibitively
 * expensive (N DReps × M epochs). As a fallback we use the current delegatorCount
 * from the local Drep table for all epochs. TODO: Improve with historical
 * delegator counts once a cheaper data source is available.
 *
 * Also ensures EpochTotals rows exist with startTime for epochs 507+ so that
 * the /dreps/:drepId/history endpoint can map epochs to dates.
 *
 * Usage:
 *   npx ts-node src/scripts/backfill-drep-snapshots.ts
 */

import "dotenv/config";
import { prisma } from "../services/prisma";
import { koiosGet } from "../services/koios";
import { withRetry } from "../services/ingestion/utils";
import { processInParallel } from "../services/ingestion/parallel";
import type { KoiosDrepVotingPower, KoiosEpochInfo } from "../types/koios.types";
import { getKoiosCurrentEpoch, chunkArray } from "../services/ingestion/sync-utils";

// Conway era started at epoch 507 — no DReps before that
const CONWAY_START_EPOCH = 507;
const BACKFILL_CONCURRENCY = 3;
const DB_CHUNK_SIZE = 500;
const KOIOS_PAGE_SIZE = 1000;

// ============================================================
// Koios Helpers
// ============================================================

/**
 * Fetches ALL voting power history entries for a single DRep across all epochs.
 * Koios /drep_voting_power_history with only _drep_id returns all epochs.
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
 * Fetches epoch info from Koios for a range of epochs.
 * Used to backfill EpochTotals.startTime for epoch→date mapping.
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
// Main
// ============================================================

async function main() {
  console.log("[Backfill] Starting DRep epoch snapshot backfill...");

  const currentEpoch = await getKoiosCurrentEpoch();
  console.log(`[Backfill] Current epoch: ${currentEpoch}`);

  // Step 1: Ensure EpochTotals rows exist with startTime for epochs 507+
  console.log(
    `[Backfill] Step 1: Ensuring EpochTotals rows exist for epochs ${CONWAY_START_EPOCH}–${currentEpoch}...`
  );
  await backfillEpochTimestamps(currentEpoch);

  // Step 2: Fetch all DRep IDs and their current delegator counts from the DB
  const dreps = await prisma.drep.findMany({
    select: { drepId: true, delegatorCount: true },
    orderBy: { drepId: "asc" },
  });
  console.log(`[Backfill] Found ${dreps.length} DReps in database`);

  // Step 3: For each DRep, fetch voting power history and upsert snapshots
  console.log(
    `[Backfill] Step 2: Fetching voting power history and creating snapshots (concurrency=${BACKFILL_CONCURRENCY})...`
  );

  let totalSnapshotted = 0;
  let totalDrepsProcessed = 0;

  const result = await processInParallel(
    dreps,
    (d) => d.drepId,
    async (drep) => {
      const history = await fetchVotingPowerHistory(drep.drepId);

      // Filter to Conway era epochs only
      const conwayHistory = history.filter(
        (h) => h.epoch_no >= CONWAY_START_EPOCH && h.epoch_no <= currentEpoch
      );

      if (conwayHistory.length === 0) {
        return { drepId: drep.drepId, snapshotted: 0 };
      }

      // Use current delegatorCount as fallback for all epochs
      // TODO: Improve with per-epoch delegator counts from a cheaper source
      const delegatorCount = drep.delegatorCount ?? 0;

      const snapshotData = conwayHistory.map((h) => ({
        drepId: drep.drepId,
        epoch: h.epoch_no,
        delegatorCount,
        votingPower: BigInt(h.amount),
      }));

      let snapshotted = 0;
      const chunks = chunkArray(snapshotData, DB_CHUNK_SIZE);
      for (const chunk of chunks) {
        const result = await prisma.drepEpochSnapshot.createMany({
          data: chunk,
          skipDuplicates: true,
        });
        snapshotted += result.count;
      }

      totalDrepsProcessed++;
      totalSnapshotted += snapshotted;

      if (totalDrepsProcessed % 50 === 0) {
        console.log(
          `[Backfill] Progress: ${totalDrepsProcessed}/${dreps.length} DReps, ${totalSnapshotted} snapshots inserted`
        );
      }

      return { drepId: drep.drepId, snapshotted };
    },
    BACKFILL_CONCURRENCY
  );

  console.log(
    `[Backfill] Complete: ${result.successful.length} DReps processed, ${totalSnapshotted} snapshots inserted, ${result.failed.length} failures`
  );

  if (result.failed.length > 0) {
    console.error(
      "[Backfill] Failed DReps:",
      result.failed.slice(0, 20)
    );
  }
}

async function backfillEpochTimestamps(currentEpoch: number) {
  // Find epochs that are missing startTime in EpochTotals
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
    console.log("[Backfill] All epoch timestamps already present");
    return;
  }

  console.log(
    `[Backfill] Backfilling epoch timestamps for ${missingEpochs.length} epochs...`
  );

  const epochResult = await processInParallel(
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
    BACKFILL_CONCURRENCY
  );

  console.log(
    `[Backfill] Epoch timestamps: ${epochResult.successful.length} synced, ${epochResult.failed.length} failed`
  );
}

main()
  .catch((error) => {
    console.error("[Backfill] Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
