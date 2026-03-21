/**
 * Voter power sync service.
 * Refreshes voting power for existing DRep and SPO records.
 */

import type { Prisma } from "@prisma/client";
import {
  listDrepVotingPowerHistory,
  listPoolVotingPowerHistory,
} from "../governanceProvider";
import { processInParallel, getVoterSyncConcurrency } from "./parallel";
import { getKoiosCurrentEpoch } from "./sync-utils";

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
    select: { drepId: true },
  });

  if (dreps.length === 0) {
    console.log("[Voter Service] No DReps in database to sync");
    return { total: 0, updated: 0, failed: 0, errors: [] };
  }

  const concurrency = getVoterSyncConcurrency();
  console.log(
    `[Voter Service] Syncing voting power and delegator count for ${dreps.length} DReps (concurrency: ${concurrency})...`
  );

  const result = await processInParallel(
    dreps,
    (drep) => drep.drepId,
    async (drep) => {
      const votingPowerHistory = await listDrepVotingPowerHistory({
        epochNo: epoch,
        drepId: drep.drepId,
        source: "ingestion.voter.sync-drep-voting-power",
      });

      const votingPowerLovelace = votingPowerHistory?.[0]?.amount;
      if (votingPowerLovelace) {
        await prisma.drep.update({
          where: { drepId: drep.drepId },
          data: { votingPower: BigInt(votingPowerLovelace) },
        });
        return drep.drepId;
      }

      return null;
    },
    concurrency
  );

  const updated = result.successful.length;
  const failed = result.failed.length;
  const errors = result.failed.map((entry) => `DRep ${entry.id}: ${entry.error}`);

  console.log(
    `[Voter Service] DRep sync complete: ${updated} updated, ${failed} failed`
  );

  return { total: dreps.length, updated, failed, errors };
}

async function syncSpoVotingPower(
  prisma: Prisma.TransactionClient,
  epoch: number
): Promise<{ total: number; updated: number; failed: number; errors: string[] }> {
  const spos = await prisma.sPO.findMany({
    select: { poolId: true },
  });

  if (spos.length === 0) {
    console.log("[Voter Service] No SPOs in database to sync");
    return { total: 0, updated: 0, failed: 0, errors: [] };
  }

  const concurrency = getVoterSyncConcurrency();
  console.log(
    `[Voter Service] Syncing voting power for ${spos.length} SPOs (concurrency: ${concurrency})...`
  );

  const result = await processInParallel(
    spos,
    (spo) => spo.poolId,
    async (spo) => {
      const votingPowerHistory = await listPoolVotingPowerHistory({
        epochNo: epoch,
        poolId: spo.poolId,
        source: "ingestion.voter.sync-spo-voting-power",
      });

      const votingPowerLovelace = votingPowerHistory?.[0]?.amount;
      if (votingPowerLovelace) {
        await prisma.sPO.update({
          where: { poolId: spo.poolId },
          data: { votingPower: BigInt(votingPowerLovelace) },
        });
        return spo.poolId;
      }

      return null;
    },
    concurrency
  );

  const updated = result.successful.length;
  const failed = result.failed.length;
  const errors = result.failed.map((entry) => `SPO ${entry.id}: ${entry.error}`);

  console.log(
    `[Voter Service] SPO sync complete: ${updated} updated, ${failed} failed`
  );

  return { total: spos.length, updated, failed, errors };
}
