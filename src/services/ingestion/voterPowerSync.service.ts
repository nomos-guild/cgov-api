/**
 * Voter power sync service.
 * Refreshes voting power for existing DRep and SPO records.
 *
 * Ownership boundary:
 * - This service is the authoritative writer for DRep/SPO voting power snapshots.
 * - drep-sync focuses on DRep metadata/registration info and does not write
 *   voting power by default.
 */

import { Prisma } from "@prisma/client";
import {
  getAllDrepVotingPowerHistoryForEpoch,
  getAllPoolVotingPowerHistoryForEpoch,
  listDrepVotingPowerHistory,
} from "../governanceProvider";
import { getKoiosCurrentEpoch } from "./sync-utils";
import { processInParallel } from "./parallel";

const VOTER_POWER_UPDATE_CHUNK_SIZE = 500;
const DREP_MISSING_CONFIRM_CONCURRENCY = 5;

type MissingDrepConfirmationStatus = "confirmed-empty" | "has-data" | "unresolved";

interface MissingDrepConfirmationResult {
  drepId: string;
  status: MissingDrepConfirmationStatus;
  votingPower?: bigint;
  error?: string;
}

/**
 * Result of syncing voter voting powers.
 */
export interface SyncVoterPowerResult {
  dreps: {
    total: number;
    updated: number;
    failed: number;
    errors: string[];
  };
  spos: {
    total: number;
    updated: number;
    failed: number;
    errors: string[];
  };
  epoch: number;
}

export async function syncAllVoterVotingPower(
  prisma: Prisma.TransactionClient
): Promise<SyncVoterPowerResult> {
  const currentEpoch = await getKoiosCurrentEpoch();

  console.log(
    `[Voter Service] Starting voting power sync for epoch ${currentEpoch}...`
  );

  const drepResult = await syncDrepVotingPower(prisma, currentEpoch);
  const spoResult = await syncSpoVotingPower(prisma, currentEpoch);

  return {
    dreps: drepResult,
    spos: spoResult,
    epoch: currentEpoch,
  };
}

async function syncDrepVotingPower(
  prisma: Prisma.TransactionClient,
  epoch: number
): Promise<{ total: number; updated: number; failed: number; errors: string[] }> {
  const dreps = await prisma.drep.findMany({
    select: { drepId: true, votingPower: true },
  });

  if (dreps.length === 0) {
    console.log("[Voter Service] No DReps in database to sync");
    return { total: 0, updated: 0, failed: 0, errors: [] };
  }

  const errors: string[] = [];
  const dbPowerByDrepId = new Map(dreps.map((drep) => [drep.drepId, drep.votingPower]));
  const koiosPowerByDrepId = new Map<string, bigint>();
  let rawKoiosRows = 0;

  try {
    const rows = await getAllDrepVotingPowerHistoryForEpoch({
      epochNo: epoch,
      source: "ingestion.voter.sync-drep-voting-power.bulk",
    });

    for (const row of rows) {
      if (row?.epoch_no !== epoch) continue;
      if (!row?.drep_id || !row?.amount) continue;
      try {
        koiosPowerByDrepId.set(row.drep_id, BigInt(row.amount));
        rawKoiosRows++;
      } catch {
        errors.push(`DRep ${row.drep_id}: invalid Koios amount "${row.amount}"`);
      }
    }
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return {
      total: dreps.length,
      updated: 0,
      failed: dreps.length,
      errors: [`DRep bulk fetch failed: ${message}`],
    };
  }

  async function confirmMissingDrepVotingPower(
    drepId: string
  ): Promise<MissingDrepConfirmationResult> {
    try {
      const rows = await listDrepVotingPowerHistory({
        epochNo: epoch,
        drepId,
        limit: 1,
        offset: 0,
        source: "ingestion.voter.sync-drep-voting-power.confirm-missing",
      });

      if (!Array.isArray(rows) || rows.length === 0) {
        return { drepId, status: "confirmed-empty" };
      }

      const row = rows[0];
      if (!row?.amount) {
        return {
          drepId,
          status: "unresolved",
          error: "missing amount in per-DRep confirmation row",
        };
      }

      try {
        return {
          drepId,
          status: "has-data",
          votingPower: BigInt(row.amount),
        };
      } catch {
        return {
          drepId,
          status: "unresolved",
          error: `invalid per-DRep amount "${row.amount}"`,
        };
      }
    } catch (error: any) {
      return {
        drepId,
        status: "unresolved",
        error: error?.message ?? String(error),
      };
    }
  }

  const missingDrepIds = dreps
    .map((drep) => drep.drepId)
    .filter((drepId) => !koiosPowerByDrepId.has(drepId));
  const confirmedEmptyDrepIds: string[] = [];
  const unresolvedDrepIds: string[] = [];
  let recoveredFromPerDrep = 0;

  if (missingDrepIds.length > 0) {
    const confirmation = await processInParallel(
      missingDrepIds,
      (drepId) => drepId,
      async (drepId) => confirmMissingDrepVotingPower(drepId),
      DREP_MISSING_CONFIRM_CONCURRENCY
    );

    for (const result of confirmation.successful) {
      if (result.status === "confirmed-empty") {
        confirmedEmptyDrepIds.push(result.drepId);
        continue;
      }

      if (result.status === "has-data" && result.votingPower !== undefined) {
        koiosPowerByDrepId.set(result.drepId, result.votingPower);
        recoveredFromPerDrep++;
        continue;
      }

      unresolvedDrepIds.push(result.drepId);
      if (result.error) {
        errors.push(`DRep ${result.drepId}: ${result.error}`);
      }
    }

    if (confirmation.failed.length > 0) {
      for (const failure of confirmation.failed) {
        unresolvedDrepIds.push(failure.id);
        errors.push(`DRep ${failure.id}: ${failure.error}`);
      }
    }
  }

  const confirmedEmptySet = new Set(confirmedEmptyDrepIds);
  const rowsToUpdate: Array<{ drepId: string; votingPower: bigint }> = [];
  let zeroCandidates = 0;
  for (const drep of dreps) {
    let nextPower = koiosPowerByDrepId.get(drep.drepId);
    if (nextPower == null && confirmedEmptySet.has(drep.drepId)) {
      nextPower = BigInt(0);
      zeroCandidates++;
    }
    if (nextPower == null) continue;
    const currentPower = dbPowerByDrepId.get(drep.drepId);
    if (currentPower === nextPower) continue;
    rowsToUpdate.push({ drepId: drep.drepId, votingPower: nextPower });
  }

  let updated = 0;
  try {
    for (let i = 0; i < rowsToUpdate.length; i += VOTER_POWER_UPDATE_CHUNK_SIZE) {
      const chunk = rowsToUpdate.slice(i, i + VOTER_POWER_UPDATE_CHUNK_SIZE);
      updated += await updateDrepVotingPowerBatch(prisma, chunk);
    }
  } catch (error: any) {
    const message = error?.message ?? String(error);
    errors.push(`DRep batch update failed: ${message}`);
    return {
      total: dreps.length,
      updated,
      failed: dreps.length - updated,
      errors,
    };
  }

  const unchanged = koiosPowerByDrepId.size - updated;
  console.log(
    `[Voter Service] DRep sync metrics: epoch=${epoch} dbRows=${dreps.length} koiosRows=${koiosPowerByDrepId.size} changed=${updated} unchanged=${Math.max(
      0,
      unchanged
    )} missingInKoios=${Math.max(0, dreps.length - koiosPowerByDrepId.size)}`
  );
  console.log(
    `[Voter Service] DRep omission-confirmation metrics: epoch=${epoch} rawKoiosRows=${rawKoiosRows} initialMissing=${missingDrepIds.length} confirmedEmpty=${confirmedEmptyDrepIds.length} recoveredFromPerDrep=${recoveredFromPerDrep} unresolved=${unresolvedDrepIds.length} zeroCandidates=${zeroCandidates}`
  );

  console.log(
    `[Voter Service] DRep sync complete: ${updated} updated, ${errors.length} errors`
  );

  return { total: dreps.length, updated, failed: errors.length, errors };
}

async function syncSpoVotingPower(
  prisma: Prisma.TransactionClient,
  epoch: number
): Promise<{ total: number; updated: number; failed: number; errors: string[] }> {
  const spos = await prisma.sPO.findMany({
    select: { poolId: true, votingPower: true },
  });

  if (spos.length === 0) {
    console.log("[Voter Service] No SPOs in database to sync");
    return { total: 0, updated: 0, failed: 0, errors: [] };
  }

  const errors: string[] = [];
  const dbPowerByPoolId = new Map(spos.map((spo) => [spo.poolId, spo.votingPower]));
  const koiosPowerByPoolId = new Map<string, bigint>();

  try {
    const rows = await getAllPoolVotingPowerHistoryForEpoch({
      epochNo: epoch,
      source: "ingestion.voter.sync-spo-voting-power.bulk",
    });

    for (const row of rows) {
      if (row?.epoch_no !== epoch) continue;
      if (!row?.pool_id_bech32 || !row?.amount) continue;
      try {
        koiosPowerByPoolId.set(row.pool_id_bech32, BigInt(row.amount));
      } catch {
        errors.push(
          `SPO ${row.pool_id_bech32}: invalid Koios amount "${row.amount}"`
        );
      }
    }
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return {
      total: spos.length,
      updated: 0,
      failed: spos.length,
      errors: [`SPO bulk fetch failed: ${message}`],
    };
  }

  const rowsToUpdate: Array<{ poolId: string; votingPower: bigint }> = [];
  for (const spo of spos) {
    const nextPower = koiosPowerByPoolId.get(spo.poolId);
    if (nextPower == null) continue;
    const currentPower = dbPowerByPoolId.get(spo.poolId);
    if (currentPower === nextPower) continue;
    rowsToUpdate.push({ poolId: spo.poolId, votingPower: nextPower });
  }

  let updated = 0;
  try {
    for (let i = 0; i < rowsToUpdate.length; i += VOTER_POWER_UPDATE_CHUNK_SIZE) {
      const chunk = rowsToUpdate.slice(i, i + VOTER_POWER_UPDATE_CHUNK_SIZE);
      updated += await updateSpoVotingPowerBatch(prisma, chunk);
    }
  } catch (error: any) {
    const message = error?.message ?? String(error);
    errors.push(`SPO batch update failed: ${message}`);
    return {
      total: spos.length,
      updated,
      failed: spos.length - updated,
      errors,
    };
  }

  const unchanged = koiosPowerByPoolId.size - updated;
  console.log(
    `[Voter Service] SPO sync metrics: epoch=${epoch} dbRows=${spos.length} koiosRows=${koiosPowerByPoolId.size} changed=${updated} unchanged=${Math.max(
      0,
      unchanged
    )} missingInKoios=${Math.max(0, spos.length - koiosPowerByPoolId.size)}`
  );

  console.log(
    `[Voter Service] SPO sync complete: ${updated} updated, ${errors.length} errors`
  );

  return { total: spos.length, updated, failed: errors.length, errors };
}

async function updateDrepVotingPowerBatch(
  prisma: Prisma.TransactionClient,
  rows: Array<{ drepId: string; votingPower: bigint }>
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = Prisma.join(
    rows.map((row) => Prisma.sql`(${row.drepId}, ${row.votingPower})`)
  );
  const updated = await prisma.$executeRaw`
    UPDATE "drep" AS d
    SET "voting_power" = v."voting_power"
    FROM (
      VALUES ${values}
    ) AS v("drep_id", "voting_power")
    WHERE d."drep_id" = v."drep_id"
      AND d."voting_power" IS DISTINCT FROM v."voting_power"
  `;
  return Number(updated);
}

async function updateSpoVotingPowerBatch(
  prisma: Prisma.TransactionClient,
  rows: Array<{ poolId: string; votingPower: bigint }>
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = Prisma.join(
    rows.map((row) => Prisma.sql`(${row.poolId}, ${row.votingPower})`)
  );
  const updated = await prisma.$executeRaw`
    UPDATE "spo" AS s
    SET "voting_power" = v."voting_power"
    FROM (
      VALUES ${values}
    ) AS v("pool_id", "voting_power")
    WHERE s."pool_id" = v."pool_id"
      AND s."voting_power" IS DISTINCT FROM v."voting_power"
  `;
  return Number(updated);
}
