/**
 * MigrationAggregate ingestion — pre-aggregates StakeDelegationChange events
 * by (epoch, fromDrepId, toDrepId) into the migration_aggregate table for
 * fast /migrations responses.
 *
 * Refresh strategy: drop + INSERT...SELECT all rows ≥ minEpoch in one
 * idempotent SQL statement. Triggered at the end of each successful
 * sync-drep-delegators run.
 *
 * ada accuracy:
 *   - When stake_delegation_change.amount_at_switch is populated by the
 *     /account_history ingestion, we use that (true on-chain active_stake
 *     at the switch epoch).
 *   - Otherwise we fall back to stake_delegation_state.amount (current proxy).
 *   The fraction populated by each source is reported in /migrations meta.accuracy.
 */

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma";
import { withDbRead, withDbWrite } from "../prisma";
import {
  DREP_ALWAYS_ABSTAIN,
  DREP_ALWAYS_NO_CONFIDENCE,
} from "../../libs/sentinels";

export interface MigrationAggregateRefreshResult {
  rowsWritten: number;
  durationMs: number;
  fromEpoch: number;
}

export interface MigrationAggregateAccuracy {
  /** "koios-history" if ≥99% rows have amount_at_switch from /account_history; "mixed" if partial; "current" if backfill not yet started */
  level: "koios-history" | "mixed" | "current";
  totalChangeRows: number;
  rowsWithKoiosHistory: number;
  rowsWithCurrentProxy: number;
  rowsUnknown: number;
  /** Rows that hit a Koios parse failure on a previous backfill pass. amount_at_switch is NULL → MigrationAggregate falls back to current proxy until the next pass retries. */
  rowsMalformed: number;
}

/**
 * Re-aggregates migration_aggregate for all rows where delegated_epoch_no >= fromEpoch.
 * Idempotent — DELETE + INSERT...SELECT, safe to call repeatedly.
 *
 * Sentinel DReps (drep_always_abstain, drep_always_no_confidence) are KEPT in the
 * aggregate; the read endpoints filter them out by default but
 * `/migrations?excludeSentinels=false` and the snapshot composer can include
 * them when callers want.
 *
 * @param fromEpoch  Minimum delegated epoch to recompute. Use 0 (or omit) for full rebuild.
 */
export async function refreshMigrationAggregate(
  db: PrismaClient = defaultPrisma,
  fromEpoch: number = 0
): Promise<MigrationAggregateRefreshResult> {
  const startedAt = Date.now();

  // DELETE + INSERT in a transaction so /migrations readers never see a half-empty aggregate.
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      DELETE FROM "migration_aggregate"
      WHERE "epoch" >= ${fromEpoch}
    `;

    const inserted = await tx.$executeRaw`
      INSERT INTO "migration_aggregate"
        ("epoch", "from_drep_id", "to_drep_id", "ada_lovelace", "delegators", "computed_at")
      SELECT
        e."delegated_epoch_no" AS epoch,
        e."from_drep_id",
        e."to_drep_id",
        COALESCE(SUM(COALESCE(e."amount_at_switch", s."amount", 0)), 0) AS ada_lovelace,
        COUNT(DISTINCT e."stake_address") AS delegators,
        NOW() AS computed_at
      FROM "stake_delegation_change" e
      LEFT JOIN "stake_delegation_state" s ON s."stake_address" = e."stake_address"
      WHERE e."delegated_epoch_no" >= ${fromEpoch}
        AND e."delegated_epoch_no" <> -1
        AND e."from_drep_id" <> ''
        AND e."to_drep_id" <> ''
        AND e."from_drep_id" <> e."to_drep_id"
      GROUP BY e."delegated_epoch_no", e."from_drep_id", e."to_drep_id"
    `;

    return inserted;
  });

  return {
    rowsWritten: Number(result),
    durationMs: Date.now() - startedAt,
    fromEpoch,
  };
}

export interface AccuracyFilter {
  epochStart?: number;
  epochEnd?: number;
  fromDrepId?: string;
  toDrepId?: string;
  excludeSentinels?: boolean;
  /** When set, restrict to rows whose from_drep_id AND to_drep_id are in the list */
  drepIdAllowlist?: string[];
}

/**
 * Computes the source distribution of amount_at_switch across the
 * delegation changelog. When filters are passed, the result reflects ONLY
 * the rows feeding the corresponding /migrations response so callers don't
 * see "koios-history" overall while their filtered window is current-proxy
 * (or vice-versa).
 */
export async function getMigrationAggregateAccuracy(
  db: PrismaClient = defaultPrisma,
  filter: AccuracyFilter = {}
): Promise<MigrationAggregateAccuracy> {
  const POSTGRES_INT_MIN = -2_147_483_648;
  const POSTGRES_INT_MAX = 2_147_483_647;
  const epochStart = filter.epochStart ?? POSTGRES_INT_MIN;
  const epochEnd = filter.epochEnd ?? POSTGRES_INT_MAX;
  const excludeSentinels = filter.excludeSentinels !== false;
  const fromFilter = filter.fromDrepId ?? null;
  const toFilter = filter.toDrepId ?? null;
  const allowlist = filter.drepIdAllowlist ?? null;

  // Build conditional WHERE — Prisma's $queryRaw doesn't compose nicely from
  // optional fragments, so we use $queryRawUnsafe with positional params.
  // All values flow through parameter binding; no string interpolation of input.
  const params: unknown[] = [];
  const wheres: string[] = [
    `"delegated_epoch_no" <> -1`,
    `"from_drep_id" <> ''`,
    `"to_drep_id"   <> ''`,
    `"from_drep_id" <> "to_drep_id"`,
  ];
  params.push(epochStart);
  wheres.push(`"delegated_epoch_no" >= $${params.length}`);
  params.push(epochEnd);
  wheres.push(`"delegated_epoch_no" <= $${params.length}`);

  if (excludeSentinels) {
    params.push(DREP_ALWAYS_ABSTAIN, DREP_ALWAYS_NO_CONFIDENCE);
    wheres.push(`"from_drep_id" NOT IN ($${params.length - 1}, $${params.length})`);
    params.push(DREP_ALWAYS_ABSTAIN, DREP_ALWAYS_NO_CONFIDENCE);
    wheres.push(`"to_drep_id"   NOT IN ($${params.length - 1}, $${params.length})`);
  }
  if (fromFilter) {
    params.push(fromFilter);
    wheres.push(`"from_drep_id" = $${params.length}`);
  }
  if (toFilter) {
    params.push(toFilter);
    wheres.push(`"to_drep_id" = $${params.length}`);
  }
  if (allowlist && allowlist.length > 0) {
    const placeholders: string[] = [];
    for (const id of allowlist) {
      params.push(id);
      placeholders.push(`$${params.length}`);
    }
    wheres.push(`"from_drep_id" IN (${placeholders.join(",")})`);
    wheres.push(`"to_drep_id"   IN (${placeholders.join(",")})`);
  }

  const sql = `
    SELECT "amount_source", COUNT(*)::bigint AS n
    FROM "stake_delegation_change"
    WHERE ${wheres.join(" AND ")}
    GROUP BY "amount_source"
  `;

  const rows = await db.$queryRawUnsafe<
    Array<{ amount_source: string | null; n: bigint }>
  >(sql, ...params);

  let total = 0;
  let koios = 0;
  let proxy = 0;
  let unknown = 0;
  let malformed = 0;
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    if (r.amount_source === "koios-history") koios += n;
    else if (r.amount_source === "current-proxy") proxy += n;
    else if (r.amount_source === "unknown") unknown += n;
    else if (r.amount_source === "koios-malformed") malformed += n;
    else proxy += n;
  }

  let level: MigrationAggregateAccuracy["level"];
  if (total === 0) level = "current";
  else if (koios / total >= 0.99) level = "koios-history";
  else if (koios > 0) level = "mixed";
  else level = "current";

  return {
    level,
    totalChangeRows: total,
    rowsWithKoiosHistory: koios,
    rowsWithCurrentProxy: proxy,
    rowsUnknown: unknown,
    rowsMalformed: malformed,
  };
}

/**
 * Wrapper used by the cron job — records timing + errors via the existing
 * resilience layer.
 */
export async function refreshMigrationAggregateWithResilience(
  db: PrismaClient = defaultPrisma,
  fromEpoch: number = 0
): Promise<MigrationAggregateRefreshResult> {
  return withDbWrite(
    "migration-aggregate.refresh",
    () => refreshMigrationAggregate(db, fromEpoch)
  );
}

export async function readMigrationAggregateAccuracyWithResilience(
  db: PrismaClient = defaultPrisma
): Promise<MigrationAggregateAccuracy> {
  return withDbRead(
    "migration-aggregate.accuracy",
    () => getMigrationAggregateAccuracy(db)
  );
}
