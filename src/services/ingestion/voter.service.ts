/**
 * Voter Ingestion Service
 * Handles creation and updates of DRep, SPO, and CC voters
 */

import type { Prisma } from "@prisma/client";
import { koiosGet, koiosPost } from "../koios";
import type {
  KoiosDrep,
  KoiosDrepVotingPower,
  KoiosSpo,
  KoiosSpoVotingPower,
  KoiosCommitteeInfo,
  KoiosTip,
} from "../../types/koios.types";

/**
 * Some Koios metadata fields (e.g. from /drep_updates) can be returned either
 * as plain strings or as objects of the form `{ "@value": "..." }`.
 * This helper normalises them to plain strings so they can be stored in
 * Prisma `String` columns without causing runtime validation errors.
 */
function extractStringField(value: unknown): string | undefined {
  if (value == null) return undefined;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    // Common pattern for Koios / CIP-129 style fields
    const withValue = value as { [key: string]: unknown };
    const candidate = (withValue["@value"] ?? withValue["value"]) as unknown;

    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Normalises Koios boolean-like metadata fields.
 * Accepts:
 * - booleans
 * - "true"/"false" (case-insensitive) strings
 * - objects of the form `{ "@value": "true" }` or `{ value: false }`
 */
function extractBooleanField(value: unknown): boolean | undefined {
  if (value == null) return undefined;

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (normalised === "true") return true;
    if (normalised === "false") return false;
    return undefined;
  }

  if (typeof value === "object") {
    const withValue = value as { [key: string]: unknown };
    const candidate = withValue["@value"] ?? withValue["value"];
    return extractBooleanField(candidate);
  }

  return undefined;
}

/**
 * Recursively searches an extended metadata object for icon URLs.
 * Prefers `url_png_icon_64x64`, then falls back to `url_png_logo`.
 */
function findIconUrlInExtendedMeta(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") {
    return null;
  }

  const record = obj as Record<string, unknown>;

  const icon64 = record["url_png_icon_64x64"];
  if (typeof icon64 === "string" && icon64.trim()) {
    return icon64;
  }

  const logo = record["url_png_logo"];
  if (typeof logo === "string" && logo.trim()) {
    return logo;
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const found = findIconUrlInExtendedMeta(value);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

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
const drepVotingPowerCache = new Map<string, bigint>();
const spoInfoCache = new Map<string, KoiosSpo | undefined>();
const spoVotingPowerCache = new Map<string, bigint>();

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
    return { voterId: existing.drepId, created: false, updated: false };
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
    // Store voting power in lovelace as BigInt (1 ADA = 1,000,000 lovelace)
    votingPower = votingPowerLovelace ? BigInt(votingPowerLovelace) : BigInt(0);
    drepVotingPowerCache.set(cacheKey, votingPower);
  }

  // Fetch name, payment address, icon URL, and doNotList from drep_updates endpoint
  // Note: these are nested in meta_json.body and can sometimes be structured
  // as `{ "@value": "..." }` objects instead of plain strings.
  let name: string | undefined;
  let paymentAddress: string | undefined;
  let iconUrl: string | undefined;
  let doNotList: boolean | undefined;
  try {
    const drepUpdates = await koiosGet<
      Array<{
        meta_json?: {
          body?: {
            // Koios can return either `string` or `{ "@value": string }`
            givenName?: unknown;
            paymentAddress?: unknown;
            doNotList?: unknown;
            image?: {
              contentUrl?: unknown;
            };
          };
        } | null;
      }>
    >("/drep_updates", { _drep_id: drepId });

    // Find the first record that has usable metadata in meta_json
    for (const update of drepUpdates || []) {
      const body = update.meta_json?.body;
      if (!body) continue;

      if (!name && body.givenName !== undefined) {
        name = extractStringField(body.givenName);
      }

      if (!paymentAddress && body.paymentAddress !== undefined) {
        paymentAddress = extractStringField(body.paymentAddress);
      }

      if (!iconUrl && body.image?.contentUrl !== undefined) {
        iconUrl = extractStringField(body.image.contentUrl);
      }

      if (doNotList === undefined && body.doNotList !== undefined) {
        doNotList = extractBooleanField(body.doNotList);
      }

      // Break if we have all values
      if (name && paymentAddress && iconUrl && doNotList !== undefined) {
        break;
      }
    }
  } catch (error) {
    console.warn(`[Voter Service] Failed to fetch metadata for DRep ${drepId}`);
  }

  // Create new DRep
  const newDrep = await tx.drep.create({
    data: {
      drepId,
      votingPower,
      ...(name && { name }), // Only include if exists
      ...(paymentAddress && { paymentAddress }), // Only include if exists
      ...(iconUrl && { iconUrl }), // Only include if exists
      ...(typeof doNotList === "boolean" && { doNotList }), // Only include if resolved
    },
  });

  return { voterId: newDrep.drepId, created: true, updated: false };
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
    return { voterId: existing.poolId, created: false, updated: false };
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
    // Store voting power in lovelace as BigInt (1 ADA = 1,000,000 lovelace)
    votingPower = votingPowerLovelace ? BigInt(votingPowerLovelace) : BigInt(0);
    spoVotingPowerCache.set(cacheKey, votingPower);
  }

  // Get pool name, ticker, and icon URL from meta_json or meta_url
  const { poolName, ticker, iconUrl } = await getPoolMeta(koiosSpo);

  // Create new SPO
  const newSpo = await tx.sPO.create({
    data: {
      poolId,
      poolName,
      ticker,
      votingPower,
      ...(iconUrl && { iconUrl }), // Only include if exists
    },
  });

  return { voterId: newSpo.poolId, created: true, updated: false };
}

/**
 * Gets pool name, ticker, and icon URL from meta_json or fetches from meta_url
 * For iconUrl: meta_url → fetch extended URL → fetch url_png_icon_64x64
 */
async function getPoolMeta(koiosSpo: KoiosSpo | undefined): Promise<{
  poolName: string | null;
  ticker: string | null;
  iconUrl: string | null;
}> {
  if (!koiosSpo) {
    return { poolName: null, ticker: null, iconUrl: null };
  }

  // Start with values from Koios response
  let poolName: string | null = koiosSpo.meta_json?.name ?? null;
  let ticker: string | null = koiosSpo.meta_json?.ticker ?? null;
  let iconUrl: string | null = null;
  let extendedUrl: string | null = null;

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
      const response = await axios.get(fetchUrl, {
        timeout: 10000,
        maxRedirects: 5,
        headers: {
          // Some metadata hosts / short-url providers behave differently
          // for non-browser User-Agents. Use a browser-like UA so that
          // HTTP redirects (e.g. short URLs) are honoured consistently.
          "User-Agent":
            "Mozilla/5.0 (compatible; drep-delegator-feedback/1.0)",
          Accept: "application/json, text/plain, */*",
        },
      });
      const meta = response.data;

      // Only fill missing fields from fetched metadata
      if (!poolName) {
        poolName = meta?.name || null;
      }
      if (!ticker) {
        ticker = meta?.ticker || null;
      }

      // Get extended URL for icon
      extendedUrl = meta?.extended || null;
    } catch (error) {
      console.warn(
        `[Voter Service] Failed to fetch pool meta_url: ${koiosSpo.meta_url}`
      );
    }
  }

  // Fetch icon URL from extended metadata
  if (extendedUrl) {
    try {
      // Convert IPFS URLs to use an HTTP gateway
      let fetchUrl = extendedUrl;
      if (extendedUrl.startsWith("ipfs://")) {
        const ipfsHash = extendedUrl.replace("ipfs://", "");
        fetchUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
      }

      const axios = (await import("axios")).default;
      const response = await axios.get(fetchUrl, {
        timeout: 10000,
        maxRedirects: 5,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; drep-delegator-feedback/1.0)",
          Accept: "application/json, text/plain, */*",
        },
      });
      const extendedMeta = response.data;

      // Use recursive search to find icon URLs in various metadata structures
      iconUrl = findIconUrlInExtendedMeta(extendedMeta);
    } catch (error) {
      console.warn(
        `[Voter Service] Failed to fetch pool extended metadata: ${extendedUrl}`
      );
    }
  }

  // Final fallback: use top-level Koios ticker if still missing
  if (!ticker && koiosSpo.meta_json?.ticker) {
    ticker = koiosSpo.meta_json.ticker;
  }

  return { poolName, ticker, iconUrl };
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
    return { voterId: existing.ccId, created: false, updated: false };
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

  // Note: memberName will be populated later when we process their first vote
  // The vote metadata contains the author name which we'll use to update the CC member

  // Create new CC member
  const newCc = await tx.cC.create({
    data: {
      ccId,
      hotCredential: ccMember?.cc_hot_id || ccId,
      coldCredential: ccMember?.cc_cold_id,
      status,
      memberName: null, // Will be updated when processing votes
    },
  });

  return { voterId: newCc.ccId, created: true, updated: false };
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
export async function ingestCc(ccId: string, prisma: Prisma.TransactionClient) {
  return ensureCcExists(ccId, prisma);
}

/**
 * Result of syncing voter voting powers
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

/**
 * Syncs voting power for all DReps and SPOs in the database
 * Updates their voting power based on the latest epoch data from Koios
 */
export async function syncAllVoterVotingPower(
  prisma: Prisma.TransactionClient
): Promise<SyncVoterPowerResult> {
  const currentEpoch = await getCurrentEpoch();

  console.log(
    `[Voter Service] Starting voting power sync for epoch ${currentEpoch}...`
  );

  // Sync DReps
  const drepResult = await syncDrepVotingPower(prisma, currentEpoch);

  // Sync SPOs
  const spoResult = await syncSpoVotingPower(prisma, currentEpoch);

  return {
    dreps: drepResult,
    spos: spoResult,
    epoch: currentEpoch,
  };
}

/**
 * Syncs voting power for all DReps in the database
 * Only fetches voting power for DReps that exist in the database
 */
async function syncDrepVotingPower(
  prisma: Prisma.TransactionClient,
  epoch: number
): Promise<{ total: number; updated: number; failed: number; errors: string[] }> {
  const errors: string[] = [];
  let updated = 0;
  let failed = 0;

  // Get all DReps from database
  const dreps = await prisma.drep.findMany({
    select: { drepId: true },
  });

  if (dreps.length === 0) {
    console.log(`[Voter Service] No DReps in database to sync`);
    return { total: 0, updated: 0, failed: 0, errors: [] };
  }

  console.log(
    `[Voter Service] Syncing voting power for ${dreps.length} DReps...`
  );

  // Fetch voting power for each DRep individually
  // This is more efficient when we have fewer DReps in DB than on-chain
  for (const drep of dreps) {
    try {
      const votingPowerHistory = await koiosGet<KoiosDrepVotingPower[]>(
        "/drep_voting_power_history",
        {
          _epoch_no: epoch,
          _drep_id: drep.drepId,
        }
      );

      const votingPowerLovelace = votingPowerHistory?.[0]?.amount;

      if (votingPowerLovelace) {
        const newVotingPower = BigInt(votingPowerLovelace);
        await prisma.drep.update({
          where: { drepId: drep.drepId },
          data: { votingPower: newVotingPower },
        });
        updated++;
      }
      // If no voting power found, the DRep might be inactive - skip update
    } catch (error: any) {
      failed++;
      errors.push(`DRep ${drep.drepId}: ${error.message}`);
    }
  }

  console.log(
    `[Voter Service] DRep sync complete: ${updated} updated, ${failed} failed`
  );

  return { total: dreps.length, updated, failed, errors };
}

/**
 * Syncs voting power for all SPOs in the database
 * Only fetches voting power for SPOs that exist in the database
 */
async function syncSpoVotingPower(
  prisma: Prisma.TransactionClient,
  epoch: number
): Promise<{ total: number; updated: number; failed: number; errors: string[] }> {
  const errors: string[] = [];
  let updated = 0;
  let failed = 0;

  // Get all SPOs from database
  const spos = await prisma.sPO.findMany({
    select: { poolId: true },
  });

  if (spos.length === 0) {
    console.log(`[Voter Service] No SPOs in database to sync`);
    return { total: 0, updated: 0, failed: 0, errors: [] };
  }

  console.log(
    `[Voter Service] Syncing voting power for ${spos.length} SPOs...`
  );

  // Fetch voting power for each SPO individually
  // This is more efficient when we have fewer SPOs in DB than on-chain
  for (const spo of spos) {
    try {
      const votingPowerHistory = await koiosGet<KoiosSpoVotingPower[]>(
        "/pool_voting_power_history",
        {
          _epoch_no: epoch,
          _pool_bech32: spo.poolId,
        }
      );

      const votingPowerLovelace = votingPowerHistory?.[0]?.amount;

      if (votingPowerLovelace) {
        const newVotingPower = BigInt(votingPowerLovelace);
        await prisma.sPO.update({
          where: { poolId: spo.poolId },
          data: { votingPower: newVotingPower },
        });
        updated++;
      }
      // If no voting power found, the SPO might be inactive - skip update
    } catch (error: any) {
      failed++;
      errors.push(`SPO ${spo.poolId}: ${error.message}`);
    }
  }

  console.log(
    `[Voter Service] SPO sync complete: ${updated} updated, ${failed} failed`
  );

  return { total: spos.length, updated, failed, errors };
}
