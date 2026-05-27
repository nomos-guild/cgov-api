/**
 * Backfill StakeDelegationChange.amount_at_switch from Koios /account_history.
 * Populates historical active_stake at each delegation switch epoch so the
 * MigrationAggregate sums true on-chain values rather than the current-state
 * proxy via stake_delegation_state.
 *
 * Idempotent + resumable: only touches rows where amount_at_switch IS NULL.
 *
 * Prerequisites:
 *   - DATABASE_URL configured.
 *   - Koios pressure budget tolerates ~1000 calls (full mainnet drain ~30 min).
 *
 * Environment (optional):
 *   - AMOUNT_AT_SWITCH_BATCH_ROWS=2000      // rows per pass (default 2000)
 *   - AMOUNT_AT_SWITCH_MAX_PASSES=200       // safety cap (default 200; ~400k rows)
 *   - AMOUNT_AT_SWITCH_PASS_RETRIES=4       // per-pass retries before giving up (default 4)
 *   - AMOUNT_AT_SWITCH_BACKOFF_BASE_MS=1500 // base backoff (default 1500ms; doubles each retry, capped 60s)
 *
 * Usage:
 *   npx ts-node src/scripts/backfill-amount-at-switch.ts
 */

import "dotenv/config";
import { formatAxiosLikeError } from "../utils/format-http-client-error";
import { prisma } from "../services/prisma";
import {
  backfillAmountAtSwitch,
  type MigrationAmountBackfillResult,
} from "../services/ingestion/migration-amount-backfill.service";
import { refreshMigrationAggregate } from "../services/ingestion/migration-aggregate.service";

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one backfill pass with bounded retry + exponential backoff. A single
 * Koios 5xx or timeout used to abort the whole drain (and the trailing
 * MigrationAggregate refresh + cache flush never ran). Now: per-pass retries
 * absorb transient failures; only a sustained outage propagates.
 */
async function runPassWithRetry(
  passIndex: number,
  batchSize: number,
  maxRetries: number,
  baseBackoffMs: number
): Promise<MigrationAmountBackfillResult> {
  let attempt = 0;
  // Inclusive: attempt 0 is the initial try, 1..maxRetries are retries.
  while (true) {
    try {
      return await backfillAmountAtSwitch({
        maxRows: batchSize,
        source: "scripts.backfill-amount-at-switch",
      });
    } catch (e) {
      attempt += 1;
      if (attempt > maxRetries) {
        console.error(
          `[backfill-amount-at-switch] pass ${passIndex + 1} exhausted ${maxRetries} retries — propagating`,
          formatAxiosLikeError(e)
        );
        throw e;
      }
      const sleepMs = Math.min(baseBackoffMs * 2 ** (attempt - 1), 60_000);
      console.warn(
        `[backfill-amount-at-switch] pass ${passIndex + 1} attempt ${attempt}/${maxRetries} failed — retrying in ${sleepMs}ms`,
        formatAxiosLikeError(e)
      );
      await sleep(sleepMs);
    }
  }
}

async function main() {
  const batchSize = parseIntEnv("AMOUNT_AT_SWITCH_BATCH_ROWS", 2000);
  const maxPasses = parseIntEnv("AMOUNT_AT_SWITCH_MAX_PASSES", 200);
  const passRetries = parseIntEnv("AMOUNT_AT_SWITCH_PASS_RETRIES", 4);
  const backoffBaseMs = parseIntEnv("AMOUNT_AT_SWITCH_BACKOFF_BASE_MS", 1500);

  console.log(
    `[backfill-amount-at-switch] starting — batchSize=${batchSize} maxPasses=${maxPasses} passRetries=${passRetries} backoffBaseMs=${backoffBaseMs}`
  );

  let totalScanned = 0;
  let totalUpdated = 0;
  let totalUnknown = 0;
  let totalMalformed = 0;
  let totalEpochs = 0;
  let pass = 0;

  for (pass = 0; pass < maxPasses; pass++) {
    const result = await runPassWithRetry(pass, batchSize, passRetries, backoffBaseMs);

    totalScanned += result.rowsScanned;
    totalUpdated += result.rowsUpdated;
    totalUnknown += result.rowsUnknown;
    totalMalformed += result.rowsMalformed;
    totalEpochs += result.epochsProcessed;

    console.log(
      `[backfill-amount-at-switch] pass ${pass + 1}: scanned=${result.rowsScanned} updated=${result.rowsUpdated} unknown=${result.rowsUnknown} malformed=${result.rowsMalformed} epochs=${result.epochsProcessed} span=${
        result.epochSpan ? `[${result.epochSpan.min}, ${result.epochSpan.max}]` : "none"
      } in ${result.durationMs}ms`
    );

    if (result.rowsScanned === 0) {
      console.log("[backfill-amount-at-switch] no more rows — done.");
      break;
    }
  }

  // Distinguish "drained the queue" from "hit the safety cap with rows remaining".
  // We still run the trailing refresh + cache flush so the partial work is
  // observable through /migrations + /snapshot/*; the operator can re-run the
  // script (or raise AMOUNT_AT_SWITCH_MAX_PASSES) to drain the rest.
  if (pass >= maxPasses) {
    console.warn(
      `[backfill-amount-at-switch] reached maxPasses=${maxPasses} with rows still pending — re-run or raise AMOUNT_AT_SWITCH_MAX_PASSES to drain the rest`
    );
  }

  console.log(
    `[backfill-amount-at-switch] FINISHED in ${pass} pass(es): scanned=${totalScanned} updated=${totalUpdated} unknown=${totalUnknown} malformed=${totalMalformed} epochs=${totalEpochs}`
  );

  console.log("[backfill-amount-at-switch] refreshing MigrationAggregate so it picks up the new amounts...");
  const aggResult = await refreshMigrationAggregate(prisma, 0);
  console.log(
    `[backfill-amount-at-switch] MigrationAggregate refreshed — ${aggResult.rowsWritten} rows in ${aggResult.durationMs}ms`
  );

  // Invalidate snapshot cache so /snapshot/chunks/* don't keep serving the
  // pre-backfill migration totals from L2 (and so final chunks become eligible
  // for `immutable` once isStable=true on the next compose).
  const dropped = await prisma.snapshotCache.deleteMany({
    where: {
      OR: [
        { cacheKey: { startsWith: "snapshot:v1:chunk:" } },
        { cacheKey: { startsWith: "snapshot:v1:manifest" } },
      ],
    },
  });
  console.log(
    `[backfill-amount-at-switch] dropped ${dropped.count} snapshot_cache rows so /snapshot/* recomposes against fresh aggregate`
  );
}

main()
  .catch((e) => {
    console.error("[backfill-amount-at-switch] FAILED", formatAxiosLikeError(e));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
