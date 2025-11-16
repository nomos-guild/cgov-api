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
 * Gets current epoch from Koios API
 */
async function getCurrentEpoch(): Promise<number> {
  const tip = await koiosGet<KoiosTip[]>("/tip");
  return tip?.[0]?.epoch_no || 0;
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

  // Fetch DRep info from Koios
  const koiosDrepResponse = await koiosGet<KoiosDrep[]>("/drep_info", {
    _drep_id: drepId,
  });

  const koiosDrep = koiosDrepResponse?.[0];

  // Get current epoch for voting power history
  const currentEpoch = await getCurrentEpoch();

  // Fetch voting power from history endpoint
  const votingPowerHistory = await koiosGet<KoiosDrepVotingPower[]>(
    "/drep_voting_power_history",
    {
      _epoch_no: currentEpoch,
      _drep_id: drepId,
    }
  );

  const votingPowerLovelace = votingPowerHistory?.[0]?.amount;
  const votingPower = lovelaceToAda(votingPowerLovelace) || 0;

  if (existing) {
    // Update voting power (can change between syncs)
    if (votingPowerLovelace) {
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
      votingPower,
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

  // Fetch pool info from Koios
  const koiosSpoResponse = await koiosGet<KoiosSpo[]>("/pool_info", {
    _pool_bech32: poolId,
  });

  const koiosSpo = koiosSpoResponse?.[0];

  // Get current epoch for voting power history
  const currentEpoch = await getCurrentEpoch();

  // Fetch voting power from history endpoint
  const votingPowerHistory = await koiosGet<KoiosSpoVotingPower[]>(
    "/pool_voting_power_history",
    {
      _epoch_no: currentEpoch,
      _pool_bech32: poolId,
    }
  );

  const votingPowerLovelace = votingPowerHistory?.[0]?.amount;
  const votingPower = lovelaceToAda(votingPowerLovelace) || 0;

  // Get pool name from meta_url or meta_json
  const poolName = await getPoolName(koiosSpo);

  if (existing) {
    // Update voting power and other mutable fields
    if (votingPowerLovelace) {
      await tx.sPO.update({
        where: { poolId },
        data: {
          votingPower,
          poolName,
          ticker: koiosSpo?.ticker,
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
      poolName,
      ticker: koiosSpo?.ticker,
      votingPower,
    },
  });

  return { voterId: newSpo.id, created: true, updated: false };
}

/**
 * Gets pool name from meta_json or fetches from meta_url
 */
async function getPoolName(koiosSpo: KoiosSpo | undefined): Promise<string | null> {
  if (!koiosSpo) return null;

  // Try meta_json first
  if (koiosSpo.meta_json?.name) {
    return koiosSpo.meta_json.name;
  }

  // Fallback to fetching from meta_url
  if (koiosSpo.meta_url) {
    try {
      const axios = (await import("axios")).default;
      const response = await axios.get(koiosSpo.meta_url, { timeout: 10000 });
      return response.data?.name || null;
    } catch (error) {
      console.error(`Failed to fetch pool meta_url: ${koiosSpo.meta_url}`, error);
    }
  }

  return null;
}

/**
 * Ensures a CC member exists, creating if needed
 * Fetches from /committee_info and /committee_votes endpoints
 */
async function ensureCcExists(
  ccId: string,
  tx: Prisma.TransactionClient
): Promise<EnsureVoterResult> {
  const existing = await tx.cC.findUnique({
    where: { ccId },
  });

  // Fetch committee info from Koios
  const committeeInfo = await koiosGet<KoiosCommitteeInfo[]>("/committee_info");

  // Find this specific CC member by cc_hot_id
  const ccMember = committeeInfo?.[0]?.members?.find(
    (member) => member.cc_hot_id === ccId
  );

  // Get current epoch to determine status
  const currentEpoch = await getCurrentEpoch();

  // Determine status based on expiration_epoch
  let status = "active";
  if (ccMember?.expiration_epoch && ccMember.expiration_epoch <= currentEpoch) {
    status = "expired";
  }

  // Get member name from committee_votes meta_url
  const memberName = await getCcMemberName(ccId);

  if (existing) {
    // Update CC member details
    if (ccMember) {
      await tx.cC.update({
        where: { ccId },
        data: {
          coldCredential: ccMember.cc_cold_id,
          status,
          memberName,
        },
      });
      return { voterId: existing.id, created: false, updated: true };
    }

    return { voterId: existing.id, created: false, updated: false };
  }

  // Create new CC member
  const newCc = await tx.cC.create({
    data: {
      ccId,
      hotCredential: ccMember?.cc_hot_id || ccId,
      coldCredential: ccMember?.cc_cold_id,
      status,
      memberName,
    },
  });

  return { voterId: newCc.id, created: true, updated: false };
}

/**
 * Gets CC member name from committee_votes meta_url
 */
async function getCcMemberName(ccHotId: string): Promise<string | null> {
  try {
    const committeeVotes = await koiosGet<Array<{
      cc_hot_id: string;
      meta_url?: string | null;
    }>>("/committee_votes", {
      _cc_hot_id: ccHotId,
    });

    const vote = committeeVotes?.[0];
    if (!vote?.meta_url) return null;

    // Fetch meta_url to get authors[].name
    const axios = (await import("axios")).default;
    const response = await axios.get(vote.meta_url, { timeout: 10000 });
    const metaData = response.data;

    // Get name from authors array
    if (metaData?.authors && Array.isArray(metaData.authors) && metaData.authors.length > 0) {
      return metaData.authors[0]?.name || null;
    }

    return null;
  } catch (error) {
    console.error(`Failed to fetch CC member name for ${ccHotId}:`, error);
    return null;
  }
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