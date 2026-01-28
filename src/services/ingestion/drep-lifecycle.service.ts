/**
 * DRep Lifecycle Service
 *
 * Handles DRep registration, deregistration, and update event tracking from Koios.
 * Enables DRep Lifecycle Rate KPI computation.
 */

import type { Prisma } from "@prisma/client";
import { koiosGet } from "../koios";
import type { KoiosDrepUpdate } from "../../types/koios.types";
import { KOIOS_DREP_LIST_PAGE_SIZE } from "./sync-utils";

// ============================================================
// Constants
// ============================================================

const KOIOS_DREP_UPDATES_PAGE_SIZE = 1000;

// Cardano mainnet epoch reference point for converting block_time to epoch
// Epoch 208 started on July 29, 2020 (Shelley era start)
const EPOCH_208_START_UNIX = 1596059091; // Unix timestamp for epoch 208 start
const EPOCH_DURATION_SECONDS = 432000; // 5 days in seconds
const SHELLEY_START_EPOCH = 208;

// ============================================================
// Result Types
// ============================================================

export interface SyncDrepLifecycleResult {
  drepsProcessed: number;
  eventsIngested: number;
  eventsByType: {
    registration: number;
    deregistration: number;
    update: number;
  };
  failed: Array<{ drepId: string; error: string }>;
}

// ============================================================
// Private Helpers
// ============================================================

/**
 * Converts Unix timestamp to epoch number
 */
function blockTimeToEpoch(blockTime: number): number {
  if (blockTime < EPOCH_208_START_UNIX) {
    return 0; // Before Shelley era
  }
  return (
    SHELLEY_START_EPOCH +
    Math.floor((blockTime - EPOCH_208_START_UNIX) / EPOCH_DURATION_SECONDS)
  );
}

/**
 * Normalizes Koios action_type to our standard action names
 */
function normalizeActionType(actionType: string): string {
  const lower = actionType.toLowerCase();
  if (lower.includes("registration") && !lower.includes("de")) {
    return "registration";
  }
  if (lower.includes("deregistration") || lower.includes("de-registration")) {
    return "deregistration";
  }
  // Certificate updates, metadata updates, etc.
  return "update";
}

/**
 * Fetches all DRep IDs from Koios /drep_list
 */
async function fetchAllDrepIds(): Promise<string[]> {
  const pageSize = KOIOS_DREP_LIST_PAGE_SIZE;
  let offset = 0;
  let hasMore = true;
  const ids: string[] = [];

  while (hasMore) {
    const page = await koiosGet<Array<{ drep_id: string }>>(
      "/drep_list",
      { limit: pageSize, offset }
    );

    if (page && page.length > 0) {
      for (const row of page) {
        if (row?.drep_id) ids.push(row.drep_id);
      }
      offset += page.length;
      hasMore = page.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return ids;
}

/**
 * Fetches lifecycle events for a single DRep from Koios /drep_updates
 */
async function fetchDrepUpdates(drepId: string): Promise<KoiosDrepUpdate[]> {
  const pageSize = KOIOS_DREP_UPDATES_PAGE_SIZE;
  let offset = 0;
  let hasMore = true;
  const updates: KoiosDrepUpdate[] = [];

  while (hasMore) {
    const page = await koiosGet<KoiosDrepUpdate[]>(
      "/drep_updates",
      { _drep_id: drepId, limit: pageSize, offset }
    );

    if (page && page.length > 0) {
      updates.push(...page);
      offset += page.length;
      hasMore = page.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return updates;
}

// ============================================================
// Public API
// ============================================================

/**
 * Syncs DRep lifecycle events (registrations, deregistrations, updates) from Koios.
 * 
 * This function:
 * 1. Fetches all DRep IDs from /drep_list
 * 2. For each DRep, fetches their update history from /drep_updates
 * 3. Stores each event in the DrepLifecycleEvent table
 * 
 * Uses createMany with skipDuplicates for idempotent operation.
 */
export async function syncDrepLifecycleEvents(
  prisma: Prisma.TransactionClient
): Promise<SyncDrepLifecycleResult> {
  console.log(`[DRep Lifecycle] Starting lifecycle event sync...`);

  const lifecycleClient = prisma as Prisma.TransactionClient & {
    drepLifecycleEvent: any;
  };

  // Get all DRep IDs
  const drepIds = await fetchAllDrepIds();
  console.log(`[DRep Lifecycle] Found ${drepIds.length} DReps to process`);

  const result: SyncDrepLifecycleResult = {
    drepsProcessed: 0,
    eventsIngested: 0,
    eventsByType: {
      registration: 0,
      deregistration: 0,
      update: 0,
    },
    failed: [],
  };

  // Process each DRep
  for (const drepId of drepIds) {
    try {
      const updates = await fetchDrepUpdates(drepId);

      if (updates.length === 0) {
        result.drepsProcessed++;
        continue;
      }

      // Transform to event records
      const events = updates.map((update) => {
        const action = normalizeActionType(update.action_type);
        const epochNo = blockTimeToEpoch(update.block_time);

        return {
          drepId: update.drep_id,
          action,
          epochNo,
          blockTime: update.block_time,
          txHash: update.update_tx_hash,
        };
      });

      // Batch insert with skipDuplicates for idempotency
      const inserted = await lifecycleClient.drepLifecycleEvent.createMany({
        data: events,
        skipDuplicates: true,
      });

      result.eventsIngested += inserted.count;

      // Count by type
      for (const event of events) {
        if (event.action === "registration") {
          result.eventsByType.registration++;
        } else if (event.action === "deregistration") {
          result.eventsByType.deregistration++;
        } else {
          result.eventsByType.update++;
        }
      }

      result.drepsProcessed++;
    } catch (error: any) {
      result.failed.push({
        drepId,
        error: error?.message ?? String(error),
      });
    }
  }

  console.log(
    `[DRep Lifecycle] Sync complete: ${result.drepsProcessed} DReps processed, ` +
    `${result.eventsIngested} events ingested ` +
    `(reg=${result.eventsByType.registration}, dereg=${result.eventsByType.deregistration}, update=${result.eventsByType.update}), ` +
    `${result.failed.length} failed`
  );

  return result;
}

/**
 * Syncs DRep lifecycle events for a specific epoch range.
 * Useful for targeted backfills or incremental syncs.
 */
export async function syncDrepLifecycleEventsForEpochRange(
  prisma: Prisma.TransactionClient,
  startEpoch: number,
  endEpoch: number
): Promise<SyncDrepLifecycleResult> {
  console.log(
    `[DRep Lifecycle] Syncing lifecycle events for epochs ${startEpoch} to ${endEpoch}...`
  );

  // For epoch-range syncs, we still need to check all DReps
  // but filter events by epoch
  const lifecycleClient = prisma as Prisma.TransactionClient & {
    drepLifecycleEvent: any;
  };

  const drepIds = await fetchAllDrepIds();

  const result: SyncDrepLifecycleResult = {
    drepsProcessed: 0,
    eventsIngested: 0,
    eventsByType: {
      registration: 0,
      deregistration: 0,
      update: 0,
    },
    failed: [],
  };

  for (const drepId of drepIds) {
    try {
      const updates = await fetchDrepUpdates(drepId);

      // Filter to epoch range
      const filteredEvents = updates
        .map((update) => {
          const action = normalizeActionType(update.action_type);
          const epochNo = blockTimeToEpoch(update.block_time);

          return {
            drepId: update.drep_id,
            action,
            epochNo,
            blockTime: update.block_time,
            txHash: update.update_tx_hash,
          };
        })
        .filter((event) => event.epochNo >= startEpoch && event.epochNo <= endEpoch);

      if (filteredEvents.length === 0) {
        result.drepsProcessed++;
        continue;
      }

      const inserted = await lifecycleClient.drepLifecycleEvent.createMany({
        data: filteredEvents,
        skipDuplicates: true,
      });

      result.eventsIngested += inserted.count;

      for (const event of filteredEvents) {
        if (event.action === "registration") {
          result.eventsByType.registration++;
        } else if (event.action === "deregistration") {
          result.eventsByType.deregistration++;
        } else {
          result.eventsByType.update++;
        }
      }

      result.drepsProcessed++;
    } catch (error: any) {
      result.failed.push({
        drepId,
        error: error?.message ?? String(error),
      });
    }
  }

  console.log(
    `[DRep Lifecycle] Epoch range sync complete: ${result.eventsIngested} events for epochs ${startEpoch}-${endEpoch}`
  );

  return result;
}
