/**
 * DRep delegator sync orchestration (in-process retry when Phase 1 returns per-DRep failures).
 */

import type { PrismaClient } from "@prisma/client";
import {
  syncDrepDelegationChanges,
  type SyncDrepDelegationChangesResult,
} from "./delegation-sync.service";
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
  let r1: SyncDrepDelegationChangesResult;
  try {
    r1 = await syncDrepDelegationChanges(db);
  } catch (e) {
    throw e;
  }

  if (r1.skipped) {
    return { kind: "skipped", result: r1 };
  }

  let last = r1;
  let completedSyncCalls = 1;

  const allowSecondPass = r1.failed.length > 0;

  try {
    if (allowSecondPass) {
      completedSyncCalls = 2;
      last = await syncDrepDelegationChanges(db);
    }
  } catch (e) {
    throw e;
  }

  const finalFullSuccess = last.failed.length === 0;

  const itemsProcessed =
    completedSyncCalls === 2
      ? sumProcessed(r1) + sumProcessed(last)
      : sumProcessed(last);

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
