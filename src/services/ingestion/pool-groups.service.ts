/**
 * Pool Groups Service
 *
 * Handles pool grouping/entity attribution from Koios.
 * Maps pools to multi-pool operators for SPO Entity Voting Power Concentration KPI.
 */

import type { Prisma } from "@prisma/client";
import { koiosGet } from "../koios";
import type { KoiosPoolGroup } from "../../types/koios.types";
import { withRetry } from "./utils";
import {
  POOL_GROUPS_DB_UPDATE_CONCURRENCY,
  chunkArray,
} from "./sync-utils";
import { processInParallel } from "./parallel";

// ============================================================
// Constants
// ============================================================

const KOIOS_POOL_GROUPS_PAGE_SIZE = 1000;

// ============================================================
// Result Types
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
  const pageSize = KOIOS_POOL_GROUPS_PAGE_SIZE;
  let offset = 0;
  let hasMore = true;
  const groups: KoiosPoolGroup[] = [];

  while (hasMore) {
    const page = await withRetry(() =>
      koiosGet<KoiosPoolGroup[]>("/pool_groups", { limit: pageSize, offset })
    );

    if (page && page.length > 0) {
      groups.push(...page);
      offset += page.length;
      hasMore = page.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return groups;
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
    const poolGroups = await fetchAllPoolGroups();
    result.totalFetched = poolGroups.length;

    console.log(`[Pool Groups] Fetched ${poolGroups.length} pool group mappings from Koios`);

    if (poolGroups.length === 0) {
      console.log(`[Pool Groups] No pool groups found`);
      return result;
    }

    // Track unique group IDs
    const uniqueGroupIds = new Set<string>();

    // Get existing pool groups only for pools we just fetched
    const existingMap = new Map<string, string>();
    const poolIds = poolGroups
      .map((pg) => pg.pool_id_bech32)
      .filter((poolId): poolId is string => !!poolId);
    for (const chunk of chunkArray(poolIds, 5000)) {
      const existingGroups = await poolGroupClient.poolGroup.findMany({
        where: { poolId: { in: chunk } },
        select: { poolId: true, groupId: true },
      });
      for (const group of existingGroups) {
        existingMap.set(group.poolId, group.groupId);
      }
    }

    // Separate into creates and updates
    const toCreate: Array<{ groupId: string; poolId: string }> = [];
    const toUpdate: Array<{ poolId: string; groupId: string }> = [];

    for (const pg of poolGroups) {
      if (!pg.pool_id_bech32 || !pg.group_id) continue;

      uniqueGroupIds.add(pg.group_id);

      const existing = existingMap.get(pg.pool_id_bech32);
      if (!existing) {
        toCreate.push({
          groupId: pg.group_id,
          poolId: pg.pool_id_bech32,
        });
      } else if (existing !== pg.group_id) {
        // Group changed - need to update
        toUpdate.push({
          poolId: pg.pool_id_bech32,
          groupId: pg.group_id,
        });
      }
      // If existing === pg.group_id, no action needed
    }

    result.uniqueGroups = uniqueGroupIds.size;

    // Batch create new pool groups
    if (toCreate.length > 0) {
      const createResult = await poolGroupClient.poolGroup.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
      result.created = createResult.count;
    }

    // Update changed pool groups with bounded concurrency
    if (toUpdate.length > 0) {
      const updateResult = await processInParallel(
        toUpdate,
        (row) => row.poolId,
        async (row) => {
          await poolGroupClient.poolGroup.update({
            where: { poolId: row.poolId },
            data: { groupId: row.groupId },
          });
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
  const allGroups: Array<{ groupId: string; poolId: string }> =
    await poolGroupClient.poolGroup.findMany({
      select: { groupId: true, poolId: true },
    });

  // Count pools per group
  const groupSizes = new Map<string, number>();
  for (const pg of allGroups) {
    groupSizes.set(pg.groupId, (groupSizes.get(pg.groupId) ?? 0) + 1);
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
