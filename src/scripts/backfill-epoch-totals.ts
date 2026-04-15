/**
 * Backfill `epoch_totals` from Koios (same path as cron: governanceProvider → syncEpochTotals).
 *
 * Phase 1: Closed epochs — `syncMissingEpochAnalytics` (missing scan or full range resync).
 * Phase 2: Current epoch — always refresh row (no `totals_synced_at` for open epoch; matches production).
 *
 * Prerequisites:
 *   - DATABASE_URL, Koios env vars (see governance / koios client config).
 *   - Koios-heavy; concurrency is fixed inside sync (see EPOCH_TOTALS_BACKFILL_CONCURRENCY).
 *
 * Environment (optional):
 *   - EPOCH_TOTALS_BACKFILL_MODE=missing | all
 *       missing (default): only epochs without data, checkpoint, or incomplete (post-508 self-heal).
 *       all: every closed epoch in the resolved range (e.g. after truncate).
 *   - EPOCH_TOTALS_BACKFILL_START — inclusive lower bound (default 0).
 *   - EPOCH_TOTALS_BACKFILL_END — inclusive upper bound (default currentEpoch - 1, clamped).
 *
 * Usage:
 *   npx ts-node src/scripts/backfill-epoch-totals.ts
 */

import "dotenv/config";
import { formatAxiosLikeError } from "../utils/format-http-client-error";
import { prisma } from "../services/prisma";
import { getKoiosCurrentEpoch } from "../services/ingestion/sync-utils";
import {
  syncEpochTotals,
  syncMissingEpochAnalytics,
  type SyncMissingEpochAnalyticsMode,
  type SyncMissingEpochAnalyticsOptions,
} from "../services/ingestion/epoch-totals.service";

function parseOptionalIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

function resolveBackfillOptions(): SyncMissingEpochAnalyticsOptions {
  const modeRaw = (process.env.EPOCH_TOTALS_BACKFILL_MODE ?? "missing").toLowerCase();
  const mode: SyncMissingEpochAnalyticsMode =
    modeRaw === "all" ? "all" : "missing";

  const startEpoch = parseOptionalIntEnv("EPOCH_TOTALS_BACKFILL_START");
  const endEpoch = parseOptionalIntEnv("EPOCH_TOTALS_BACKFILL_END");

  const options: SyncMissingEpochAnalyticsOptions = { mode };
  if (startEpoch !== undefined) options.startEpoch = startEpoch;
  if (endEpoch !== undefined) options.endEpoch = endEpoch;
  return options;
}

// ============================================================
// Phase 1: Closed epochs
// ============================================================

async function phase1ClosedEpochTotals() {
  const opts = resolveBackfillOptions();
  console.log(
    `[Phase 1] syncMissingEpochAnalytics mode=${opts.mode ?? "missing"} startEpoch=${opts.startEpoch ?? "(default 0)"} endEpoch=${opts.endEpoch ?? "(default current-1)"}`
  );

  const backfill = await syncMissingEpochAnalytics(prisma, opts);
  const ts = new Date().toISOString();
  console.log(`[Phase 1] ${ts} result:`);
  console.log(
    `  currentEpoch=${backfill.currentEpoch} range=${backfill.startEpoch}–${backfill.endEpoch}`
  );
  console.log(
    `  missing=${backfill.totals.missing.length} attempted=${backfill.totals.attempted.length} synced=${backfill.totals.synced.length} failed=${backfill.totals.failed.length}`
  );

  if (backfill.totals.failed.length > 0) {
    console.error(
      "  First failures:",
      backfill.totals.failed.slice(0, 10)
    );
  }
}

// ============================================================
// Phase 2: Current epoch
// ============================================================

async function phase2CurrentEpochTotals(currentEpoch: number) {
  console.log(
    `[Phase 2] Refreshing epoch_totals for current epoch ${currentEpoch}...`
  );
  await syncEpochTotals(prisma, currentEpoch);
  console.log("[Phase 2] Done.");
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log("[Backfill] Starting epoch totals backfill...");

  const currentEpoch = await getKoiosCurrentEpoch();
  console.log(`[Backfill] Current epoch: ${currentEpoch}`);

  await phase1ClosedEpochTotals();
  await phase2CurrentEpochTotals(currentEpoch);

  console.log("[Backfill] All phases complete.");
}

main()
  .catch((error) => {
    console.error("[Backfill] Fatal error:", formatAxiosLikeError(error));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
