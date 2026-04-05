/**
 * DRep Sync Service
 *
 * Handles DRep inventory and info synchronization from Koios.
 * - syncAllDrepsInventory: Creates missing DRep records
 * - syncAllDrepsInfo: Updates all DRep info once per epoch
 */

import type { Prisma } from "@prisma/client";
import {
  getDrepInfoBatchFromKoios,
  listAllDrepIds,
  listAllDrepUpdates,
} from "../governanceProvider";
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

async function fetchDrepMetadata(drepId: string): Promise<DrepMetadata> {
  try {
    const drepUpdates = await listAllDrepUpdates(drepId, {
      source: "ingestion.drep-sync.drep-updates",
    });

    let name: string | undefined;
    let paymentAddr: string | undefined;
    let iconUrl: string | undefined;
    let doNotList: boolean | undefined;
    let bio: string | undefined;
    let motivations: string | undefined;
    let objectives: string | undefined;
    let qualifications: string | undefined;
    let references: string | undefined;

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
      if (!bio && body.bio !== undefined) {
        bio = extractStringField(body.bio);
      }
      if (!motivations && body.motivations !== undefined) {
        motivations = extractStringField(body.motivations);
      }
      if (!objectives && body.objectives !== undefined) {
        objectives = extractStringField(body.objectives);
      }
      if (!qualifications && body.qualifications !== undefined) {
        qualifications = extractStringField(body.qualifications);
      }
      if (!references && body.references !== undefined) {
        // references can be an array of objects; store as JSON string
        if (typeof body.references === "string") {
          references = body.references;
        } else if (body.references != null) {
          try {
            references = JSON.stringify(body.references);
          } catch {
            // skip if not serializable
          }
        }
      }

      if (name && paymentAddr && iconUrl && doNotList !== undefined &&
          bio && motivations && objectives && qualifications && references) {
        break;
      }
    }

    return { name, paymentAddr, iconUrl, doNotList, bio, motivations, objectives, qualifications, references };
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

  return { updated: Number(updatedWithDelegators) + Number(updatedWithoutDelegators) };
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

      const updateResult = await processInParallel(
        infos,
        (info) => info?.drep_id ?? "",
        async (info) => {
          if (!info?.drep_id) return null;

          const existing = existingState.get(info.drep_id);

          // Only fetch metadata from /drep_updates if the hash changed or we never fetched it
          const metadataChanged =
            info.meta_hash !== existing?.metaHash ||
            existing?.name == null;

          let metadata: DrepMetadata = {};
          if (metadataChanged) {
            metadata = await fetchDrepMetadata(info.drep_id);
            metadataFetched++;
          } else {
            metadataSkipped++;
          }

          await prisma.drep.update({
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
              ...(metadata.qualifications && { qualifications: metadata.qualifications }),
              ...(metadata.references && { references: metadata.references }),
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
    const result = await prisma.drepEpochSnapshot.createMany({
      data: chunk.map((d) => ({
        drepId: d.drepId,
        epoch,
        delegatorCount: d.delegatorCount ?? 0,
        votingPower: d.votingPower,
      })),
      skipDuplicates: true,
    });
    snapshotted += result.count;
  }

  return { epoch, snapshotted };
}
