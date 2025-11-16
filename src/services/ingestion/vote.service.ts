/**
 * Vote Ingestion Service
 * Handles ingestion of onchain votes for proposals
 */

import { PrismaClient, VoteType, VoterType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { koiosGet } from "../koios";
import { ensureVoterExists } from "./voter.service";
import { lovelaceToAda } from "./utils";
import type { KoiosVote } from "../../types/koios.types";

const prisma = new PrismaClient();

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
 * Ingests all votes for a specific proposal
 *
 * @param proposalDbId - Database ID of the proposal
 * @param proposalHash - Transaction hash of the proposal
 * @param tx - Prisma transaction client
 * @returns Statistics about votes and voters created/updated
 */
export async function ingestVotesForProposal(
  proposalDbId: number,
  proposalId: string,
  tx: Prisma.TransactionClient
): Promise<VoteIngestionStats> {
  // Fetch all votes for this proposal from Koios using proposal_id
  const koiosVotes = await koiosGet<KoiosVote[]>("/vote_list", {
    _proposal_id: proposalId,
  });

  const stats: VoteIngestionStats = {
    votesIngested: 0,
    votesUpdated: 0,
    votersCreated: { dreps: 0, spos: 0, ccs: 0 },
    votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
  };

  if (!koiosVotes || koiosVotes.length === 0) {
    return stats;
  }

  // Process each vote
  for (const koiosVote of koiosVotes) {
    await ingestSingleVote(koiosVote, proposalDbId, tx, stats);
  }

  return stats;
}

/**
 * Ingests a single vote
 */
async function ingestSingleVote(
  koiosVote: KoiosVote,
  proposalDbId: number,
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

  // 5. Check if vote already exists
  const existingVote = await tx.onchainVote.findUnique({
    where: {
      proposalId_voterType_drepId_spoId_ccId: {
        proposalId: proposalDbId,
        voterType,
        drepId,
        spoId,
        ccId,
      },
    },
  });

  // 6. Upsert the vote
  await tx.onchainVote.upsert({
    where: {
      proposalId_voterType_drepId_spoId_ccId: {
        proposalId: proposalDbId,
        voterType,
        drepId,
        spoId,
        ccId,
      },
    },
    create: {
      txHash: koiosVote.vote_tx_hash,
      proposalId: proposalDbId,
      vote: voteType,
      voterType,
      votingPower: koiosVote.meta_url,  // Note: voting power comes from voting_power_history API
      votingPowerAda: null, // Will be fetched from voting power history
      anchorUrl: koiosVote.meta_url,
      anchorHash: koiosVote.meta_hash,
      votedAt: koiosVote.block_time
        ? new Date(koiosVote.block_time * 1000) // Convert Unix timestamp to Date
        : undefined,
      drepId,
      spoId,
      ccId,
    },
    update: {
      // Update vote type in case it changed
      vote: voteType,
      anchorUrl: koiosVote.meta_url,
      anchorHash: koiosVote.meta_hash,
    },
  });

  // Update stats
  existingVote ? stats.votesUpdated++ : stats.votesIngested++;
}

/**
 * Ingests a single vote by transaction hash (for POST /data/vote/:tx_hash endpoint)
 *
 * Note: This requires knowing which proposal the vote belongs to
 */
export async function ingestVoteByTxHash(txHash: string) {
  // TODO: Koios API needs to provide a way to get vote by tx_hash
  // OR we need to pass proposal_hash as well
  // For now, return a placeholder implementation

  return prisma.$transaction(async (tx) => {
    // This would need to:
    // 1. Fetch vote from Koios by tx_hash
    // 2. Determine which proposal it belongs to
    // 3. Call ingestSingleVote

    throw new Error(
      "ingestVoteByTxHash not yet implemented - need to determine proposal from vote tx_hash"
    );
  });
}