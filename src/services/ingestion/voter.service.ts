/**
 * Voter Ingestion Service
 * Handles creation and updates of DRep, SPO, and CC voters
 */

import type { Prisma } from "@prisma/client";
import { koiosGet, koiosPost } from "../koios";
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

// Cache for API responses to avoid duplicate calls within a transaction
const drepInfoCache = new Map<string, KoiosDrep | undefined>();
const drepVotingPowerCache = new Map<string, number>();
const spoInfoCache = new Map<string, KoiosSpo | undefined>();
const spoVotingPowerCache = new Map<string, number>();

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

  // If voter exists, just return it without updating (optimization for initial sync)
  // Voting power updates can be done in a separate background job
  if (existing) {
    return { voterId: existing.id, created: false, updated: false };
  }

  // Check cache first, then fetch if not cached
  let koiosDrep = drepInfoCache.get(drepId);
  if (koiosDrep === undefined) {
    const koiosDrepResponse = await koiosPost<KoiosDrep[]>("/drep_info", {
      _drep_ids: [drepId],
    });
    koiosDrep = koiosDrepResponse?.[0];
    drepInfoCache.set(drepId, koiosDrep);
  }

  // Get current epoch for voting power history
  const currentEpoch = await getCurrentEpoch();
  const cacheKey = `${drepId}_${currentEpoch}`;

  let votingPower = drepVotingPowerCache.get(cacheKey);
  if (votingPower === undefined) {
    const votingPowerHistory = await koiosGet<KoiosDrepVotingPower[]>(
      "/drep_voting_power_history",
      {
        _epoch_no: currentEpoch,
        _drep_id: drepId,
      }
    );
    const votingPowerLovelace = votingPowerHistory?.[0]?.amount;
    votingPower = lovelaceToAda(votingPowerLovelace) || 0;
    drepVotingPowerCache.set(cacheKey, votingPower);
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

  // If voter exists, just return it without updating (optimization for initial sync)
  // Voting power updates can be done in a separate background job
  if (existing) {
    return { voterId: existing.id, created: false, updated: false };
  }

  // Check cache first, then fetch if not cached
  let koiosSpo = spoInfoCache.get(poolId);
  if (koiosSpo === undefined) {
    const koiosSpoResponse = await koiosPost<KoiosSpo[]>("/pool_info", {
      _pool_bech32_ids: [poolId],
    });
    koiosSpo = koiosSpoResponse?.[0];
    spoInfoCache.set(poolId, koiosSpo);
  }

  // Get current epoch for voting power history
  const currentEpoch = await getCurrentEpoch();
  const cacheKey = `${poolId}_${currentEpoch}`;

  let votingPower = spoVotingPowerCache.get(cacheKey);
  if (votingPower === undefined) {
    const votingPowerHistory = await koiosGet<KoiosSpoVotingPower[]>(
      "/pool_voting_power_history",
      {
        _epoch_no: currentEpoch,
        _pool_bech32: poolId,
      }
    );
    const votingPowerLovelace = votingPowerHistory?.[0]?.amount;
    votingPower = lovelaceToAda(votingPowerLovelace) || 0;
    spoVotingPowerCache.set(cacheKey, votingPower);
  }

  // Get pool name and ticker from meta_json or meta_url
  const { poolName, ticker } = await getPoolMeta(koiosSpo);

  // Create new SPO
  const newSpo = await tx.sPO.create({
    data: {
      poolId,
      poolName,
      ticker,
      votingPower,
    },
  });

  return { voterId: newSpo.id, created: true, updated: false };
}

/**
 * Gets pool name and ticker from meta_json or fetches from meta_url
 */
async function getPoolMeta(
  koiosSpo: KoiosSpo | undefined
): Promise<{ poolName: string | null; ticker: string | null }> {
  if (!koiosSpo) {
    return { poolName: null, ticker: null };
  }

  // Start with values from Koios response
  let poolName: string | null = koiosSpo.meta_json?.name ?? null;
  let ticker: string | null = koiosSpo.meta_json?.ticker ?? null;

  // If both already present in meta_json, no need to fetch
  if (poolName && ticker) {
    return { poolName, ticker };
  }

  // Fallback to fetching from meta_url
  if (koiosSpo.meta_url) {
    try {
      // Convert IPFS URLs to use an HTTP gateway
      let fetchUrl = koiosSpo.meta_url;
      if (koiosSpo.meta_url.startsWith("ipfs://")) {
        const ipfsHash = koiosSpo.meta_url.replace("ipfs://", "");
        fetchUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
      }

      const axios = (await import("axios")).default;
      const response = await axios.get(fetchUrl, { timeout: 10000 });
      const meta = response.data;

      // Only fill missing fields from fetched metadata
      if (!poolName) {
        poolName = meta?.name || null;
      }
      if (!ticker) {
        ticker = meta?.ticker || null;
      }
    } catch (error) {
      console.error(`Failed to fetch pool meta_url: ${koiosSpo.meta_url}`, error);
    }
  }

  // Final fallback: use top-level Koios ticker if still missing
  if (!ticker && koiosSpo.ticker) {
    ticker = koiosSpo.ticker;
  }

  return { poolName, ticker };
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

  // If voter exists, just return it without updating (optimization for initial sync)
  if (existing) {
    return { voterId: existing.id, created: false, updated: false };
  }

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
    // Fetch all committee votes and filter in memory
    const allCommitteeVotes = await koiosGet<Array<{
      cc_hot_id: string;
      meta_url?: string | null;
    }>>("/committee_votes");

    const vote = allCommitteeVotes?.find((v) => v.cc_hot_id === ccHotId);
    if (!vote?.meta_url) return null;

    // Convert IPFS URLs to use an HTTP gateway
    let fetchUrl = vote.meta_url;
    if (vote.meta_url.startsWith('ipfs://')) {
      const ipfsHash = vote.meta_url.replace('ipfs://', '');
      fetchUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
    }

    // Fetch meta_url to get authors[].name
    const axios = (await import("axios")).default;
    const response = await axios.get(fetchUrl, { timeout: 10000 });
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