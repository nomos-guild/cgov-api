/**
 * Shared utilities for sync services
 */

import { koiosGet } from "../koios";
import type { KoiosTip } from "../../types/koios.types";
import { getBoundedIntEnv } from "./syncLock";
export {
  extractBooleanField,
  extractStringField,
} from "./koiosNormalizers";

// ============================================================
// Constants
// ============================================================

export const KOIOS_DREP_LIST_PAGE_SIZE = 1000;
// Keep /drep_info payloads under Koios public request-size caps.
export const KOIOS_DREP_INFO_BATCH_SIZE = 10;
export const KOIOS_POOL_VP_PAGE_SIZE = 1000;
export const KOIOS_DREP_DELEGATORS_PAGE_SIZE = 1000;
export const KOIOS_ACCOUNT_LIST_PAGE_SIZE = 1000;
export const KOIOS_ACCOUNT_UPDATE_HISTORY_BATCH_SIZE = 25;
// PostgREST endpoints cap responses to max 1000 rows; use explicit paging for history backfills.
export const KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_SIZE = 1000;
// Keep tx_info batches bounded to respect Koios payload limits on public/free tiers.
export const KOIOS_TX_INFO_BATCH_SIZE = 25;
export const DREP_DELEGATOR_MIN_VOTING_POWER = BigInt(0);
/** Number of DRep shards; one shard is processed per sync run unless a full all-DRep scan runs. */
export const DREP_DELEGATION_SHARD_COUNT = 8;
/**
 * Max stake addresses refreshed via POST /account_info per sync run (cursor wraps).
 *
 * Sweep cadence: one full pass over all stake_address rows needs
 * ceil(stakeCount / this constant) successful runs. For ~70k stakes at 2500/run that is
 * 28 runs per full sweep. Default schedule is hourly at :52 (24×/day); lower frequency
 * lengthens the full sweep (see DREP_DELEGATOR_SYNC_SCHEDULE in sync-drep-delegators.job).
 * If inventory grows, increase frequency or raise this constant in a PR.
 */
export const DREP_DELEGATION_ACCOUNT_INFO_MAX_STAKES_PER_RUN = 2500;
/** Minimum days between full all-DRep GET /drep_delegators scans (drift safety net). */
export const DREP_DELEGATION_FULL_ALL_DREPS_MIN_INTERVAL_DAYS = 7;
/** Parallel /drep_delegators fetches; bounded to stay within Koios heavy-lane etiquette. */
export const DREP_DELEGATION_SYNC_CONCURRENCY = 4;
export const DREP_DELEGATION_DB_UPDATE_CONCURRENCY = 4;
export const DREP_INFO_SYNC_CONCURRENCY = getBoundedIntEnv(
  "DREP_INFO_SYNC_CONCURRENCY",
  2,
  1,
  20
);
export const DREP_LIFECYCLE_SYNC_CONCURRENCY = 3;
export const POOL_GROUPS_DB_UPDATE_CONCURRENCY = 4;
export const EPOCH_TOTALS_BACKFILL_CONCURRENCY = 2;
export const STAKE_DELEGATION_SYNC_STATE_ID = "current";
export const DREP_DELEGATION_BACKFILL_JOB_NAME = "drep-delegation-backfill";
export const FORCE_DREP_DELEGATION_BACKFILL_JOB_NAME = "drep-delegation-backfill-force";
export const DREP_DELEGATION_PHASE3_JOB_NAME = "drep-delegation-phase3";
/** Lease duration for `drep-delegator-sync` (HTTP trigger and in-process cron must match). */
export const DREP_DELEGATOR_SYNC_LOCK_TTL_MS = 3 * 60 * 60 * 1000;
/** Lease for `drep-lifecycle-sync` (/drep_updates for all DReps; runs can exceed 1–2h). */
export const DREP_LIFECYCLE_SYNC_LOCK_TTL_MS = 3 * 60 * 60 * 1000;
const KOIOS_CURRENT_EPOCH_CACHE_TTL_MS = 5_000;

// ============================================================
// Type Helpers
// ============================================================

/**
 * Converts a string value to BigInt, returning null if invalid.
 */
export function toBigIntOrNull(value: string | null | undefined): bigint | null {
  if (value == null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Splits an array into chunks of a specified size.
 */
export function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

// ============================================================
// Koios Helpers
// ============================================================

/**
 * Gets the current epoch number from Koios.
 */
let cachedKoiosCurrentEpoch: number | null = null;
let cachedKoiosCurrentEpochExpiresAt = 0;
let inFlightKoiosCurrentEpoch: Promise<number> | null = null;

export async function getKoiosCurrentEpoch(): Promise<number> {
  const now = Date.now();
  if (
    cachedKoiosCurrentEpoch !== null &&
    cachedKoiosCurrentEpochExpiresAt > now
  ) {
    return cachedKoiosCurrentEpoch;
  }

  if (inFlightKoiosCurrentEpoch) {
    return inFlightKoiosCurrentEpoch;
  }

  inFlightKoiosCurrentEpoch = koiosGet<KoiosTip[]>("/tip", undefined, {
      source: "ingestion.sync-utils.current-epoch",
    })
    .then((tip) => {
      const epoch = tip?.[0]?.epoch_no ?? 0;
      cachedKoiosCurrentEpoch = epoch;
      cachedKoiosCurrentEpochExpiresAt =
        Date.now() + KOIOS_CURRENT_EPOCH_CACHE_TTL_MS;
      return epoch;
    })
    .finally(() => {
      inFlightKoiosCurrentEpoch = null;
    });

  return inFlightKoiosCurrentEpoch;
}

export const getCurrentEpoch = getKoiosCurrentEpoch;

// ============================================================
// Checkpoint Types
// ============================================================

/**
 * Phase 3 checkpoint structure stored as JSON in backfillCursor
 */
export interface Phase3Checkpoint {
  epoch: number;
  createsComplete: boolean;
  updateChunkIndex: number;
  changesChunkIndex: number;
}
