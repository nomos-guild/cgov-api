/**
 * DB-first DRep lookup helper.
 *
 * Reads DRep core fields from the local database first (populated hourly by
 * DRep Inventory at :02), falling back to Koios POST /drep_info only for
 * DReps not yet in the DB. Fetched results are upserted so future lookups
 * skip Koios entirely.
 */

import type { Prisma } from "@prisma/client";
import { koiosPost } from "./koios";
import type { KoiosDrepInfo } from "../types/koios.types";
import { toBigIntOrNull } from "./ingestion/sync-utils";

export interface DrepLookupResult {
  drepId: string;
  votingPower: bigint;
  registered: boolean | null;
  active: boolean | null;
  expiresEpoch: number | null;
  metaUrl: string | null;
  metaHash: string | null;
}

const BATCH_SIZE = 10;

/**
 * Look up DRep core info, preferring the local DB over Koios.
 *
 * 1. Queries the Drep table for the requested IDs.
 * 2. For any IDs not found, calls POST /drep_info in batches of 10.
 * 3. Upserts Koios results into the DB for future callers.
 * 4. Returns a unified DrepLookupResult[] for all requested IDs.
 */
export async function getDrepInfoBatch(
  prisma: Prisma.TransactionClient,
  drepIds: string[]
): Promise<DrepLookupResult[]> {
  if (drepIds.length === 0) return [];

  // 1. Check DB first
  const dbDreps = await prisma.drep.findMany({
    where: { drepId: { in: drepIds } },
    select: {
      drepId: true,
      votingPower: true,
      registered: true,
      active: true,
      expiresEpoch: true,
      metaUrl: true,
      metaHash: true,
    },
  });
  const foundIds = new Set(dbDreps.map((d) => d.drepId));

  // 2. Only fetch missing DReps from Koios
  const missingIds = drepIds.filter((id) => !foundIds.has(id));
  const fetchedDreps: DrepLookupResult[] = [];

  if (missingIds.length > 0) {
    for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
      const batch = missingIds.slice(i, i + BATCH_SIZE);
      try {
        const koiosResults = await koiosPost<KoiosDrepInfo[]>("/drep_info", {
          _drep_ids: batch,
        }, {
          source: "drep-lookup.drep-info",
        });

        if (!Array.isArray(koiosResults)) continue;

        for (const info of koiosResults) {
          if (!info?.drep_id) continue;
          fetchedDreps.push({
            drepId: info.drep_id,
            votingPower: toBigIntOrNull(info.amount) ?? BigInt(0),
            registered: info.registered ?? null,
            active: info.active ?? null,
            expiresEpoch: info.expires_epoch_no ?? null,
            metaUrl: info.meta_url ?? null,
            metaHash: info.meta_hash ?? null,
          });
        }

        // 3. Upsert into DB so future lookups skip Koios
        for (const info of koiosResults) {
          if (!info?.drep_id) continue;
          await prisma.drep.upsert({
            where: { drepId: info.drep_id },
            create: {
              drepId: info.drep_id,
              votingPower: toBigIntOrNull(info.amount) ?? BigInt(0),
              registered: info.registered ?? null,
              active: info.active ?? null,
              expiresEpoch: info.expires_epoch_no ?? null,
              metaUrl: info.meta_url ?? null,
              metaHash: info.meta_hash ?? null,
            },
            update: {
              votingPower: toBigIntOrNull(info.amount) ?? BigInt(0),
              registered: info.registered ?? null,
              active: info.active ?? null,
              expiresEpoch: info.expires_epoch_no ?? null,
              metaUrl: info.meta_url ?? null,
              metaHash: info.meta_hash ?? null,
            },
          });
        }
      } catch (error: any) {
        console.warn(
          `[getDrepInfoBatch] Failed to fetch /drep_info batch: ${error.message}`
        );
      }
    }
  }

  return [...dbDreps, ...fetchedDreps];
}
