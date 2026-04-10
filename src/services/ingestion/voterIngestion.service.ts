/**
 * Voter ingestion service.
 * Handles creation and enrichment of DRep, SPO, and CC voters.
 */

import { koiosGet, koiosPost } from "../koios";
import { getCommitteeInfo } from "../governanceProvider";
import type {
  KoiosDrepInfo,
  KoiosDrepVotingPower,
  KoiosSpo,
  KoiosSpoVotingPower,
} from "../../types/koios.types";
import { type IngestionDbClient, withIngestionDbWrite } from "./dbSession";
import { getKoiosCurrentEpoch } from "./sync-utils";
import {
  extractBooleanField,
  extractStringField,
} from "./koiosNormalizers";
import { fetchPoolMetadata } from "../remoteMetadata.service";
import {
  getCachedEligibleCCInfo,
  getEligibleCCInfo,
  syncCommitteeState,
  type EligibleCCInfo,
  type SyncCommitteeStateResult,
} from "../committeeState.service";

/**
 * Result of ensuring a voter exists.
 */
export interface EnsureVoterResult {
  voterId: string;
  created: boolean;
  updated: boolean;
  votingPower?: bigint | null;
}

export interface VoteVoterRef {
  voterRole: "DRep" | "SPO" | "ConstitutionalCommittee";
  voterId: string;
}

// Cache Koios lookups across a single bulk run so repeated voters do not fan out.
const drepInfoCache = new Map<string, KoiosDrepInfo | undefined>();
const drepVotingPowerCache = new Map<string, bigint>();
const spoInfoCache = new Map<string, KoiosSpo | undefined>();
const spoVotingPowerCache = new Map<string, bigint>();
const MAX_VOTER_SERVICE_CACHE_ENTRIES = 5000;

function setBoundedCacheEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  cacheName: string
): void {
  cache.set(key, value);
  while (cache.size > MAX_VOTER_SERVICE_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
    console.log(
      `[Voter Service] action=evict cache=${cacheName} size=${cache.size}`
    );
  }
}

export function clearVoterKoiosCaches(): void {
  drepInfoCache.clear();
  drepVotingPowerCache.clear();
  spoInfoCache.clear();
  spoVotingPowerCache.clear();
}

function getVoterCacheKey(voterRole: VoteVoterRef["voterRole"], voterId: string): string {
  return `${voterRole}:${voterId}`;
}

/**
 * Preloads missing voters for a vote window so the hot per-vote loop can avoid
 * repeating ensure/fetch work for duplicate voter identities.
 */
export async function preloadVotersForVotes(
  voters: VoteVoterRef[],
  tx: IngestionDbClient
): Promise<Map<string, EnsureVoterResult>> {
  const refsByKey = new Map<string, VoteVoterRef>();
  for (const voter of voters) {
    if (!voter?.voterId) continue;
    const key = getVoterCacheKey(voter.voterRole, voter.voterId);
    refsByKey.set(key, voter);
  }

  const drepIds: string[] = [];
  const spoIds: string[] = [];
  const ccIds: string[] = [];
  for (const voter of refsByKey.values()) {
    if (voter.voterRole === "DRep") drepIds.push(voter.voterId);
    else if (voter.voterRole === "SPO") spoIds.push(voter.voterId);
    else ccIds.push(voter.voterId);
  }

  const [existingDreps, existingSpos, existingCcs] = await Promise.all([
    drepIds.length > 0
      ? tx.drep.findMany({
          where: { drepId: { in: drepIds } },
          select: { drepId: true, votingPower: true },
        })
      : Promise.resolve([]),
    spoIds.length > 0
      ? tx.sPO.findMany({
          where: { poolId: { in: spoIds } },
          select: { poolId: true, votingPower: true },
        })
      : Promise.resolve([]),
    ccIds.length > 0
      ? tx.cC.findMany({
          where: { ccId: { in: ccIds } },
          select: { ccId: true },
        })
      : Promise.resolve([]),
  ]);

  const existingKeys = new Set<string>();
  const existingPowers = new Map<string, bigint | null>();
  for (const row of existingDreps) {
    const key = getVoterCacheKey("DRep", row.drepId);
    existingKeys.add(key);
    existingPowers.set(key, row.votingPower ?? null);
  }
  for (const row of existingSpos) {
    const key = getVoterCacheKey("SPO", row.poolId);
    existingKeys.add(key);
    existingPowers.set(key, row.votingPower ?? null);
  }
  for (const row of existingCcs) {
    existingKeys.add(getVoterCacheKey("ConstitutionalCommittee", row.ccId));
  }

  const preloaded = new Map<string, EnsureVoterResult>();
  for (const [key, ref] of refsByKey.entries()) {
    if (!existingKeys.has(key)) continue;
    preloaded.set(key, {
      voterId: ref.voterId,
      created: false,
      updated: false,
      votingPower: existingPowers.get(key),
    });
  }

  const missing = [...refsByKey.entries()].filter(([key]) => !existingKeys.has(key));
  for (const [key, ref] of missing) {
    const ensured = await ensureVoterExists(ref.voterRole, ref.voterId, tx);
    preloaded.set(key, ensured);
  }

  return preloaded;
}

/**
 * Ensures a voter exists in the database, creating or updating as needed.
 */
export async function ensureVoterExists(
  voterRole: "DRep" | "SPO" | "ConstitutionalCommittee",
  voterId: string,
  tx: IngestionDbClient
): Promise<EnsureVoterResult> {
  if (voterRole === "DRep") {
    return ensureDrepExists(voterId, tx);
  }
  if (voterRole === "SPO") {
    return ensureSpoExists(voterId, tx);
  }
  return ensureCcExists(voterId, tx);
}

async function ensureDrepExists(
  drepId: string,
  tx: IngestionDbClient
): Promise<EnsureVoterResult> {
  const existing = await tx.drep.findUnique({
    where: { drepId },
    select: { drepId: true, votingPower: true },
  });

  if (existing) {
    return {
      voterId: existing.drepId,
      created: false,
      updated: false,
      votingPower: existing.votingPower ?? null,
    };
  }

  let koiosDrep = drepInfoCache.get(drepId);
  if (koiosDrep === undefined) {
    const koiosDrepResponse = await koiosPost<KoiosDrepInfo[]>(
      "/drep_info",
      {
        _drep_ids: [drepId],
      },
      {
        source: "ingestion.voter.ensure-drep.drep-info",
      }
    );
    koiosDrep = koiosDrepResponse?.[0];
    setBoundedCacheEntry(drepInfoCache, drepId, koiosDrep, "drep-info");
  }

  const currentEpoch = await getKoiosCurrentEpoch();
  const cacheKey = `${drepId}_${currentEpoch}`;

  let votingPower = drepVotingPowerCache.get(cacheKey);
  if (votingPower === undefined) {
    const votingPowerHistory = await koiosGet<KoiosDrepVotingPower[]>(
      "/drep_voting_power_history",
      {
        _epoch_no: currentEpoch,
        _drep_id: drepId,
      },
      { source: "ingestion.voter.ensure-drep.drep-voting-power" }
    );
    const votingPowerLovelace = votingPowerHistory?.[0]?.amount;
    votingPower = votingPowerLovelace ? BigInt(votingPowerLovelace) : BigInt(0);
    setBoundedCacheEntry(
      drepVotingPowerCache,
      cacheKey,
      votingPower,
      "drep-voting-power"
    );
  }

  let name: string | undefined;
  let paymentAddress: string | undefined;
  let iconUrl: string | undefined;
  let doNotList: boolean | undefined;
  try {
    const drepUpdates = await koiosGet<
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
    >(
      "/drep_updates",
      { _drep_id: drepId },
      {
        source: "ingestion.voter.ensure-drep.drep-updates",
      }
    );

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

      if (name && paymentAddress && iconUrl && doNotList !== undefined) {
        break;
      }
    }
  } catch {
    console.warn(`[Voter Service] Failed to fetch metadata for DRep ${drepId}`);
  }

  const newDrep = await withIngestionDbWrite(tx, "voter-ingestion.drep.upsert", () =>
    tx.drep.upsert({
      where: { drepId },
      create: {
        drepId,
        votingPower,
        ...(name && { name }),
        ...(paymentAddress && { paymentAddr: paymentAddress }),
        ...(iconUrl && { iconUrl }),
        ...(typeof doNotList === "boolean" && { doNotList }),
      },
      update: {},
    })
  );

  return {
    voterId: newDrep.drepId,
    created: true,
    updated: false,
    votingPower: newDrep.votingPower ?? null,
  };
}

async function ensureSpoExists(
  poolId: string,
  tx: IngestionDbClient
): Promise<EnsureVoterResult> {
  let koiosSpo = spoInfoCache.get(poolId);
  if (koiosSpo === undefined) {
    const koiosSpoResponse = await koiosPost<KoiosSpo[]>(
      "/pool_info",
      {
        _pool_bech32_ids: [poolId],
      },
      {
        source: "ingestion.voter.ensure-spo.pool-info",
      }
    );
    koiosSpo = koiosSpoResponse?.[0];
    setBoundedCacheEntry(spoInfoCache, poolId, koiosSpo, "spo-info");
  }

  const currentEpoch = await getKoiosCurrentEpoch();
  const cacheKey = `${poolId}_${currentEpoch}`;

  let votingPower = spoVotingPowerCache.get(cacheKey);
  if (votingPower === undefined) {
    const votingPowerHistory = await koiosGet<KoiosSpoVotingPower[]>(
      "/pool_voting_power_history",
      {
        _epoch_no: currentEpoch,
        _pool_bech32: poolId,
      },
      { source: "ingestion.voter.ensure-spo.pool-voting-power" }
    );
    const votingPowerLovelace = votingPowerHistory?.[0]?.amount;
    votingPower = votingPowerLovelace ? BigInt(votingPowerLovelace) : BigInt(0);
    setBoundedCacheEntry(
      spoVotingPowerCache,
      cacheKey,
      votingPower,
      "spo-voting-power"
    );
  }

  const { poolName, ticker, iconUrl } = await fetchPoolMetadata(koiosSpo);

  const createResult = await withIngestionDbWrite(tx, "voter-ingestion.spo.createMany", () =>
    tx.sPO.createMany({
      data: {
        poolId,
        poolName,
        ticker,
        votingPower,
        ...(iconUrl && { iconUrl }),
      },
      skipDuplicates: true,
    })
  );

  if (createResult.count > 0) {
    return {
      voterId: poolId,
      created: true,
      updated: false,
      votingPower,
    };
  }

  const existing = await tx.sPO.findUnique({
    where: { poolId },
    select: { poolId: true, votingPower: true },
  });

  if (!existing) {
    throw new Error(
      `[Voter Service] Expected existing SPO after duplicate-safe insert: ${poolId}`
    );
  }

  return {
    voterId: existing.poolId,
    created: false,
    updated: false,
    votingPower: existing.votingPower ?? null,
  };
}

async function ensureCcExists(
  ccId: string,
  tx: IngestionDbClient
): Promise<EnsureVoterResult> {
  const committeeInfo = await getCommitteeInfo({
    source: "ingestion.voter.ensure-cc.committee-info",
  });

  const ccMember = committeeInfo?.members?.find(
    (member) => member.cc_hot_id === ccId
  );

  const currentEpoch = await getKoiosCurrentEpoch();
  let status = "active";
  if (ccMember?.expiration_epoch && ccMember.expiration_epoch <= currentEpoch) {
    status = "expired";
  }

  const createResult = await withIngestionDbWrite(tx, "voter-ingestion.cc.createMany", () =>
    tx.cC.createMany({
      data: {
        ccId,
        hotCredential: ccMember?.cc_hot_id || ccId,
        coldCredential: ccMember?.cc_cold_id,
        status,
        memberName: null,
      },
      skipDuplicates: true,
    })
  );

  if (createResult.count > 0) {
    return { voterId: ccId, created: true, updated: false };
  }

  const existing = await tx.cC.findUnique({
    where: { ccId },
  });

  if (!existing) {
    throw new Error(
      `[Voter Service] Expected existing CC after duplicate-safe insert: ${ccId}`
    );
  }

  return { voterId: existing.ccId, created: false, updated: false };
}

/**
 * Direct ingestion entrypoints used by admin/debug controllers.
 */
export async function ingestDrep(
  drepId: string,
  prisma: IngestionDbClient
): Promise<EnsureVoterResult> {
  return ensureDrepExists(drepId, prisma);
}

export async function ingestSpo(
  poolId: string,
  prisma: IngestionDbClient
): Promise<EnsureVoterResult> {
  return ensureSpoExists(poolId, prisma);
}

export async function ingestCc(
  ccId: string,
  prisma: IngestionDbClient
): Promise<EnsureVoterResult> {
  return ensureCcExists(ccId, prisma);
}

export {
  getCachedEligibleCCInfo,
  getEligibleCCInfo,
  syncCommitteeState,
};
export type { EligibleCCInfo, SyncCommitteeStateResult };
