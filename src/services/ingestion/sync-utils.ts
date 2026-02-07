/**
 * Shared utilities for sync services
 */

import { koiosGet } from "../koios";
import type { KoiosTip } from "../../types/koios.types";
import { withRetry } from "./utils";

// ============================================================
// Constants
// ============================================================

export const KOIOS_DREP_LIST_PAGE_SIZE = 1000;
export const KOIOS_DREP_INFO_BATCH_SIZE = 50;
export const KOIOS_POOL_VP_PAGE_SIZE = 1000;
export const KOIOS_DREP_DELEGATORS_PAGE_SIZE = 1000;
export const KOIOS_ACCOUNT_LIST_PAGE_SIZE = 1000;
export const KOIOS_ACCOUNT_UPDATE_HISTORY_BATCH_SIZE = 10;
// PostgREST endpoints cap responses to max 1000 rows; use explicit paging for history backfills.
export const KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_SIZE = 1000;
// Keep tx_info batches small to respect Koios payload limits on public/free tiers.
export const KOIOS_TX_INFO_BATCH_SIZE = 10;
export const DREP_DELEGATOR_MIN_VOTING_POWER = BigInt(0);
export const DREP_DELEGATION_SYNC_CONCURRENCY = 2;
export const DREP_DELEGATION_DB_UPDATE_CONCURRENCY = 10;
export const DREP_INFO_SYNC_CONCURRENCY = 5;
export const DREP_LIFECYCLE_SYNC_CONCURRENCY = 5;
export const POOL_GROUPS_DB_UPDATE_CONCURRENCY = 10;
export const EPOCH_TOTALS_BACKFILL_CONCURRENCY = 2;
export const STAKE_DELEGATION_SYNC_STATE_ID = "current";
export const DREP_DELEGATION_BACKFILL_JOB_NAME = "drep-delegation-backfill";
export const FORCE_DREP_DELEGATION_BACKFILL_JOB_NAME = "drep-delegation-backfill-force";
export const DREP_DELEGATION_PHASE3_JOB_NAME = "drep-delegation-phase3";

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
 * Normalises Koios metadata fields that can be returned as plain strings
 * or as objects of the form `{ "@value": "..." }`.
 */
export function extractStringField(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const withValue = value as { [key: string]: unknown };
    const candidate = (withValue["@value"] ?? withValue["value"]) as unknown;
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

/**
 * Normalises Koios boolean-like metadata fields.
 */
export function extractBooleanField(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (normalised === "true") return true;
    if (normalised === "false") return false;
    return undefined;
  }
  if (typeof value === "object") {
    const withValue = value as { [key: string]: unknown };
    const candidate = withValue["@value"] ?? withValue["value"];
    return extractBooleanField(candidate);
  }
  return undefined;
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
export async function getKoiosCurrentEpoch(): Promise<number> {
  const tip = await withRetry(() => koiosGet<KoiosTip[]>("/tip"));
  return tip?.[0]?.epoch_no ?? 0;
}

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
