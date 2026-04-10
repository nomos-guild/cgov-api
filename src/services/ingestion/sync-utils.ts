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
export const KOIOS_ACCOUNT_UPDATE_HISTORY_BATCH_SIZE = 10;
// PostgREST endpoints cap responses to max 1000 rows; use explicit paging for history backfills.
export const KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_SIZE = 1000;
// Keep tx_info batches small to respect Koios payload limits on public/free tiers.
export const KOIOS_TX_INFO_BATCH_SIZE = 10;
export const DREP_DELEGATOR_MIN_VOTING_POWER = BigInt(0);
export const DREP_DELEGATION_SYNC_CONCURRENCY = 1;
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
