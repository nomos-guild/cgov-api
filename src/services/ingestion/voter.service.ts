/**
 * Voter Ingestion Service
 * Handles creation and updates of DRep, SPO, and CC voters
 */

import type { Prisma } from "@prisma/client";
import { koiosGet } from "../koios";
import { lovelaceToAda } from "./utils";
import type {
  KoiosDrep,
  KoiosDrepVotingPower,
  KoiosSpo,
  KoiosSpoVotingPower,
  KoiosCommitteeInfo,
  KoiosTip,
} from "../../types/koios.types";

/**
 * Result of ensuring a voter exists
 */
export interface EnsureVoterResult {
  voterId: string;
  created: boolean;
  updated: boolean;
}

/**
 * Ensures a voter exists in the database, creating or updating as needed
 *
 * @param voterRole - Type of voter (DRep, SPO, or CC)
 * @param voterId - The unique identifier for the voter
 * @param tx - Prisma transaction client
 * @returns Result with voter ID and creation/update status
 */
export async function ensureVoterExists(
  voterRole: "DRep" | "SPO" | "ConstitutionalCommittee",
  voterId: string,
  tx: Prisma.TransactionClient
): Promise<EnsureVoterResult> {
  if (voterRole === "DRep") {
    return ensureDrepExists(voterId, tx);
  } else if (voterRole === "SPO") {
    return ensureSpoExists(voterId, tx);
  } else {
    return ensureCcExists(voterId, tx);
  }
}

/**
 * Ensures a DRep exists, creating if needed and updating voting power
 */
async function ensureDrepExists(
  drepId: string,
  tx: Prisma.TransactionClient
): Promise<EnsureVoterResult> {
  const existing = await tx.drep.findUnique({
    where: { drepId },
  });

  // Fetch latest data from Koios
  const koiosDrepResponse = await koiosGet<KoiosDrep[]>("/drep_info", {
    _drep_id: drepId,
  });

  const koiosDrep = koiosDrepResponse?.[0];

  if (existing) {
    // Update voting power if available (can change between syncs)
    if (koiosDrep?.voting_power) {
      const votingPower = lovelaceToAda(koiosDrep.voting_power) || 0;
      await tx.drep.update({
        where: { drepId },
        data: { votingPower },
      });
      return { voterId: existing.id, created: false, updated: true };
    }

    return { voterId: existing.id, created: false, updated: false };
  }

  // Create new DRep
  const newDrep = await tx.drep.create({
    data: {
      drepId,
      stakeKey: koiosDrep?.drep_id || drepId,
      votingPower: lovelaceToAda(koiosDrep?.voting_power) || 0,
      // Add other fields as needed when inline docs are available
    },
  });

  return { voterId: newDrep.id, created: true, updated: false };
}

/**
 * Ensures an SPO exists, creating if needed and updating voting power
 */
async function ensureSpoExists(
  poolId: string,
  tx: Prisma.TransactionClient
): Promise<EnsureVoterResult> {
  const existing = await tx.sPO.findUnique({
    where: { poolId },
  });

  // Fetch latest data from Koios
  const koiosSpoResponse = await koiosGet<KoiosSpo[]>("/pool_info", {
    _pool_bech32: poolId,
  });

  const koiosSpo = koiosSpoResponse?.[0];

  if (existing) {
    // Update voting power and other mutable fields
    if (koiosSpo?.voting_power) {
      const votingPower = lovelaceToAda(koiosSpo.voting_power) || 0;
      await tx.sPO.update({
        where: { poolId },
        data: {
          votingPower,
          poolName: koiosSpo.pool_name,
          ticker: koiosSpo.ticker,
        },
      });
      return { voterId: existing.id, created: false, updated: true };
    }

    return { voterId: existing.id, created: false, updated: false };
  }

  // Create new SPO
  const newSpo = await tx.sPO.create({
    data: {
      poolId,
      poolName: koiosSpo?.pool_name,
      ticker: koiosSpo?.ticker,
      votingPower: lovelaceToAda(koiosSpo?.voting_power) || 0,
      // Add other fields as needed when inline docs are available
    },
  });

  return { voterId: newSpo.id, created: true, updated: false };
}

/**
 * Ensures a CC member exists, creating if needed
 *
 * Note: Constitutional Committee data may need to be extracted from
 * vote metadata or a different Koios endpoint once documented.
 */
async function ensureCcExists(
  ccId: string,
  tx: Prisma.TransactionClient
): Promise<EnsureVoterResult> {
  const existing = await tx.cC.findUnique({
    where: { ccId },
  });

  if (existing) {
    return { voterId: existing.id, created: false, updated: false };
  }

  // TODO: Update this when CC data source is confirmed
  // For now, create with minimal data
  const newCc = await tx.cC.create({
    data: {
      ccId,
      hotCredential: ccId, // May need to parse this differently
      // Add other fields when CC endpoint/structure is documented
    },
  });

  return { voterId: newCc.id, created: true, updated: false };
}

/**
 * Directly ingest a DRep (for POST /data/drep/:drep_id endpoint)
 */
export async function ingestDrep(
  drepId: string,
  prisma: Prisma.TransactionClient
) {
  return ensureDrepExists(drepId, prisma);
}

/**
 * Directly ingest an SPO (for POST /data/spo/:pool_id endpoint)
 */
export async function ingestSpo(
  poolId: string,
  prisma: Prisma.TransactionClient
) {
  return ensureSpoExists(poolId, prisma);
}

/**
 * Directly ingest a CC member (for POST /data/cc/:cc_id endpoint)
 */
export async function ingestCc(
  ccId: string,
  prisma: Prisma.TransactionClient
) {
  return ensureCcExists(ccId, prisma);
}