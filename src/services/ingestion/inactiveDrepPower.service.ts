import { VoterType } from "@prisma/client";
import { prisma } from "../prisma";
import { getDrepInfoBatch } from "../drep-lookup";
import {
  getDrepUpdates,
  listDrepVotingPowerHistory,
} from "../governanceProvider";

type InactivePowerMode = "active" | "completed";

interface InactivePowerCacheEntry {
  value: bigint;
  expiresAtMs: number;
}

export interface InactivePowerMetrics {
  requestsTotal: number;
  runCacheHits: number;
  processCacheHits: number;
  cacheMisses: number;
  uniqueKeys: Set<string>;
}

const INACTIVE_ACTIVE_CACHE_TTL_MS =
  Number(process.env.INACTIVE_POWER_ACTIVE_TTL_MS ?? 15 * 60 * 1000);
const INACTIVE_COMPLETED_CACHE_TTL_MS =
  Number(process.env.INACTIVE_POWER_COMPLETED_TTL_MS ?? 24 * 60 * 60 * 1000);

// DRep inactivity rules (20-epoch activity window) were introduced starting from epoch 527.
// The drep_activity field started at 20 in epoch 507, so the ledger began checking
// DRep activity from epoch 507 + 20 = 527.
export const DREP_INACTIVITY_START_EPOCH = 527;

// Special predefined voting options are tracked in voting summaries, but they are
// not real DRep identities and should never count as inactive DReps.
const SPECIAL_DREP_IDS = ["drep_always_abstain", "drep_always_no_confidence"];

const inactivePowerProcessCache = new Map<string, InactivePowerCacheEntry>();

export function createInactivePowerMetrics(): InactivePowerMetrics {
  return {
    requestsTotal: 0,
    runCacheHits: 0,
    processCacheHits: 0,
    cacheMisses: 0,
    uniqueKeys: new Set<string>(),
  };
}

export function logInactivePowerMetrics(metrics: InactivePowerMetrics): void {
  console.log(
    `[Proposal Sync][Inactive Cache] requests=${metrics.requestsTotal} uniqueKeys=${metrics.uniqueKeys.size} runHits=${metrics.runCacheHits} processHits=${metrics.processCacheHits} misses=${metrics.cacheMisses}`
  );
}

function getInactivePowerCacheKey(
  epoch: number,
  mode: InactivePowerMode
): string {
  return `inactive:${epoch}:${mode}`;
}

function getInactivePowerTtlMs(mode: InactivePowerMode): number {
  return mode === "active"
    ? INACTIVE_ACTIVE_CACHE_TTL_MS
    : INACTIVE_COMPLETED_CACHE_TTL_MS;
}

function getProcessCachedInactivePower(cacheKey: string): bigint | null {
  const now = Date.now();
  const cached = inactivePowerProcessCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAtMs <= now) {
    inactivePowerProcessCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function setProcessCachedInactivePower(
  cacheKey: string,
  value: bigint,
  ttlMs: number
): void {
  inactivePowerProcessCache.set(cacheKey, {
    value,
    expiresAtMs: Date.now() + ttlMs,
  });
}

export async function getInactivePowerWithCache(
  inactivePowerEpoch: number,
  isActiveProposal: boolean,
  runCache?: Map<string, bigint>,
  metrics?: InactivePowerMetrics
): Promise<bigint> {
  const mode: InactivePowerMode = isActiveProposal ? "active" : "completed";
  const cacheKey = getInactivePowerCacheKey(inactivePowerEpoch, mode);

  if (metrics) {
    metrics.requestsTotal += 1;
    metrics.uniqueKeys.add(cacheKey);
  }

  const runCached = runCache?.get(cacheKey);
  if (runCached != null) {
    if (metrics) {
      metrics.runCacheHits += 1;
    }
    return runCached;
  }

  const processCached = getProcessCachedInactivePower(cacheKey);
  if (processCached != null) {
    runCache?.set(cacheKey, processCached);
    if (metrics) {
      metrics.processCacheHits += 1;
    }
    return processCached;
  }

  if (metrics) {
    metrics.cacheMisses += 1;
  }

  const fetchInactivePower = isActiveProposal
    ? fetchInactiveDrepVotingPowerForActiveProposal
    : fetchInactiveDrepVotingPowerForCompletedProposal;

  const value = await fetchInactivePower(inactivePowerEpoch);
  const ttlMs = getInactivePowerTtlMs(mode);
  runCache?.set(cacheKey, value);
  setProcessCachedInactivePower(cacheKey, value, ttlMs);
  return value;
}

function blockTimeToEpoch(blockTime: number): number {
  const shelleyStart = 1596491091;
  const epochLength = 432000;
  const shelleyStartEpoch = 208;

  if (blockTime < shelleyStart) {
    return 0;
  }

  return (
    shelleyStartEpoch + Math.floor((blockTime - shelleyStart) / epochLength)
  );
}

async function fetchInactiveDrepVotingPowerForActiveProposal(
  referenceEpoch: number
): Promise<bigint> {
  try {
    console.log(
      `[Inactive DRep Power] Calculating for ACTIVE proposal at epoch ${referenceEpoch} using /drep_info API`
    );

    const drepIds: string[] = [];
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await listDrepVotingPowerHistory({
        epochNo: referenceEpoch,
        limit: pageSize,
        offset,
        source: "ingestion.proposal.inactive-power.active.drep-history",
      });
      if (page && page.length > 0) {
        for (const dp of page) {
          if (
            dp.amount &&
            dp.amount !== "0" &&
            !SPECIAL_DREP_IDS.includes(dp.drep_id)
          ) {
            drepIds.push(dp.drep_id);
          }
        }
        offset += page.length;
        hasMore = page.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    console.log(
      `[Inactive DRep Power] Found ${drepIds.length} DReps with voting power for epoch ${referenceEpoch}`
    );

    if (drepIds.length === 0) {
      return BigInt(0);
    }

    let inactivePowerLovelace = BigInt(0);
    let inactiveCount = 0;
    let activeCount = 0;

    const drepInfos = await getDrepInfoBatch(prisma, drepIds);

    for (const info of drepInfos) {
      if (info.active === false && info.votingPower > BigInt(0)) {
        inactivePowerLovelace += info.votingPower;
        inactiveCount++;
      } else if (info.active === true) {
        activeCount++;
      }
    }

    const inactivePowerAda = Number(inactivePowerLovelace) / 1_000_000;
    console.log(
      `[Inactive DRep Power] Found ${activeCount} active, ${inactiveCount} inactive DReps`
    );
    console.log(
      `[Inactive DRep Power] Inactive voting power: ${inactivePowerAda.toLocaleString()} ADA (${inactivePowerLovelace} lovelace) for epoch ${referenceEpoch}`
    );

    return inactivePowerLovelace;
  } catch (error: any) {
    console.warn(
      `[Inactive DRep Power] Failed to fetch for epoch ${referenceEpoch}:`,
      error.message
    );
    return BigInt(0);
  }
}

async function fetchInactiveDrepVotingPowerForCompletedProposal(
  referenceEpoch: number
): Promise<bigint> {
  const ACTIVITY_WINDOW = 20;
  const minActiveEpoch = referenceEpoch - ACTIVITY_WINDOW;

  try {
    console.log(
      `[Inactive DRep Power] Calculating for epoch ${referenceEpoch} (activity window: epochs ${minActiveEpoch} to ${referenceEpoch})`
    );

    const drepPowerMap = new Map<string, string>();
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await listDrepVotingPowerHistory({
        epochNo: referenceEpoch,
        limit: pageSize,
        offset,
        source: "ingestion.proposal.inactive-power.completed.drep-history",
      });
      if (page && page.length > 0) {
        for (const dp of page) {
          if (dp.amount && dp.amount !== "0") {
            drepPowerMap.set(dp.drep_id, dp.amount);
          }
        }
        offset += page.length;
        hasMore = page.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    console.log(
      `[Inactive DRep Power] Found ${drepPowerMap.size} DReps with voting power for epoch ${referenceEpoch}`
    );

    if (drepPowerMap.size === 0) {
      return BigInt(0);
    }

    const activeDrepIds = new Set<string>();

    const activeVoters = await prisma.onchainVote.findMany({
      where: {
        voterType: VoterType.DREP,
        drepId: { not: null },
        proposal: {
          OR: [
            {
              submissionEpoch: {
                gte: minActiveEpoch,
                lte: referenceEpoch,
              },
            },
            {
              expirationEpoch: {
                gte: minActiveEpoch,
              },
              submissionEpoch: {
                lte: referenceEpoch,
              },
            },
          ],
        },
      },
      select: {
        drepId: true,
      },
      distinct: ["drepId"],
    });

    for (const voter of activeVoters) {
      if (voter.drepId) {
        activeDrepIds.add(voter.drepId);
      }
    }

    console.log(
      `[Inactive DRep Power] Found ${activeDrepIds.size} DReps who voted in the activity window (from database)`
    );

    const drepsWithoutVotes: string[] = [];
    for (const drepId of drepPowerMap.keys()) {
      if (!activeDrepIds.has(drepId) && !SPECIAL_DREP_IDS.includes(drepId)) {
        drepsWithoutVotes.push(drepId);
      }
    }

    console.log(
      `[Inactive DRep Power] ${drepsWithoutVotes.length} DReps haven't voted, checking certificate updates (DB-first)...`
    );

    const lifecycleActiveRows = await prisma.drepLifecycleEvent.findMany({
      where: {
        drepId: { in: drepsWithoutVotes },
        epochNo: {
          gte: minActiveEpoch,
          lte: referenceEpoch,
        },
      },
      select: { drepId: true },
      distinct: ["drepId"],
    });

    for (const row of lifecycleActiveRows) {
      activeDrepIds.add(row.drepId);
    }

    const lifecycleSeenRows = await prisma.drepLifecycleEvent.findMany({
      where: {
        drepId: { in: drepsWithoutVotes },
      },
      select: { drepId: true },
      distinct: ["drepId"],
    });
    const lifecycleSeenIds = new Set(
      lifecycleSeenRows.map((row) => row.drepId)
    );

    const drepIdsMissingLifecycle = drepsWithoutVotes.filter(
      (drepId) => !lifecycleSeenIds.has(drepId)
    );

    console.log(
      `[Inactive DRep Power] Lifecycle cache hit for ${drepsWithoutVotes.length - drepIdsMissingLifecycle.length}/${drepsWithoutVotes.length} DReps; ` +
        `falling back to Koios for ${drepIdsMissingLifecycle.length} DReps missing lifecycle rows`
    );

    for (const drepId of drepIdsMissingLifecycle) {
      try {
        const updates = await getDrepUpdates(drepId, {
          source: "ingestion.proposal.inactive-power.completed.drep-updates",
        });
        if (updates && updates.length > 0) {
          for (const update of updates) {
            const updateEpoch = blockTimeToEpoch(update.block_time);
            if (
              updateEpoch >= minActiveEpoch &&
              updateEpoch <= referenceEpoch
            ) {
              activeDrepIds.add(drepId);
              break;
            }
          }
        }
      } catch (error: any) {
        console.warn(
          `[Inactive DRep Power] Failed to fetch updates for ${drepId}: ${error.message}`
        );
      }
    }

    console.log(
      `[Inactive DRep Power] Total active DReps (voted or updated certificate): ${activeDrepIds.size}`
    );

    let inactivePowerLovelace = BigInt(0);
    let inactiveCount = 0;

    for (const [drepId, amount] of drepPowerMap) {
      if (!activeDrepIds.has(drepId) && !SPECIAL_DREP_IDS.includes(drepId)) {
        inactivePowerLovelace += BigInt(amount);
        inactiveCount++;
      }
    }

    const inactivePowerAda = Number(inactivePowerLovelace) / 1_000_000;
    console.log(
      `[Inactive DRep Power] Found ${inactiveCount} inactive DReps with ${inactivePowerAda.toLocaleString()} ADA for epoch ${referenceEpoch}`
    );

    return inactivePowerLovelace;
  } catch (error: any) {
    console.warn(
      `[Inactive DRep Power] Failed to fetch for epoch ${referenceEpoch}:`,
      error.message
    );
    return BigInt(0);
  }
}
