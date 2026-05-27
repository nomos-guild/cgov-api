/**
 * Populate StakeDelegationChange.amount_at_switch from Koios /account_history.
 * Each row records `active_stake` at the delegation switch epoch (true historical
 * weight, not the current-state proxy via stake_delegation_state.amount).
 *
 * Idempotent: only operates on rows where amount_at_switch IS NULL.
 *
 * Outcomes per (stake_address, epoch):
 *  - "koios-history" + amountAtSwitch=value — Koios returned a parsed integer.
 *  - "unknown"       + amountAtSwitch=0n    — Koios returned no entry (active_stake
 *    was zero / unbonded at that epoch start). Stable; not retried.
 *  - "koios-malformed" + amountAtSwitch=NULL — Koios returned a value we couldn't
 *    validate as a non-negative integer. Tagged for observability; the
 *    {addr, epoch, raw} tuple is logged. Excluded from subsequent candidate
 *    queries by default so it doesn't pin the queue head; operators can clear
 *    the tag and re-run with `excludeMalformed=false` to retry.
 *
 * Steady-state: small batch every cron tick fills new rows as they land.
 * One-off: run scripts/backfill-amount-at-switch.ts to drain the backlog.
 */

import { prisma } from "../prisma";
import { getAccountHistoryBatch } from "../governanceProvider";

export interface MigrationAmountBackfillResult {
  durationMs: number;
  rowsScanned: number;
  rowsUpdated: number;
  rowsUnknown: number;
  rowsMalformed: number;
  epochsProcessed: number;
  epochSpan: { min: number; max: number } | null;
}

export interface MigrationAmountBackfillOptions {
  /** Cap on changelog rows to attempt this run. Default 1000. */
  maxRows?: number;
  /** Cap on (addr, epoch) pairs per Koios call. Default 50 (matches /account_info batch). */
  batchSize?: number;
  /** Source tag for Koios telemetry / pressure-guard logs. */
  source?: string;
  /**
   * When true (default) the candidate query skips rows already tagged
   * `koios-malformed`, so chronic-malformed rows can't pin the head of the
   * `amount_at_switch IS NULL` queue and stall progress on later rows.
   * Operator path: clear `amount_source='koios-malformed'` via SQL then re-run
   * with this flag set to false to retry them.
   */
  excludeMalformed?: boolean;
}

/**
 * Koios `/account_history.active_stake` is documented as a non-negative integer
 * lovelace amount serialized as a *string*. JavaScript's `BigInt(s)` is permissive
 * — `BigInt("")` returns `0n`, `BigInt("0x1f")` returns `31n`, `BigInt("-1")`
 * returns `-1n` — so we validate the shape before parsing.
 *
 * Numbers are rejected: mainnet whale stakes routinely exceed `Number.MAX_SAFE_INTEGER`,
 * so a `number` here would already have been rounded by the JSON parser and is no
 * longer safe to widen to BigInt.
 */
function parseActiveStake(raw: unknown): bigint | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

/**
 * Drains up to `maxRows` rows from StakeDelegationChange where amount_at_switch IS NULL.
 * Groups by epoch (Koios /account_history takes one epoch per call), fans out 50 stake
 * addresses per call, updates rows in bulk.
 */
export async function backfillAmountAtSwitch(
  opts: MigrationAmountBackfillOptions = {}
): Promise<MigrationAmountBackfillResult> {
  const startedAt = Date.now();
  const maxRows = opts.maxRows ?? 1000;
  const source = opts.source ?? "ingestion.migration-amount-backfill";
  const excludeMalformed = opts.excludeMalformed !== false;

  const candidates = await prisma.stakeDelegationChange.findMany({
    where: {
      amountAtSwitch: null,
      delegatedEpoch: { not: -1 },
      stakeAddress: { not: "" },
      ...(excludeMalformed
        ? { OR: [{ amountSource: null }, { amountSource: { not: "koios-malformed" } }] }
        : {}),
    },
    orderBy: [{ delegatedEpoch: "asc" }, { id: "asc" }],
    take: maxRows,
    select: { id: true, stakeAddress: true, delegatedEpoch: true },
  });

  if (candidates.length === 0) {
    return {
      durationMs: Date.now() - startedAt,
      rowsScanned: 0,
      rowsUpdated: 0,
      rowsUnknown: 0,
      rowsMalformed: 0,
      epochsProcessed: 0,
      epochSpan: null,
    };
  }

  const byEpoch = new Map<number, Array<{ id: number; stakeAddress: string }>>();
  for (const r of candidates) {
    const list = byEpoch.get(r.delegatedEpoch) ?? [];
    list.push({ id: r.id, stakeAddress: r.stakeAddress });
    byEpoch.set(r.delegatedEpoch, list);
  }

  let rowsUpdated = 0;
  let rowsUnknown = 0;
  let rowsMalformed = 0;
  const epochs = [...byEpoch.keys()].sort((a, b) => a - b);

  for (const epoch of epochs) {
    const stakes = byEpoch.get(epoch) ?? [];
    const addrs = [...new Set(stakes.map((s) => s.stakeAddress))];

    const entries = await getAccountHistoryBatch({
      stakeAddresses: addrs,
      epochNo: epoch,
      source,
    });

    const amountByAddr = new Map<string, bigint>();
    const malformedByAddr = new Map<string, unknown>();
    for (const e of entries) {
      for (const h of e.history ?? []) {
        if (h.epoch_no !== epoch) continue;
        const parsed = parseActiveStake(h.active_stake);
        if (parsed != null) {
          amountByAddr.set(e.stake_address, parsed);
        } else {
          malformedByAddr.set(e.stake_address, h.active_stake);
        }
        break; // one record per stake/epoch when filtered
      }
    }

    // Bucket rows per outcome so we can flush each bucket as a single SQL
    // statement instead of paying a round-trip per row (was 200 sequential
    // updates per cron tick).
    //   - history:  per-row amount differs → one UPDATE...FROM(VALUES) join.
    //   - unknown:  same data for every row → one updateMany.
    //   - malformed: same data for every row → one updateMany. The (addr, epoch, raw)
    //               tuple is logged BEFORE the batch flush so ops still gets per-row
    //               diagnostics.
    const historyBucket: Array<{ id: number; amount: bigint }> = [];
    const unknownIds: number[] = [];
    const malformedIds: number[] = [];

    for (const stake of stakes) {
      const amt = amountByAddr.get(stake.stakeAddress);
      if (amt != null) {
        historyBucket.push({ id: stake.id, amount: amt });
        continue;
      }
      if (malformedByAddr.has(stake.stakeAddress)) {
        const raw = malformedByAddr.get(stake.stakeAddress);
        console.warn(
          `[migration-amount-backfill] malformed active_stake stake=${stake.stakeAddress} epoch=${epoch} raw=${JSON.stringify(raw)}`
        );
        malformedIds.push(stake.id);
        continue;
      }
      unknownIds.push(stake.id);
    }

    if (historyBucket.length > 0) {
      // Build one positional-bound UPDATE...FROM(VALUES) statement. A CASE WHEN
      // would also work but blows up the SQL text past Postgres' parser limits
      // for ~1000+ row batches. The VALUES form scales linearly with row count.
      const params: Array<number | string> = [];
      const valuesSql = historyBucket
        .map((b) => {
          params.push(b.id, b.amount.toString());
          // Postgres parses the second placeholder as text; the cast below
          // turns it back into bigint inside the join row source.
          return `($${params.length - 1}::int, $${params.length}::bigint)`;
        })
        .join(", ");
      await prisma.$executeRawUnsafe(
        `UPDATE "stake_delegation_change" AS s
           SET "amount_at_switch" = u.amt,
               "amount_source"    = 'koios-history'
         FROM (VALUES ${valuesSql}) AS u(id, amt)
         WHERE s."id" = u.id`,
        ...params
      );
      rowsUpdated += historyBucket.length;
    }

    if (unknownIds.length > 0) {
      await prisma.stakeDelegationChange.updateMany({
        where: { id: { in: unknownIds } },
        data: { amountAtSwitch: 0n, amountSource: "unknown" },
      });
      rowsUnknown += unknownIds.length;
    }

    if (malformedIds.length > 0) {
      await prisma.stakeDelegationChange.updateMany({
        where: { id: { in: malformedIds } },
        data: { amountSource: "koios-malformed" },
      });
      rowsMalformed += malformedIds.length;
    }
  }

  return {
    durationMs: Date.now() - startedAt,
    rowsScanned: candidates.length,
    rowsUpdated,
    rowsUnknown,
    rowsMalformed,
    epochsProcessed: epochs.length,
    epochSpan: epochs.length > 0 ? { min: epochs[0], max: epochs[epochs.length - 1] } : null,
  };
}
