/**
 * Vote Ingestion Service
 * Handles ingestion of onchain votes for proposals
 */

import { VoteType, VoterType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { listVotes } from "../governanceProvider";
import { fetchJsonWithBrowserLikeClient } from "../remoteMetadata.service";
import { fetchTxMetadataByHash } from "../txMetadata.service";
import { ensureVoterExists } from "./voterIngestion.service";
import type { KoiosVote } from "../../types/koios.types";
import {
  extractSurveyResponse,
} from "../../libs/surveyMetadata";

// Cache for vote metadata JSON keyed by anchor URL to avoid duplicate fetches
const voteMetadataCache = new Map<string, string | null>();
const voteTxMetadataCache = new Map<string, Record<string, unknown> | Array<Record<string, unknown>> | null>();

export interface VoteIngestionRunCache {
  proposalVotes: Map<string, KoiosVote[]>;
  proposalVotesInFlight: Map<string, Promise<KoiosVote[]>>;
}

export function createVoteIngestionRunCache(): VoteIngestionRunCache {
  return {
    proposalVotes: new Map(),
    proposalVotesInFlight: new Map(),
  };
}

/**
 * Fetches and serialises vote metadata JSON for a Koios vote.
 *
 * Preference order:
 * 1. Use meta_json from Koios response when available (no extra HTTP).
 * 2. Otherwise, fetch from meta_url / anchor_url, with IPFS gateway support.
 *
 * Returns the JSON as a string suitable for storing in Prisma String column,
 * or null if nothing could be fetched.
 */
async function getVoteRationaleJson(koiosVote: KoiosVote): Promise<string | null> {
  // 1) Prefer inline meta_json from Koios if present
  if (koiosVote.meta_json) {
    try {
      return JSON.stringify(koiosVote.meta_json);
    } catch (error: any) {
      console.warn(
        `[Vote Metadata] Failed to serialise meta_json for vote ${koiosVote.vote_tx_hash}:`,
        error?.message ?? error
      );
      // Fall through to URL-based fetch as a fallback
    }
  }

  // 2) Fallback to fetching from meta_url / anchor_url
  const rawUrl = koiosVote.meta_url;
  if (!rawUrl) {
    return null;
  }

  // Return from cache if we've already attempted this URL
  const cached = voteMetadataCache.get(rawUrl);
  if (cached !== undefined) {
    return cached;
  }

  let fetchUrl = rawUrl;

  // Handle ipfs:// URLs by routing through a public HTTP gateway
  if (fetchUrl.startsWith("ipfs://")) {
    const ipfsHash = fetchUrl.replace("ipfs://", "");
    fetchUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
    console.log(`[Vote Metadata] Converting IPFS URL to gateway: ${fetchUrl}`);
  }

  try {
    // Use the shared browser-like JSON fetcher which:
    // 1) Attempts a normal Axios HTTP GET first
    // 2) Falls back to Puppeteer for providers that block plain HTTP clients
    const meta = await fetchJsonWithBrowserLikeClient(fetchUrl);

    if (!meta) {
      voteMetadataCache.set(rawUrl, null);
      return null;
    }

    const jsonString = JSON.stringify(meta);
    voteMetadataCache.set(rawUrl, jsonString);
    return jsonString;
  } catch (error: any) {
    const message =
      error?.message ??
      (typeof error?.toString === "function" ? error.toString() : String(error));

    console.warn(
      `[Vote Metadata] Failed to fetch vote metadata (with Puppeteer fallback) from ${rawUrl}`,
      message
    );
    voteMetadataCache.set(rawUrl, null);
    return null;
  }
}

/**
 * Statistics for vote ingestion
 */
export interface VoteIngestionStats {
  votesIngested: number;
  votesUpdated: number;
  votesProcessed: number;
  votersCreated: { dreps: number; spos: number; ccs: number };
  votersUpdated: { dreps: number; spos: number; ccs: number };
  metadata: {
    attempts: number;
    success: number;
    failed: number;
    skipped: number;
  };
}

export interface VoteIngestionResult {
  success: boolean;
  stats: VoteIngestionStats;
  error?: string;
}

/**
 * Clears the vote cache - should be called at the start of each sync
 */
export function clearVoteCache() {
  voteMetadataCache.clear();
  voteTxMetadataCache.clear();
}

/**
 * Ingests all votes for a specific proposal
 *
 * @param proposalId - Cardano governance action ID (proposal_id from Koios)
 * @param tx - Prisma transaction client
 * @param minEpoch - Optional minimum epoch to fetch votes from (inclusive).
 *                   Used to avoid fetching historical votes that cannot belong
 *                   to the proposals we are currently syncing.
 * @param options - Optional flags:
 *                  - useCache: when true (default), we fetch all votes once
 *                    and keep them in memory for the duration of a bulk sync.
 *                    When false, we query Koios just for this proposal and do
 *                    not touch the global cache. This is ideal for sync-on-read.
 * @returns Statistics about votes and voters created/updated
 */
export async function ingestVotesForProposal(
  proposalId: string,
  tx: Prisma.TransactionClient,
  minEpoch?: number,
  options?: { useCache?: boolean; runCache?: VoteIngestionRunCache }
): Promise<VoteIngestionResult> {
  const startedAt = Date.now();
  const stats: VoteIngestionStats = {
    votesIngested: 0,
    votesUpdated: 0,
    votesProcessed: 0,
    votersCreated: { dreps: 0, spos: 0, ccs: 0 },
    votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
    metadata: {
      attempts: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    },
  };

  const useCache = options?.useCache !== false;

  try {
    let koiosVotes: KoiosVote[] = [];

    if (useCache) {
      const runCache = options?.runCache;
      if (!runCache) {
        console.warn(
          `[Vote Ingestion] action=proposal-cache-missing proposal=${proposalId} message=run cache not provided; fetching directly`
        );
        koiosVotes = await fetchVotesWithPagination(proposalId, minEpoch);
      } else {
        const cacheKey = getProposalVoteCacheKey(proposalId, minEpoch);
        const cachedVotes = runCache.proposalVotes.get(cacheKey);
        if (cachedVotes) {
          koiosVotes = cachedVotes;
        } else {
          let inFlight = runCache.proposalVotesInFlight.get(cacheKey);
          if (!inFlight) {
            inFlight = fetchVotesWithPagination(proposalId, minEpoch).then(
              (proposalVotes) => {
                runCache.proposalVotes.set(cacheKey, proposalVotes);
                console.log(
                  `[Vote Ingestion] ✓ Fetched ${proposalVotes.length} votes for proposal ${proposalId}`
                );
                return proposalVotes;
              }
            );
            runCache.proposalVotesInFlight.set(cacheKey, inFlight);
          } else {
            console.log(
              `[Vote Ingestion] action=single-flight-join proposal=${proposalId}`
            );
          }

          try {
            koiosVotes = await inFlight;
          } finally {
            runCache.proposalVotesInFlight.delete(cacheKey);
          }
        }
      }
    } else {
      koiosVotes = await fetchVotesWithPagination(proposalId, minEpoch);
    }

    if (koiosVotes.length === 0) {
      console.log(
        `[Vote Ingestion] No votes found for proposal ${proposalId}`
      );
      return {
        success: true,
        stats,
      };
    }

    console.log(
      `[Vote Ingestion] Found ${koiosVotes.length} votes for proposal ${proposalId}`
    );

    const proposalSurveyContext = await tx.proposal.findUnique({
      where: { proposalId },
      select: { linkedSurveyTxId: true },
    });
    const shouldFetchSurveyMetadata = Boolean(
      proposalSurveyContext?.linkedSurveyTxId
    );

    // Process each vote
    for (const koiosVote of koiosVotes) {
      await ingestSingleVote(
        koiosVote,
        proposalId,
        tx,
        stats,
        shouldFetchSurveyMetadata
      );
    }
  } catch (error: any) {
    // Vote ingestion errors remain non-fatal at this layer so later sync triggers
    // can resume from partial progress without replaying the whole proposal ingest.
    const errorMessage = error?.message ?? String(error);
    console.error(
      `[Vote Ingestion] action=partial-failure proposal=${proposalId} message=${errorMessage}`
    );
    return {
      success: false,
      stats,
      error: errorMessage,
    };
  }

  console.log(
    `[Vote Ingestion] Summary proposal=${proposalId} success=true durationMs=${Date.now() - startedAt} votesProcessed=${stats.votesProcessed} created=${stats.votesIngested} updated=${stats.votesUpdated} metadataAttempts=${stats.metadata.attempts} metadataSuccess=${stats.metadata.success} metadataFailed=${stats.metadata.failed} metadataSkipped=${stats.metadata.skipped}`
  );
  return {
    success: true,
    stats,
  };
}

function getProposalVoteCacheKey(
  proposalId: string,
  minEpoch?: number
): string {
  return `${proposalId}:${typeof minEpoch === "number" ? minEpoch : "all"}`;
}

async function fetchVotesWithPagination(
  proposalId: string,
  minEpoch?: number
): Promise<KoiosVote[]> {
  let allVotes: KoiosVote[] = [];
  let offset = 0;
  const limit = 1000;
  let hasMore = true;

  console.log(
    `[Vote Ingestion] Fetching votes for proposal ${proposalId}${
      typeof minEpoch === "number" ? ` from epoch >= ${minEpoch}` : ""
    }...`
  );

  while (hasMore) {
    const batch = await listVotes({
      proposalId,
      minEpoch,
      limit,
      offset,
      order: "block_time.asc,vote_tx_hash.asc",
      source: "ingestion.vote.ingest.proposal.vote-list",
    });

    if (!batch || batch.length === 0) {
      hasMore = false;
      continue;
    }

    allVotes = allVotes.concat(batch);
    offset += batch.length;
    console.log(`[Vote Ingestion]   Fetched ${allVotes.length} votes so far...`);

    if (batch.length < limit) {
      hasMore = false;
    }
  }

  return allVotes;
}

/**
 * Ingests a single vote
 */
async function ingestSingleVote(
  koiosVote: KoiosVote,
  proposalId: string,
  tx: Prisma.TransactionClient,
  stats: VoteIngestionStats,
  shouldFetchSurveyMetadata: boolean
): Promise<void> {
  stats.votesProcessed++;
  // 1. Ensure voter exists (creates if needed, updates voting power)
  const voterResult = await ensureVoterExists(
    koiosVote.voter_role,
    koiosVote.voter_id,
    tx
  );

  // Update stats for voter creation/update
  if (voterResult.created) {
    if (koiosVote.voter_role === "DRep") stats.votersCreated.dreps++;
    else if (koiosVote.voter_role === "SPO") stats.votersCreated.spos++;
    else stats.votersCreated.ccs++;
  } else if (voterResult.updated) {
    if (koiosVote.voter_role === "DRep") stats.votersUpdated.dreps++;
    else if (koiosVote.voter_role === "SPO") stats.votersUpdated.spos++;
    else stats.votersUpdated.ccs++;
  }

  // 1b. For CC votes, update member name from vote metadata
  if (koiosVote.voter_role === "ConstitutionalCommittee" && koiosVote.meta_json?.authors) {
    const memberName = koiosVote.meta_json.authors[0]?.name;
    if (memberName) {
      await tx.cC.update({
        where: { ccId: voterResult.voterId },
        data: { memberName: memberName },
      });
    }
  }

  // 2. Map Koios voter role to Prisma VoterType enum
  const voterType =
    koiosVote.voter_role === "DRep"
      ? VoterType.DREP
      : koiosVote.voter_role === "SPO"
      ? VoterType.SPO
      : VoterType.CC;

  // 3. Map Koios vote to Prisma VoteType enum
  const voteType =
    koiosVote.vote === "Yes"
      ? VoteType.YES
      : koiosVote.vote === "No"
      ? VoteType.NO
      : VoteType.ABSTAIN;

  // 4. Prepare foreign key IDs based on voter type
  const drepId = voterType === VoterType.DREP ? voterResult.voterId : null;
  const spoId = voterType === VoterType.SPO ? voterResult.voterId : null;
  const ccId = voterType === VoterType.CC ? voterResult.voterId : null;

  // 5. Get voter's voting power for this vote (stored in lovelace as BigInt)
  const voter = await getVoterWithPower(voterType, voterResult.voterId, tx);
  const votingPower = voter?.votingPower ?? null;

  // 6. Fetch vote rationale/metadata JSON (stored as string in DB)
  const rationaleJson = await getVoteRationaleJson(koiosVote);
  let txMetadata:
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | null
    | undefined;
  // Guard tx_metadata calls:
  // 1) proposal must advertise linked survey context, and
  // 2) vote must have a tx hash.
  if (shouldFetchSurveyMetadata && koiosVote.vote_tx_hash) {
    txMetadata = voteTxMetadataCache.get(koiosVote.vote_tx_hash);
    if (txMetadata === undefined) {
      stats.metadata.attempts++;
      try {
        txMetadata = await fetchTxMetadataByHash(koiosVote.vote_tx_hash);
        voteTxMetadataCache.set(koiosVote.vote_tx_hash, txMetadata);
        if (txMetadata) {
          stats.metadata.success++;
        } else {
          // Keep null cached to avoid repeated misses.
          stats.metadata.failed++;
        }
      } catch (error: any) {
        // Keep null cached to avoid repeated failing calls in this run.
        voteTxMetadataCache.set(koiosVote.vote_tx_hash, null);
        stats.metadata.failed++;
        console.warn(
          `[Vote Ingestion] Non-fatal tx_metadata failure proposal=${proposalId} tx=${koiosVote.vote_tx_hash}:`,
          error?.message ?? error
        );
        txMetadata = null;
      }
    }
  } else {
    stats.metadata.skipped++;
  }

  const surveyResponse = txMetadata ? extractSurveyResponse(txMetadata) : null;
  const surveyResponseJson = surveyResponse
    ? JSON.stringify(surveyResponse)
    : undefined;

  // 7. Upsert vote by deterministic ID to avoid an extra read round-trip.
  // This keeps idempotency while handling metadata refreshes for the same tx.
  const voterKey = drepId ?? spoId ?? ccId ?? "unknown";
  const onchainVoteId = `${koiosVote.vote_tx_hash}:${proposalId}:${voterType}:${voterKey}`;
  const voteData = {
    txHash: koiosVote.vote_tx_hash,
    proposalId: proposalId,
    vote: voteType,
    voterType: voterType,
    votingPower: votingPower,
    responseEpoch: koiosVote.epoch_no ?? undefined,
    anchorUrl: koiosVote.meta_url,
    anchorHash: koiosVote.meta_hash,
    rationale: rationaleJson ?? undefined,
    surveyResponse: surveyResponseJson,
    surveyResponseSurveyTxId: surveyResponse?.surveyTxId,
    surveyResponseResponderRole: surveyResponse?.responderRole,
    votedAt: koiosVote.block_time
      ? new Date(koiosVote.block_time * 1000)
      : undefined,
    drepId: drepId,
    spoId: spoId,
    ccId: ccId,
  };

  await tx.onchainVote.upsert({
    where: { id: onchainVoteId },
    create: {
      id: onchainVoteId,
      ...voteData,
    },
    update: voteData,
  });
  stats.votesIngested++;
}

/**
 * Gets voter with their voting power (stored in lovelace as BigInt)
 */
async function getVoterWithPower(
  voterType: VoterType,
  voterId: string,
  tx: Prisma.TransactionClient
): Promise<{ votingPower: bigint } | null> {
  if (voterType === VoterType.DREP) {
    const result = await tx.drep.findUnique({
      where: { drepId: voterId },
      select: { votingPower: true },
    });
    return result ? { votingPower: result.votingPower } : null;
  } else if (voterType === VoterType.SPO) {
    const result = await tx.sPO.findUnique({
      where: { poolId: voterId },
      select: { votingPower: true },
    });
    return result ? { votingPower: result.votingPower } : null;
  }
  // CC members don't have voting power tracked
  return null;
}

/**
 * Ingests a single vote by transaction hash (for POST /data/vote/:tx_hash endpoint)
 *
 * Note: This requires knowing which proposal the vote belongs to
 */
export async function ingestVoteByTxHash(_txHash: string) {
  // TODO: Koios API needs to provide a way to get vote by tx_hash
  // OR we need to pass proposal_hash as well
  // For now, return a placeholder implementation

  return prisma.$transaction(async (_tx) => {
    // This would need to:
    // 1. Fetch vote from Koios by tx_hash
    // 2. Determine which proposal it belongs to
    // 3. Call ingestSingleVote

    throw new Error(
      "ingestVoteByTxHash not yet implemented - need to determine proposal from vote tx_hash"
    );
  });
}
