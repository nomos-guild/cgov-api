/**
 * DRep delegator sync: daily UTC budget (max 2 completed heavy runs / day, sealed on full success)
 * and orchestration with in-process retry when Phase 1 returns per-DRep failures.
 *
 * State is stored in SyncStatus.backfillCursor for job `drep-delegator-sync` only (unused for that row otherwise).
 */

import type { PrismaClient } from "@prisma/client";
import {
  syncDrepDelegationChanges,
  type SyncDrepDelegationChangesResult,
} from "./delegation-sync.service";
import { prisma as defaultPrisma, withDbRead, withDbWrite } from "../prisma";

export const DREP_DELEGATOR_SYNC_JOB_NAME = "drep-delegator-sync";

/** Max completed heavy runs per UTC day (including in-process retry pair). */
export const DREP_DELEGATOR_DAILY_MAX_ATTEMPTS = 2;

const BUDGET_BLOB_PREFIX = "drepDailyBudget:v1:";

export type DrepDailyBudgetV1 = {
  day: string;
  attempts: number;
  sealed: boolean;
};

export type DrepDelegatorSyncOutcome =
  | { kind: "skipped"; result: SyncDrepDelegationChangesResult }
  | {
      kind: "completed";
      result: SyncDrepDelegationChangesResult;
      itemsProcessed: number;
      lockResult: "success" | "partial";
    };

/** UTC calendar day `YYYY-MM-DD` for budget boundaries. */
export function drepDelegatorBudgetUtcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Parse budget blob; null = no state (eligible). invalid = corrupt (fail closed). */
export function parseDrepDelegatorDailyBudget(
  backfillCursor: string | null | undefined
): DrepDailyBudgetV1 | null | "invalid" {
  if (backfillCursor == null || backfillCursor === "") {
    return null;
  }
  if (!backfillCursor.startsWith(BUDGET_BLOB_PREFIX)) {
    console.warn(
      "[DRep Delegator Sync] Daily budget: backfillCursor present but wrong prefix; treating as exhausted"
    );
    return "invalid";
  }
  const json = backfillCursor.slice(BUDGET_BLOB_PREFIX.length);
  try {
    const raw = JSON.parse(json) as unknown;
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as DrepDailyBudgetV1).day !== "string" ||
      typeof (raw as DrepDailyBudgetV1).attempts !== "number" ||
      typeof (raw as DrepDailyBudgetV1).sealed !== "boolean"
    ) {
      console.warn(
        "[DRep Delegator Sync] Daily budget: invalid JSON shape; treating as exhausted"
      );
      return "invalid";
    }
    return raw as DrepDailyBudgetV1;
  } catch {
    console.warn(
      "[DRep Delegator Sync] Daily budget: JSON parse error; treating as exhausted"
    );
    return "invalid";
  }
}

export function serializeDrepDelegatorDailyBudget(state: DrepDailyBudgetV1): string {
  return `${BUDGET_BLOB_PREFIX}${JSON.stringify(state)}`;
}

/**
 * True if we should not start another heavy run today (UTC).
 */
export function isDrepDelegatorDailyBudgetExhausted(
  backfillCursor: string | null | undefined,
  now = new Date()
): boolean {
  const today = drepDelegatorBudgetUtcDay(now);
  const parsed = parseDrepDelegatorDailyBudget(backfillCursor);
  if (parsed === "invalid") {
    return true;
  }
  if (parsed === null) {
    return false;
  }
  if (parsed.day !== today) {
    return false;
  }
  return (
    parsed.sealed || parsed.attempts >= DREP_DELEGATOR_DAILY_MAX_ATTEMPTS
  );
}

function sumProcessed(r: SyncDrepDelegationChangesResult): number {
  return r.statesUpdated + r.changesInserted;
}

async function persistDrepDelegatorDailyBudget(
  db: PrismaClient,
  completedSyncCalls: number,
  finalFullSuccess: boolean
): Promise<void> {
  const today = drepDelegatorBudgetUtcDay();
  await withDbWrite(
    `drep-delegator-sync.daily-budget.persist`,
    async () => {
      const row = await db.syncStatus.findUnique({
        where: { jobName: DREP_DELEGATOR_SYNC_JOB_NAME },
        select: { backfillCursor: true },
      });
      const current = parseDrepDelegatorDailyBudget(row?.backfillCursor);
      let prior = 0;
      if (current !== null && current !== "invalid" && current.day === today) {
        prior = current.attempts;
      }
      const attempts = Math.min(
        DREP_DELEGATOR_DAILY_MAX_ATTEMPTS,
        prior + completedSyncCalls
      );
      const sealed =
        finalFullSuccess || attempts >= DREP_DELEGATOR_DAILY_MAX_ATTEMPTS;
      const next: DrepDailyBudgetV1 = { day: today, attempts, sealed };
      await db.syncStatus.update({
        where: { jobName: DREP_DELEGATOR_SYNC_JOB_NAME },
        data: { backfillCursor: serializeDrepDelegatorDailyBudget(next) },
      });
    }
  );
}

export async function readDrepDelegatorDailyBudgetCursor(): Promise<
  string | null
> {
  return withDbRead(`drep-delegator-sync.daily-budget.read`, async () => {
    const row = await defaultPrisma.syncStatus.findUnique({
      where: { jobName: DREP_DELEGATOR_SYNC_JOB_NAME },
      select: { backfillCursor: true },
    });
    return row?.backfillCursor ?? null;
  });
}

/** Prior completed attempts recorded for the current UTC day (0 if none / other day). */
export async function readDrepDelegatorPriorAttemptsToday(
  db: PrismaClient
): Promise<number> {
  const row = await db.syncStatus.findUnique({
    where: { jobName: DREP_DELEGATOR_SYNC_JOB_NAME },
    select: { backfillCursor: true },
  });
  const today = drepDelegatorBudgetUtcDay();
  const cur = parseDrepDelegatorDailyBudget(row?.backfillCursor);
  if (cur === null || cur === "invalid" || cur.day !== today) {
    return 0;
  }
  return cur.attempts;
}

/**
 * Runs up to two full syncs in one lock: second call only if the first completed * with Phase 1 fetch failures. Throttle skips do not update the daily budget.
 */
export async function runDrepDelegatorSyncWithDailyRetry(
  db: PrismaClient
): Promise<DrepDelegatorSyncOutcome> {
  const prior = await readDrepDelegatorPriorAttemptsToday(db);
  const remainingSlots = Math.max(
    0,
    DREP_DELEGATOR_DAILY_MAX_ATTEMPTS - prior
  );

  let r1: SyncDrepDelegationChangesResult;
  try {
    r1 = await syncDrepDelegationChanges(db);
  } catch (e) {
    await persistDrepDelegatorDailyBudget(db, 1, false);
    throw e;
  }

  if (r1.skipped) {
    return { kind: "skipped", result: r1 };
  }

  let last = r1;
  let completedSyncCalls = 1;

  // In-run retry needs two free slots (this pass + one retry).
  const allowSecondPass = r1.failed.length > 0 && remainingSlots >= 2;

  try {
    if (allowSecondPass) {
      completedSyncCalls = 2;
      last = await syncDrepDelegationChanges(db);
    }
  } catch (e) {
    await persistDrepDelegatorDailyBudget(db, completedSyncCalls, false);
    throw e;
  }

  const finalFullSuccess = last.failed.length === 0;
  await persistDrepDelegatorDailyBudget(db, completedSyncCalls, finalFullSuccess);

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
