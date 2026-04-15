/**
 * DRep Sync Service
 *
 * Handles DRep inventory and info synchronization from Koios.
 * - syncAllDrepsInventory: Creates missing DRep records
 * - syncAllDrepsInfo: Updates all DRep info once per epoch
 */

import { Prisma } from "@prisma/client";
import {
  getDrepInfoBatchFromKoios,
  listAllDrepIds,
  listAllDrepUpdates,
} from "../governanceProvider";
import type { KoiosDrepUpdate } from "../../types/koios.types";
import {
  KOIOS_DREP_INFO_BATCH_SIZE,
  DREP_INFO_SYNC_CONCURRENCY,
  DREP_DELEGATION_PHASE3_JOB_NAME,
  toBigIntOrNull,
  extractStringField,
  extractBooleanField,
} from "./sync-utils";
import { getDrepInfoBatch } from "../drep-lookup";
import { processInParallel } from "./parallel";
import { getBoundedIntEnv } from "./syncLock";
import { withIngestionDbWrite } from "./dbSession";

const DREP_INFO_DELEGATOR_COUNT_REFRESH_COOLDOWN_MS = getBoundedIntEnv(
  "DREP_INFO_DELEGATOR_COUNT_REFRESH_COOLDOWN_MS",
  60 * 60 * 1000,
  0,
  24 * 60 * 60 * 1000
);
const DREP_INFO_WRITE_VOTING_POWER =
  process.env.DREP_INFO_WRITE_VOTING_POWER === "true";

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
  return listAllDrepIds({
    source: "ingestion.drep-sync.drep-list",
  });
}

/**
 * Fetches DRep metadata (name, paymentAddr, iconUrl, doNotList) from /drep_updates.
 */
interface DrepMetadata {
  name?: string;
  paymentAddr?: string;
  iconUrl?: string;
  doNotList?: boolean;
  bio?: string;
  motivations?: string;
  objectives?: string;
  qualifications?: string;
  references?: string;
}

function normalizeReferences(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value != null) {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Select latest non-empty metadata fields from DRep updates.
 * Updates are expected in newest-first order (block_time.desc, tx_hash.desc).
 */
export function selectLatestDrepMetadataFromUpdates(
  drepUpdates: KoiosDrepUpdate[] | null | undefined
): DrepMetadata {
  const metadata: DrepMetadata = {};
  if (!Array.isArray(drepUpdates) || drepUpdates.length === 0) {
    return metadata;
  }

  for (const update of drepUpdates) {
    const body = update?.meta_json?.body;
    if (!body) continue;

    if (!metadata.name && body.givenName !== undefined) {
      metadata.name = extractStringField(body.givenName);
    }
    if (!metadata.paymentAddr && body.paymentAddress !== undefined) {
      metadata.paymentAddr = extractStringField(body.paymentAddress);
    }
    if (!metadata.iconUrl && body.image?.contentUrl !== undefined) {
      metadata.iconUrl = extractStringField(body.image.contentUrl);
    }
    if (metadata.doNotList === undefined && body.doNotList !== undefined) {
      metadata.doNotList = extractBooleanField(body.doNotList);
    }
    if (!metadata.bio && body.bio !== undefined) {
      metadata.bio = extractStringField(body.bio);
    }
    if (!metadata.motivations && body.motivations !== undefined) {
      metadata.motivations = extractStringField(body.motivations);
    }
    if (!metadata.objectives && body.objectives !== undefined) {
      metadata.objectives = extractStringField(body.objectives);
    }
    if (!metadata.qualifications && body.qualifications !== undefined) {
      metadata.qualifications = extractStringField(body.qualifications);
    }
    if (!metadata.references && body.references !== undefined) {
      metadata.references = normalizeReferences(body.references);
    }

    if (
      metadata.name &&
      metadata.paymentAddr &&
      metadata.iconUrl &&
      metadata.doNotList !== undefined &&
      metadata.bio &&
      metadata.motivations &&
      metadata.objectives &&
      metadata.qualifications &&
      metadata.references
    ) {
      break;
    }
  }

  return metadata;
}

async function fetchDrepMetadata(drepId: string): Promise<DrepMetadata> {
  try {
    const drepUpdates = await listAllDrepUpdates(drepId, {
      source: "ingestion.drep-sync.drep-updates",
    });
    return selectLatestDrepMetadataFromUpdates(drepUpdates);
  } catch {
    return {};
  }
}

// ============================================================
// Public API
// ============================================================

/** Built-in vote-delegation targets from Koios `account_info.delegated_drep` (not fetched via /drep_delegators in this job). */
export const CARDANO_ALWAYS_DELEGATION_DREP_IDS = [
  "drep_always_abstain",
  "drep_always_no_confidence",
] as const;

const CARDANO_ALWAYS_DELEGATION_DREP_ID_SET = new Set<string>(
  CARDANO_ALWAYS_DELEGATION_DREP_IDS
);

/** True for Cardano built-in vote targets (`drep_always_abstain`, `drep_always_no_confidence`). */
export function isCardanoAlwaysDelegationDrepId(
  drepId: string | null | undefined
): boolean {
  if (drepId == null || typeof drepId !== "string") return false;
  const t = drepId.trim();
  return t.length > 0 && CARDANO_ALWAYS_DELEGATION_DREP_ID_SET.has(t);
}

/** Kept out of {@link ensureDrepsExist} so inventory / change-log paths do not auto-create these rows. */
const DREP_IDS_EXCLUDED_FROM_ENSURE = CARDANO_ALWAYS_DELEGATION_DREP_ID_SET;

/**
 * Ensures the given DRep IDs exist in the DRep table (creates missing rows with votingPower 0).
 * Use when recording delegation changes so "from" / "to" DReps exist (e.g. retired DReps no longer
 * in /drep_list). Does not create always-abstain / always-no-confidence rows (delegation sync excludes those).
 */
export async function ensureDrepsExist(
  prisma: Prisma.TransactionClient,
  drepIds: string[]
): Promise<{ created: number }> {
  const uniqueIds = [...new Set(drepIds)].filter(
    (id) => id && id.trim() !== "" && !DREP_IDS_EXCLUDED_FROM_ENSURE.has(id)
  );
  if (uniqueIds.length === 0) return { created: 0 };

  const existing = await prisma.drep.findMany({
    where: { drepId: { in: uniqueIds } },
    select: { drepId: true },
  });
  const existingSet = new Set(existing.map((d) => d.drepId));
  const missing = uniqueIds.filter((id) => !existingSet.has(id));
  if (missing.length === 0) return { created: 0 };

  const createManyResult = await withIngestionDbWrite(
    prisma,
    "drep-sync.ensure.createMany",
    () =>
      prisma.drep.createMany({
        data: missing.map((drepId) => ({ drepId, votingPower: BigInt(0) })),
        skipDuplicates: true,
      })
  );
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
    const createManyResult = await withIngestionDbWrite(
      prisma,
      "drep-sync.inventory.createMany",
      () =>
        prisma.drep.createMany({
          data: missing.map((drepId) => ({
            drepId,
            votingPower: BigInt(0),
          })),
          skipDuplicates: true,
        })
    );
    created = createManyResult.count;
  }

  // Bulk update (only for the missing IDs we just created).
  // Uses DB-first lookup: getDrepInfoBatch reads from DB first and only
  // fetches from Koios for DReps not yet populated, then upserts results.
  let updatedFromInfo = 0;
  let failedInfoBatches = 0;

  if (missing.length > 0) {
    try {
      const results = await getDrepInfoBatch(prisma, missing);
      updatedFromInfo = results.length;
    } catch {
      failedInfoBatches = 1;
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
 * Refreshes Drep.delegatorCount from StakeDelegationState (count of stake addresses
 * currently delegating to each DRep). Koios does not provide live_delegators, so we
 * use our own delegation state as the source of truth.
 * Call after syncing delegation state or after syncing DRep info.
 */
export async function refreshDrepDelegatorCountsFromDelegationState(
  prisma: Prisma.TransactionClient
): Promise<{ updated: number }> {
  return withIngestionDbWrite(
    prisma,
    "drep-sync.delegator-count.refresh-raw",
    async () => {
      const updatedWithDelegators = await prisma.$executeRaw`
    UPDATE "drep" AS d
    SET "delegator_count" = counts.cnt
    FROM (
      SELECT "drep_id", COUNT(*)::int AS cnt
      FROM "stake_delegation_state"
      WHERE "drep_id" IS NOT NULL
      GROUP BY "drep_id"
    ) AS counts
    WHERE d."drep_id" = counts."drep_id"
  `;

      const updatedWithoutDelegators = await prisma.$executeRaw`
    UPDATE "drep" AS d
    SET "delegator_count" = 0
    WHERE NOT EXISTS (
      SELECT 1
      FROM "stake_delegation_state" s
      WHERE s."drep_id" = d."drep_id"
    )
      AND COALESCE(d."delegator_count", -1) <> 0
  `;

      return {
        updated: Number(updatedWithDelegators) + Number(updatedWithoutDelegators),
      };
    }
  );
}

/**
 * Refreshes delegator_count only for DReps that may have changed (after a partial merge).
 */
export async function refreshDrepDelegatorCountsForDrepIds(
  prisma: Prisma.TransactionClient,
  drepIds: string[]
): Promise<{ updated: number }> {
  const unique = [...new Set(drepIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) {
    return { updated: 0 };
  }

  return withIngestionDbWrite(
    prisma,
    "drep-sync.delegator-count.refresh-for-dreps",
    async () => {
      const updatedWithDelegators = await prisma.$executeRaw`
        UPDATE "drep" AS d
        SET "delegator_count" = counts.cnt
        FROM (
          SELECT "drep_id", COUNT(*)::int AS cnt
          FROM "stake_delegation_state"
          WHERE "drep_id" IS NOT NULL
            AND "drep_id" IN (${Prisma.join(unique)})
          GROUP BY "drep_id"
        ) AS counts
        WHERE d."drep_id" = counts."drep_id"
      `;

      const updatedWithoutDelegators = await prisma.$executeRaw`
        UPDATE "drep" AS d
        SET "delegator_count" = 0
        WHERE d."drep_id" IN (${Prisma.join(unique)})
          AND NOT EXISTS (
            SELECT 1
            FROM "stake_delegation_state" s
            WHERE s."drep_id" = d."drep_id" AND s."drep_id" IS NOT NULL
          )
          AND COALESCE(d."delegator_count", -1) <> 0
      `;

      return {
        updated: Number(updatedWithDelegators) + Number(updatedWithoutDelegators),
      };
    }
  );
}

/**
 * Sync info for ALL DReps in the database from Koios /drep_info and /drep_updates.
 * Called once per epoch to capture changes in registration status, active status,
 * expiration epoch, metadata URL/hash, name, payment address, icon URL, and doNotList.
 * By default this job no longer writes voting_power to avoid multi-writer churn;
 * voterPowerSync is the authoritative writer for DRep/SPO voting power snapshots.
 * Also refreshes delegator_count from StakeDelegationState (Koios does not provide it).
 */
export async function syncAllDrepsInfo(
  prisma: Prisma.TransactionClient
): Promise<SyncDrepInfoResult> {
  // Get all DRep IDs + existing metaHash/name so we can skip unchanged metadata
  const dreps = await prisma.drep.findMany({
    select: { drepId: true, metaHash: true, name: true },
  });
  const drepIds = dreps.map((d) => d.drepId);

  if (drepIds.length === 0) {
    return { totalDreps: 0, updated: 0, failedBatches: 0 };
  }

  // Build lookup of existing state for hash comparison
  const existingState = new Map(
    dreps.map((d) => [d.drepId, { metaHash: d.metaHash, name: d.name }])
  );

  const batchSize = KOIOS_DREP_INFO_BATCH_SIZE;
  let updated = 0;
  let failedBatches = 0;
  let metadataFetched = 0;
  let metadataSkipped = 0;

  for (let i = 0; i < drepIds.length; i += batchSize) {
    const batch = drepIds.slice(i, i + batchSize);
    try {
      const infos = await getDrepInfoBatchFromKoios(batch, {
        source: "ingestion.drep-sync.drep-info",
      });

      if (!Array.isArray(infos)) {
        failedBatches++;
        continue;
      }

      const metadataCandidates = infos.filter((info) => {
        if (!info?.drep_id) return false;
        const existing = existingState.get(info.drep_id);
        return info.meta_hash !== existing?.metaHash || existing?.name == null;
      });
      const metadataByDrepId = new Map<string, DrepMetadata>();
      if (metadataCandidates.length > 0) {
        metadataFetched += metadataCandidates.length;
        const metadataFetchResult = await processInParallel(
          metadataCandidates,
          (info) => info?.drep_id ?? "",
          async (info) => {
            if (!info?.drep_id) return null;
            const metadata = await fetchDrepMetadata(info.drep_id);
            metadataByDrepId.set(info.drep_id, metadata);
            return info;
          },
          Math.max(1, Math.floor(DREP_INFO_SYNC_CONCURRENCY / 2))
        );
        if (metadataFetchResult.failed.length > 0) {
          failedBatches++;
          console.warn(
            `[DRep Sync] Failed metadata fetches in batch: ${metadataFetchResult.failed.length}`
          );
        }
      }
      metadataSkipped += infos.length - metadataCandidates.length;

      const updateResult = await processInParallel(
        infos,
        (info) => info?.drep_id ?? "",
        async (info) => {
          if (!info?.drep_id) return null;
          const metadata = metadataByDrepId.get(info.drep_id) ?? {};

          await withIngestionDbWrite(prisma, "drep-sync.info.update", () =>
            prisma.drep.update({
              where: { drepId: info.drep_id },
              data: {
                ...(DREP_INFO_WRITE_VOTING_POWER && {
                  votingPower: toBigIntOrNull(info.amount) ?? BigInt(0),
                }),
                registered: info.registered ?? undefined,
                active: info.active ?? undefined,
                expiresEpoch: info.expires_epoch_no ?? undefined,
                metaUrl: info.meta_url ?? undefined,
                metaHash: info.meta_hash ?? undefined,
                // Metadata from /drep_updates (only when changed)
                ...(metadata.name && { name: metadata.name }),
                ...(metadata.paymentAddr && { paymentAddr: metadata.paymentAddr }),
                ...(metadata.iconUrl && { iconUrl: metadata.iconUrl }),
                ...(typeof metadata.doNotList === "boolean" && {
                  doNotList: metadata.doNotList,
                }),
                // CIP-119 metadata
                ...(metadata.bio && { bio: metadata.bio }),
                ...(metadata.motivations && { motivations: metadata.motivations }),
                ...(metadata.objectives && { objectives: metadata.objectives }),
                ...(metadata.qualifications && {
                  qualifications: metadata.qualifications,
                }),
                ...(metadata.references && { references: metadata.references }),
              },
            })
          );
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

  console.log(
    `[DRep Sync] Metadata: fetched=${metadataFetched} skipped=${metadataSkipped} (${drepIds.length} total)`
  );

  // Delegator counts come from our StakeDelegationState (Koios does not provide live_delegators).
  // Skip if delegation sync completed recently to avoid duplicate full-table refresh work.
  const forceDelegatorCountRefresh =
    process.env.DREP_INFO_FORCE_DELEGATOR_COUNT_REFRESH === "true";
  const delegationPhase3Status = await (prisma as Prisma.TransactionClient & {
    syncStatus: any;
  }).syncStatus.findUnique({
    where: { jobName: DREP_DELEGATION_PHASE3_JOB_NAME },
    select: { completedAt: true },
  });
  const delegationSyncCompletedAt = delegationPhase3Status?.completedAt
    ? new Date(delegationPhase3Status.completedAt).getTime()
    : null;
  const completedRecently =
    delegationSyncCompletedAt !== null &&
    Date.now() - delegationSyncCompletedAt <
      DREP_INFO_DELEGATOR_COUNT_REFRESH_COOLDOWN_MS;

  if (forceDelegatorCountRefresh || !completedRecently) {
    await refreshDrepDelegatorCountsFromDelegationState(prisma);
  } else {
    console.log(
      `[DRep Sync] Skipping delegator_count refresh (delegation sync completed recently within cooldownMs=${DREP_INFO_DELEGATOR_COUNT_REFRESH_COOLDOWN_MS})`
    );
  }

  return {
    totalDreps: drepIds.length,
    updated,
    failedBatches,
  };
}

// ============================================================
// Epoch Snapshot
// ============================================================

export interface SnapshotDrepEpochResult {
  epoch: number;
  snapshotted: number;
}

/**
 * Snapshot current delegatorCount and votingPower for every DRep into DrepEpochSnapshot.
 * Designed to be called once per epoch (idempotent via upsert on [drepId, epoch]).
 */
export async function snapshotDrepEpoch(
  prisma: Prisma.TransactionClient,
  epoch: number
): Promise<SnapshotDrepEpochResult> {
  const dreps = await prisma.drep.findMany({
    select: { drepId: true, delegatorCount: true, votingPower: true },
  });

  let snapshotted = 0;
  const chunkSize = 500;
  for (let i = 0; i < dreps.length; i += chunkSize) {
    const chunk = dreps.slice(i, i + chunkSize);
    const result = await withIngestionDbWrite(
      prisma,
      "drep-sync.epoch-snapshot.createMany",
      () =>
        prisma.drepEpochSnapshot.createMany({
          data: chunk.map((d) => ({
            drepId: d.drepId,
            epoch,
            delegatorCount: d.delegatorCount ?? 0,
            votingPower: d.votingPower,
          })),
          skipDuplicates: true,
        })
    );
    snapshotted += result.count;
  }

  return { epoch, snapshotted };
}
