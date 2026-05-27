/**
 * DRep delegator sync orchestration (in-process retry when Phase 1 returns per-DRep failures).
 */

import type { PrismaClient } from "@prisma/client";
import {
  syncDrepDelegationChanges,
  type SyncDrepDelegationChangesResult,
} from "./delegation-sync.service";
import { refreshMigrationAggregateWithResilience } from "./migration-aggregate.service";
import { snapshotService } from "../snapshot.service";
import { prisma as defaultPrisma } from "../prisma";

export const DREP_DELEGATOR_SYNC_JOB_NAME = "drep-delegator-sync";

export type DrepDelegatorSyncOutcome =
  | { kind: "skipped"; result: SyncDrepDelegationChangesResult }
  | {
      kind: "completed";
      result: SyncDrepDelegationChangesResult;
      itemsProcessed: number;
      lockResult: "success" | "partial";
    };

function sumProcessed(r: SyncDrepDelegationChangesResult): number {
  return r.statesUpdated + r.changesInserted;
}

/**
 * Runs up to two full syncs in one lock: second call only if the first completed with Phase 1 fetch failures.
 */
export async function runDrepDelegatorSyncWithDailyRetry(
  db: PrismaClient
): Promise<DrepDelegatorSyncOutcome> {
  const r1 = await syncDrepDelegationChanges(db);

  if (r1.skipped) {
    return { kind: "skipped", result: r1 };
  }

  let last = r1;
  let completedSyncCalls = 1;

  if (r1.failed.length > 0) {
    completedSyncCalls = 2;
    last = await syncDrepDelegationChanges(db);
  }

  const finalFullSuccess = last.failed.length === 0;

  const itemsProcessed =
    completedSyncCalls === 2
      ? sumProcessed(r1) + sumProcessed(last)
      : sumProcessed(last);

  // Refresh MigrationAggregate after the changelog is up-to-date, then
  // invalidate snapshot chunks + manifest so the next /snapshot/* read
  // recomposes against the fresh aggregate. Without this, /snapshot/chunks/*
  // can keep serving the previous epoch's migration totals (and final chunks
  // would even hit the immutable CDN cache for up to 30 days).
  try {
    const aggResult = await refreshMigrationAggregateWithResilience(db, 0);
    console.log(
      `[migration-aggregate] refreshed ${aggResult.rowsWritten} rows in ${aggResult.durationMs}ms`
    );
    if (aggResult.rowsWritten > 0) {
      const dropped = await db.snapshotCache.deleteMany({
        where: {
          OR: [
            { cacheKey: { startsWith: "snapshot:v1:chunk:" } },
            { cacheKey: { startsWith: "snapshot:v1:manifest" } },
          ],
        },
      });
      // Drop in-memory L1 too — readOrCompose checks L1 BEFORE L2, so without
      // this the same instance keeps serving the previous migration totals
      // for up to CACHE_TTL_FRESH_MS after a refresh.
      const l1Dropped = snapshotService.invalidateAll();
      console.log(
        `[snapshot-cache] dropped ${dropped.count} L2 + ${l1Dropped} L1 entries after migration aggregate refresh`
      );
    }
  } catch (e) {
    console.error("[migration-aggregate] refresh failed", e);
  }

  return {
    kind: "completed",
    result: last,
    itemsProcessed,
    lockResult: finalFullSuccess ? "success" : "partial",
  };
}

export async function readDrepDelegatorDailyBudgetCursor(): Promise<
  string | null
> {
  const row = await defaultPrisma.syncStatus.findUnique({
    where: { jobName: DREP_DELEGATOR_SYNC_JOB_NAME },
    select: { backfillCursor: true },
  });
  return row?.backfillCursor ?? null;
}
