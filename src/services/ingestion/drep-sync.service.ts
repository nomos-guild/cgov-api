/**
 * DRep Sync Service
 *
 * Handles DRep inventory and info synchronization from Koios.
 * - syncAllDrepsInventory: Creates missing DRep records
 * - syncAllDrepsInfo: Updates all DRep info once per epoch
 */

import type { Prisma } from "@prisma/client";
import { koiosGet, koiosPost } from "../koios";
import type { KoiosDrepInfo, KoiosDrepListEntry } from "../../types/koios.types";
import {
  KOIOS_DREP_LIST_PAGE_SIZE,
  KOIOS_DREP_INFO_BATCH_SIZE,
  DREP_INFO_SYNC_CONCURRENCY,
  toBigIntOrNull,
  extractStringField,
  extractBooleanField,
} from "./sync-utils";
import { processInParallel } from "./parallel";
import { withRetry } from "./utils";

// ============================================================
// Result Types
// ============================================================

export interface SyncDrepInventoryResult {
  koiosTotal: number;
  existingInDb: number;
  created: number;
  updatedFromInfo: number;
  failedInfoBatches: number;
}

export interface SyncDrepInfoResult {
  totalDreps: number;
  updated: number;
  failedBatches: number;
}

// ============================================================
// Private Helpers
// ============================================================

/**
 * Fetches all DRep IDs from Koios /drep_list endpoint.
 */
async function fetchAllKoiosDrepIds(): Promise<string[]> {
  const pageSize = KOIOS_DREP_LIST_PAGE_SIZE;
  let offset = 0;
  let hasMore = true;
  const ids: string[] = [];

  while (hasMore) {
    const page = await withRetry(() =>
      koiosGet<KoiosDrepListEntry[]>("/drep_list", {
        limit: pageSize,
        offset,
      })
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
 * Fetches DRep metadata (name, paymentAddr, iconUrl, doNotList) from /drep_updates.
 */
async function fetchDrepMetadata(drepId: string): Promise<{
  name?: string;
  paymentAddr?: string;
  iconUrl?: string;
  doNotList?: boolean;
}> {
  try {
    const drepUpdates = await withRetry(() =>
      koiosGet<
        Array<{
          meta_json?: {
            body?: {
              givenName?: unknown;
              paymentAddress?: unknown;
              doNotList?: unknown;
              image?: {
                contentUrl?: unknown;
              };
            };
          } | null;
        }>
      >("/drep_updates", { _drep_id: drepId })
    );

    let name: string | undefined;
    let paymentAddr: string | undefined;
    let iconUrl: string | undefined;
    let doNotList: boolean | undefined;

    for (const update of drepUpdates || []) {
      const body = update.meta_json?.body;
      if (!body) continue;

      if (!name && body.givenName !== undefined) {
        name = extractStringField(body.givenName);
      }
      if (!paymentAddr && body.paymentAddress !== undefined) {
        paymentAddr = extractStringField(body.paymentAddress);
      }
      if (!iconUrl && body.image?.contentUrl !== undefined) {
        iconUrl = extractStringField(body.image.contentUrl);
      }
      if (doNotList === undefined && body.doNotList !== undefined) {
        doNotList = extractBooleanField(body.doNotList);
      }

      if (name && paymentAddr && iconUrl && doNotList !== undefined) {
        break;
      }
    }

    return { name, paymentAddr, iconUrl, doNotList };
  } catch {
    return {};
  }
}

// ============================================================
// Public API
// ============================================================

/** Special DRep IDs we do not ensure exist in the DRep table (e.g. system/sentinel DReps). */
const DREP_IDS_EXCLUDED_FROM_ENSURE = new Set([
  "drep_always_abstain",
  "drep_always_no_confidence",
]);

/**
 * Ensures the given DRep IDs exist in the DRep table (creates missing rows with votingPower 0).
 * Use when recording delegation changes so that both "from" and "to" DReps are in inventory
 * (e.g. retired DReps that are no longer returned by /drep_list).
 * Excludes special DReps (drep_always_abstain, drep_always_no_confidence).
 */
export async function ensureDrepsExist(
  prisma: Prisma.TransactionClient,
  drepIds: string[]
): Promise<{ created: number }> {
  const uniqueIds = [...new Set(drepIds)]
    .filter((id) => id && id.trim() !== "" && !DREP_IDS_EXCLUDED_FROM_ENSURE.has(id));
  if (uniqueIds.length === 0) return { created: 0 };

  const existing = await prisma.drep.findMany({
    where: { drepId: { in: uniqueIds } },
    select: { drepId: true },
  });
  const existingSet = new Set(existing.map((d) => d.drepId));
  const missing = uniqueIds.filter((id) => !existingSet.has(id));
  if (missing.length === 0) return { created: 0 };

  const createManyResult = await prisma.drep.createMany({
    data: missing.map((drepId) => ({ drepId, votingPower: BigInt(0) })),
    skipDuplicates: true,
  });
  return { created: createManyResult.count };
}

/**
 * Inventory all DReps from Koios into the DB (creates missing rows).
 * Then bulk-refreshes DRep fields from Koios POST /drep_info for the new IDs.
 */
export async function syncAllDrepsInventory(
  prisma: Prisma.TransactionClient
): Promise<SyncDrepInventoryResult> {
  const koiosIds = await fetchAllKoiosDrepIds();

  // Snapshot existing DReps
  const existing = await prisma.drep.findMany({ select: { drepId: true } });
  const existingSet = new Set(existing.map((d) => d.drepId));

  const missing = koiosIds.filter((id) => !existingSet.has(id));

  let created = 0;
  if (missing.length > 0) {
    const createManyResult = await prisma.drep.createMany({
      data: missing.map((drepId) => ({
        drepId,
        votingPower: BigInt(0),
      })),
      skipDuplicates: true,
    });
    created = createManyResult.count;
  }

  // Bulk update (only for the missing IDs we just created).
  const batchSize = KOIOS_DREP_INFO_BATCH_SIZE;
  let updatedFromInfo = 0;
  let failedInfoBatches = 0;

  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    try {
      const infos = await withRetry(() =>
        koiosPost<KoiosDrepInfo[]>("/drep_info", {
          _drep_ids: batch,
        })
      );

      if (!Array.isArray(infos)) {
        failedInfoBatches++;
        continue;
      }

      for (const info of infos) {
        if (!info?.drep_id) continue;

        await prisma.drep.update({
          where: { drepId: info.drep_id },
          data: {
            votingPower: toBigIntOrNull(info.amount) ?? BigInt(0),
            registered: info.registered ?? undefined,
            active: info.active ?? undefined,
            expiresEpoch: info.expires_epoch_no ?? undefined,
            metaUrl: info.meta_url ?? undefined,
            metaHash: info.meta_hash ?? undefined,
          },
        });
        updatedFromInfo++;
      }
    } catch {
      failedInfoBatches++;
    }
  }

  return {
    koiosTotal: koiosIds.length,
    existingInDb: existing.length,
    created,
    updatedFromInfo,
    failedInfoBatches,
  };
}

/**
 * Sync info for ALL DReps in the database from Koios /drep_info and /drep_updates.
 * Called once per epoch to capture changes in registration status, active status,
 * expiration epoch, metadata URL/hash, name, payment address, icon URL, and doNotList.
 */
export async function syncAllDrepsInfo(
  prisma: Prisma.TransactionClient
): Promise<SyncDrepInfoResult> {
  // Get all DRep IDs from database
  const dreps = await prisma.drep.findMany({ select: { drepId: true } });
  const drepIds = dreps.map((d) => d.drepId);

  if (drepIds.length === 0) {
    return { totalDreps: 0, updated: 0, failedBatches: 0 };
  }

  const batchSize = KOIOS_DREP_INFO_BATCH_SIZE;
  let updated = 0;
  let failedBatches = 0;

  for (let i = 0; i < drepIds.length; i += batchSize) {
    const batch = drepIds.slice(i, i + batchSize);
    try {
      const infos = await withRetry(() =>
        koiosPost<KoiosDrepInfo[]>("/drep_info", {
          _drep_ids: batch,
        })
      );

      if (!Array.isArray(infos)) {
        failedBatches++;
        continue;
      }

      const updateResult = await processInParallel(
        infos,
        (info) => info?.drep_id ?? "",
        async (info) => {
          if (!info?.drep_id) return null;

          // Fetch metadata from /drep_updates (name, paymentAddr, iconUrl, doNotList)
          const metadata = await fetchDrepMetadata(info.drep_id);

          await prisma.drep.update({
            where: { drepId: info.drep_id },
            data: {
              votingPower: toBigIntOrNull(info.amount) ?? BigInt(0),
              registered: info.registered ?? undefined,
              active: info.active ?? undefined,
              expiresEpoch: info.expires_epoch_no ?? undefined,
              metaUrl: info.meta_url ?? undefined,
              metaHash: info.meta_hash ?? undefined,
              // Metadata from /drep_updates
              ...(metadata.name && { name: metadata.name }),
              ...(metadata.paymentAddr && { paymentAddr: metadata.paymentAddr }),
              ...(metadata.iconUrl && { iconUrl: metadata.iconUrl }),
              ...(typeof metadata.doNotList === "boolean" && {
                doNotList: metadata.doNotList,
              }),
            },
          });
          return info;
        },
        DREP_INFO_SYNC_CONCURRENCY
      );
      updated += updateResult.successful.length;
      if (updateResult.failed.length > 0) {
        failedBatches++;
        console.warn(
          `[DRep Sync] Failed updates in batch: ${updateResult.failed.length}`
        );
      }
    } catch {
      failedBatches++;
    }
  }

  return {
    totalDreps: drepIds.length,
    updated,
    failedBatches,
  };
}
