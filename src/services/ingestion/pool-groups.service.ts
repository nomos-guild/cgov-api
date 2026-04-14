/**
 * Pool Groups Service
 *
 * Handles pool grouping/entity attribution from Koios.
 * Maps pools to multi-pool operators for SPO Entity Voting Power Concentration KPI.
 */

import type { Prisma } from "@prisma/client";
import { listAllPoolGroups } from "../governanceProvider";
import type { KoiosPoolGroup } from "../../types/koios.types";
import {
  POOL_GROUPS_DB_UPDATE_CONCURRENCY,
  chunkArray,
} from "./sync-utils";
import { processInParallel } from "./parallel";
import { withIngestionDbWrite } from "./dbSession";

// ============================================================
// Constants
// ============================================================

export interface SyncPoolGroupsResult {
  totalFetched: number;
  created: number;
  updated: number;
  uniqueGroups: number;
  failed: number;
}

// ============================================================
// Private Helpers
// ============================================================

/**
 * Fetches all pool groups from Koios /pool_groups endpoint
 */
async function fetchAllPoolGroups(): Promise<KoiosPoolGroup[]> {
  return listAllPoolGroups({
    source: "ingestion.pool-groups.pool-groups",
  });
}

/**
 * Koios /pool_groups pagination can return the same pool_id on multiple pages (overlap or API quirks).
 * We key by pool_id_bech32 so sync metrics and createMany match real distinct pools.
 */
function dedupePoolGroupsByPoolId(rows: KoiosPoolGroup[]): KoiosPoolGroup[] {
  const byPool = new Map<string, KoiosPoolGroup>();
  for (const row of rows) {
    const id = row.pool_id_bech32?.trim();
    if (!id) continue;
    byPool.set(id, { ...row, pool_id_bech32: id });
  }
  return Array.from(byPool.values()).sort((a, b) =>
    a.pool_id_bech32.localeCompare(b.pool_id_bech32)
  );
}

/**
 * Stable entity id for PoolGroup.poolGroup (concentration / MPO mapping).
 *
 * Koios usually leaves `pool_group` null for single-pool operators and sets
 * `balanceanalytics_group` to "SINGLEPOOL". The old sync required `pool_group`
 * and dropped ~most~ rows, which capped the table near the count of multi-pool
 * operators only (~1000) instead of all pools returned by /pool_groups.
 *
 * Priority: koios pool_group → adastat_group → balanceanalytics_group (except
 * the generic SINGLEPOOL label) → pool id as its own entity.
 */
export function resolvePoolEntityId(pg: KoiosPoolGroup): string | null {
  const poolId = pg.pool_id_bech32?.trim();
  if (!poolId) return null;

  const fromKoios = pg.pool_group?.trim();
  if (fromKoios) return fromKoios;

  const fromAdastat = pg.adastat_group?.trim();
  if (fromAdastat) return fromAdastat;

  const fromBa = pg.balanceanalytics_group?.trim();
  if (fromBa && fromBa.toUpperCase() !== "SINGLEPOOL") return fromBa;

  return poolId;
}

// ============================================================
// Public API
// ============================================================

/**
 * Syncs pool group mappings from Koios.
 * 
 * This function:
 * 1. Fetches all pool groups from /pool_groups
 * 2. Upserts each pool -> group mapping into the PoolGroup table
 * 
 * The group_id typically represents a stake key or operator identifier
 * that ties multiple pools together under one entity.
 */
export async function syncPoolGroups(
  prisma: Prisma.TransactionClient
): Promise<SyncPoolGroupsResult> {
  console.log(`[Pool Groups] Starting pool groups sync...`);

  const poolGroupClient = prisma as Prisma.TransactionClient & {
    poolGroup: any;
  };

  const result: SyncPoolGroupsResult = {
    totalFetched: 0,
    created: 0,
    updated: 0,
    uniqueGroups: 0,
    failed: 0,
  };

  try {
    // Fetch all pool groups from Koios
    const rawRows = await fetchAllPoolGroups();
    const rawCount = rawRows.length;
    const poolGroups = dedupePoolGroupsByPoolId(rawRows);
    result.totalFetched = poolGroups.length;

    if (rawCount !== poolGroups.length) {
      console.warn(
        `[Pool Groups] De-duplicated Koios rows by pool_id: ${rawCount} -> ${poolGroups.length} unique pools ` +
          `(${rawCount - poolGroups.length} duplicate / overlapping rows dropped)`
      );
    } else {
      console.log(
        `[Pool Groups] Fetched ${poolGroups.length} pool group mappings from Koios (all unique pool ids)`
      );
    }

    if (poolGroups.length === 0) {
      console.log(`[Pool Groups] No pool groups found`);
      return result;
    }

    // Track unique group IDs
    const uniqueGroupIds = new Set<string>();

    // Get existing pool groups only for pools we just fetched
    const existingMap = new Map<
      string,
      {
        poolGroup: string;
        ticker: string | null;
        adastatGroup: string | null;
        balanceanalyticsGroup: string | null;
      }
    >();
    const poolIds = poolGroups
      .map((pg) => pg.pool_id_bech32)
      .filter((poolId): poolId is string => !!poolId);
    for (const chunk of chunkArray(poolIds, 5000)) {
      const existingGroups = await poolGroupClient.poolGroup.findMany({
        where: { poolId: { in: chunk } },
        select: {
          poolId: true,
          poolGroup: true,
          ticker: true,
          adastatGroup: true,
          balanceanalyticsGroup: true,
        },
      });
      for (const group of existingGroups) {
        existingMap.set(group.poolId, {
          poolGroup: group.poolGroup,
          ticker: group.ticker ?? null,
          adastatGroup: group.adastatGroup ?? null,
          balanceanalyticsGroup: group.balanceanalyticsGroup ?? null,
        });
      }
    }

    // Separate into creates and updates
    const toCreate: Array<{
      poolId: string;
      poolGroup: string;
      ticker?: string | null;
      adastatGroup?: string | null;
      balanceanalyticsGroup?: string | null;
    }> = [];
    const toUpdate: Array<{
      poolId: string;
      poolGroup: string;
      ticker: string | null;
      adastatGroup: string | null;
      balanceanalyticsGroup: string | null;
    }> = [];

    let skippedNoPoolId = 0;
    const entitySource = {
      koiosPoolGroup: 0,
      adastat: 0,
      balanceAnalytics: 0,
      perPoolId: 0,
    };

    for (const pg of poolGroups) {
      const poolId = pg.pool_id_bech32?.trim();
      if (!poolId) {
        skippedNoPoolId++;
        continue;
      }

      const poolGroup = resolvePoolEntityId(pg);
      if (!poolGroup) {
        skippedNoPoolId++;
        continue;
      }

      if (pg.pool_group?.trim()) entitySource.koiosPoolGroup++;
      else if (pg.adastat_group?.trim()) entitySource.adastat++;
      else if (
        pg.balanceanalytics_group?.trim() &&
        pg.balanceanalytics_group.trim().toUpperCase() !== "SINGLEPOOL"
      ) {
        entitySource.balanceAnalytics++;
      } else {
        entitySource.perPoolId++;
      }

      uniqueGroupIds.add(poolGroup);

      const existing = existingMap.get(poolId);
      const ticker = pg.ticker ?? null;
      const adastatGroup = pg.adastat_group ?? null;
      const balanceanalyticsGroup = pg.balanceanalytics_group ?? null;

      if (!existing) {
        toCreate.push({
          poolId,
          poolGroup,
          ticker,
          adastatGroup,
          balanceanalyticsGroup,
        });
      } else if (
        existing.poolGroup !== poolGroup ||
        existing.ticker !== ticker ||
        existing.adastatGroup !== adastatGroup ||
        existing.balanceanalyticsGroup !== balanceanalyticsGroup
      ) {
        // Any field changed - need to update
        toUpdate.push({
          poolId,
          poolGroup,
          ticker,
          adastatGroup,
          balanceanalyticsGroup,
        });
      }
      // If unchanged, no action needed
    }

    result.uniqueGroups = uniqueGroupIds.size;

    console.log(
      `[Pool Groups] Entity resolution: koios_pool_group=${entitySource.koiosPoolGroup}, ` +
        `adastat=${entitySource.adastat}, balanceanalytics=${entitySource.balanceAnalytics}, ` +
        `per_pool_id=${entitySource.perPoolId}, skipped_no_pool_id=${skippedNoPoolId}`
    );

    // Batch create new pool groups
    if (toCreate.length > 0) {
      const createResult = await withIngestionDbWrite(
        prisma,
        "pool-groups.createMany",
        (): Promise<Prisma.BatchPayload> =>
          poolGroupClient.poolGroup.createMany({
            data: toCreate,
            skipDuplicates: true,
          })
      );
      result.created = createResult.count;
    }

    // Update changed pool groups with bounded concurrency
    if (toUpdate.length > 0) {
      const updateResult = await processInParallel(
        toUpdate,
        (row) => row.poolId,
        async (row) => {
          await withIngestionDbWrite(prisma, "pool-groups.update", () =>
            poolGroupClient.poolGroup.update({
              where: { poolId: row.poolId },
              data: {
                poolGroup: row.poolGroup,
                ticker: row.ticker,
                adastatGroup: row.adastatGroup,
                balanceanalyticsGroup: row.balanceanalyticsGroup,
              },
            })
          );
          return row;
        },
        POOL_GROUPS_DB_UPDATE_CONCURRENCY
      );
      result.updated = updateResult.successful.length;
      result.failed = updateResult.failed.length;
      if (updateResult.failed.length > 0) {
        console.warn(
          `[Pool Groups] Failed updates: ${updateResult.failed.length}`
        );
      }
    }

    console.log(
      `[Pool Groups] Sync complete: ${result.totalFetched} fetched, ` +
      `${result.created} created, ${result.updated} updated, ` +
      `${result.uniqueGroups} unique groups, ${result.failed} failed`
    );
  } catch (error: any) {
    console.error(
      `[Pool Groups] Failed to sync pool groups: ${error?.message ?? String(error)}`
    );
    throw error;
  }

  return result;
}

/**
 * Gets pool grouping statistics for analytics.
 * Returns the number of pools per group for concentration analysis.
 */
export async function getPoolGroupStats(
  prisma: Prisma.TransactionClient
): Promise<{
  totalPools: number;
  totalGroups: number;
  multiPoolGroups: number;
  largestGroupSize: number;
  poolsByGroupSize: Map<number, number>;
}> {
  const poolGroupClient = prisma as Prisma.TransactionClient & {
    poolGroup: any;
  };

  // Get all pool groups
  const allGroups: Array<{ poolGroup: string; poolId: string }> =
    await poolGroupClient.poolGroup.findMany({
      select: { poolGroup: true, poolId: true },
    });

  // Count pools per group
  const groupSizes = new Map<string, number>();
  for (const pg of allGroups) {
    groupSizes.set(pg.poolGroup, (groupSizes.get(pg.poolGroup) ?? 0) + 1);
  }

  // Calculate statistics
  let multiPoolGroups = 0;
  let largestGroupSize = 0;
  const poolsByGroupSize = new Map<number, number>();

  for (const size of groupSizes.values()) {
    if (size > 1) multiPoolGroups++;
    if (size > largestGroupSize) largestGroupSize = size;

    poolsByGroupSize.set(size, (poolsByGroupSize.get(size) ?? 0) + 1);
  }

  return {
    totalPools: allGroups.length,
    totalGroups: groupSizes.size,
    multiPoolGroups,
    largestGroupSize,
    poolsByGroupSize,
  };
}
