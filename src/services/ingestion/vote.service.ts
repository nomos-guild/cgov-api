/**
 * Vote Ingestion Service
 * Handles ingestion of onchain votes for proposals
 */

import { PrismaClient, VoteType, VoterType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { koiosGet } from "../koios";
import { ensureVoterExists } from "./voter.service";
import type { KoiosVote } from "../../types/koios.types";

const prisma = new PrismaClient();

// Cache all votes at module level to avoid fetching multiple times during sync
let cachedVotes: KoiosVote[] | null = null;

/**
 * Statistics for vote ingestion
 */
export interface VoteIngestionStats {
  votesIngested: number;
  votesUpdated: number;
  votersCreated: { dreps: number; spos: number; ccs: number };
  votersUpdated: { dreps: number; spos: number; ccs: number };
}

/**
 * Clears the vote cache - should be called at the start of each sync
 */
export function clearVoteCache() {
  cachedVotes = null;
}

/**
 * Ingests all votes for a specific proposal
 *
 * @param proposalId - Cardano governance action ID (proposal_id from Koios)
 * @param tx - Prisma transaction client
 * @param minEpoch - Optional minimum epoch to fetch votes from (inclusive).
 *                   Used to avoid fetching historical votes that cannot belong
 *                   to the proposals we are currently syncing.
 * @returns Statistics about votes and voters created/updated
 */
export async function ingestVotesForProposal(
  proposalId: string,
  tx: Prisma.TransactionClient,
  minEpoch?: number
): Promise<VoteIngestionStats> {
  const stats: VoteIngestionStats = {
    votesIngested: 0,
    votesUpdated: 0,
    votersCreated: { dreps: 0, spos: 0, ccs: 0 },
    votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
  };

  try {
    // Fetch votes from Koios with pagination (use cache if available)
    if (!cachedVotes) {
      let allVotes: KoiosVote[] = [];
      let offset = 0;
      const limit = 1000; // Max limit per request
      let hasMore = true;

      console.log(
        `[Vote Ingestion] Fetching votes with pagination${
          typeof minEpoch === "number" ? ` from epoch >= ${minEpoch}` : ""
        }...`
      );

      while (hasMore) {
        // Koios exposes horizontal filtering via query params (PostgREST style).
        // We rely on an `epoch_no` column being available on /vote_list so that
        // we can avoid fetching votes from epochs that are strictly before the
        // earliest proposal epoch we care about in this sync run.
        const params: any = {
          limit,
          offset,
        };

        if (typeof minEpoch === "number") {
          // Fetch only votes where epoch_no >= minEpoch
          // Example: /vote_list?epoch_no=gte.597&limit=1000&offset=0
          params.epoch_no = `gte.${minEpoch}`;
        }

        const batch = await koiosGet<KoiosVote[]>("/vote_list", params);

        if (!batch || batch.length === 0) {
          hasMore = false;
        } else {
          allVotes = allVotes.concat(batch);
          offset += batch.length;
          console.log(`[Vote Ingestion]   Fetched ${allVotes.length} votes so far...`);

          if (batch.length < limit) {
            // Last batch was smaller than limit, no more pages
            hasMore = false;
          }
        }
      }

      cachedVotes = allVotes;
      console.log(`[Vote Ingestion] ✓ Fetched ${cachedVotes.length} total votes from Koios`);
    }

    // Filter in memory to find votes for this specific proposal
    const koiosVotes = cachedVotes.filter((vote) => vote.proposal_id === proposalId);

    if (koiosVotes.length === 0) {
      console.log(`[Vote Ingestion] No votes found for proposal ${proposalId}`);
      return stats;
    }

    console.log(`[Vote Ingestion] Found ${koiosVotes.length} votes for proposal ${proposalId}`);

    // Process each vote
    for (const koiosVote of koiosVotes) {
      await ingestSingleVote(koiosVote, proposalId, tx, stats);
    }
  } catch (error: any) {
    // If fetching all votes fails, log and return empty stats
    console.error(`[Vote Ingestion] Failed to fetch votes:`, error.message);
    return stats;
  }

  return stats;
}

/**
 * Ingests a single vote
 */
async function ingestSingleVote(
  koiosVote: KoiosVote,
  proposalId: string,
  tx: Prisma.TransactionClient,
  stats: VoteIngestionStats
): Promise<void> {
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
        data: { memberName },
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

  // 5. Get voter's voting power for this vote
  const voter = await getVoterWithPower(voterType, voterResult.voterId, tx);
  const votingPowerAda = voter?.votingPower || null;
  const votingPower = votingPowerAda ? String(Math.round(votingPowerAda * 1_000_000)) : null;

  // 6. Check if vote exists using findFirst (works with nullable fields)
  const existingVote = await tx.onchainVote.findFirst({
    where: {
      proposalId,
      voterType,
      drepId,
      spoId,
      ccId,
    },
  });

  if (existingVote) {
    // Update existing vote
    await tx.onchainVote.update({
      where: { id: existingVote.id },
      data: {
        vote: voteType,
        votingPower,
        votingPowerAda,
        anchorUrl: koiosVote.meta_url,
        anchorHash: koiosVote.meta_hash,
      },
    });
    stats.votesUpdated++;
  } else {
    // Create new vote
    await tx.onchainVote.create({
      data: {
        txHash: koiosVote.vote_tx_hash,
        proposalId,
        vote: voteType,
        voterType,
        votingPower,
        votingPowerAda,
        anchorUrl: koiosVote.meta_url,
        anchorHash: koiosVote.meta_hash,
        votedAt: koiosVote.block_time
          ? new Date(koiosVote.block_time * 1000) // Convert Unix timestamp to Date
          : undefined,
        drepId,
        spoId,
        ccId,
      },
    });
    stats.votesIngested++;
  }
}

/**
 * Gets voter with their voting power
 */
async function getVoterWithPower(
  voterType: VoterType,
  voterId: string,
  tx: Prisma.TransactionClient
): Promise<{ votingPower: number } | null> {
  if (voterType === VoterType.DREP) {
    return await tx.drep.findUnique({ where: { drepId: voterId }, select: { votingPower: true } });
  } else if (voterType === VoterType.SPO) {
    return await tx.sPO.findUnique({ where: { poolId: voterId }, select: { votingPower: true } });
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