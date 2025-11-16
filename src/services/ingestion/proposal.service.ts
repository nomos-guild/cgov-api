/**
 * Proposal Ingestion Service
 * Handles syncing proposals from Koios API to database
 */

import { PrismaClient, ProposalStatus, GovernanceType } from "@prisma/client";
import { koiosGet } from "../koios";
import { ingestVotesForProposal, VoteIngestionStats } from "./vote.service";
import { withRetry } from "./utils";
import type { KoiosProposal } from "../../types/koios.types";

const prisma = new PrismaClient();

/**
 * Result of proposal ingestion
 */
export interface ProposalIngestionResult {
  success: boolean;
  proposal: {
    id: number;
    proposalId: string;
    status: ProposalStatus;
  };
  stats: VoteIngestionStats;
}

/**
 * Summary of sync all proposals operation
 */
export interface SyncAllProposalsResult {
  total: number;
  success: number;
  failed: number;
  errors: Array<{ proposalHash: string; error: string }>;
}

/**
 * Ingests a single proposal and all its votes
 * Wrapped with retry logic for transient failures
 *
 * @param proposalHash - Transaction hash of the proposal
 * @returns Result with proposal info and vote statistics
 */
export async function ingestProposal(
  proposalHash: string
): Promise<ProposalIngestionResult> {
  // Wrap entire operation in retry logic
  return withRetry(async () => {
    // Use Prisma transaction to ensure atomicity
    return await prisma.$transaction(async (tx) => {
      // 1. Fetch proposal data from Koios
      const koiosProposals = await koiosGet<KoiosProposal[]>("/proposal_list", {
        _proposal_tx_hash: proposalHash,
      });

      if (!koiosProposals || koiosProposals.length === 0) {
        throw new Error(`Proposal not found in Koios: ${proposalHash}`);
      }

      const koiosProposal = koiosProposals[0];

      // 2. Get current epoch for status calculation
      const currentEpoch = await getCurrentEpoch();

      // 3. Map Koios governance type to Prisma enum
      const governanceActionType = mapGovernanceType(
        koiosProposal.proposal_type
      );

      // 4. Derive status from epoch fields
      const status = deriveProposalStatus(koiosProposal, currentEpoch);

      // 5. Extract metadata (from meta_json or fetch from meta_url)
      const { title, description, rationale, metadata } = await extractProposalMetadata(koiosProposal);

      // 6. Upsert proposal
      const proposal = await tx.proposal.upsert({
        where: { proposalId: koiosProposal.proposal_id },
        create: {
          proposalId: koiosProposal.proposal_id,
          txHash: koiosProposal.proposal_tx_hash,
          certIndex: String(koiosProposal.proposal_index),
          title,
          description,
          rationale,
          governanceActionType,
          status,
          submissionEpoch: koiosProposal.proposed_epoch,
          expiryEpoch: koiosProposal.expired_epoch,
          metadata,
        },
        update: {
          // Only update mutable fields
          status,
          expiryEpoch: koiosProposal.expired_epoch,
          metadata,
        },
      });

      // 5. Ingest all votes for this proposal
      const voteStats = await ingestVotesForProposal(
        proposal.id,
        proposalHash,
        tx
      );

      return {
        success: true,
        proposal: {
          id: proposal.id,
          proposalId: proposal.proposalId,
          status: proposal.status,
        },
        stats: voteStats,
      };
    });
  });
}

/**
 * Syncs all proposals from Koios API
 * Used by cron job to keep database up to date
 *
 * @returns Summary of sync operation
 */
export async function syncAllProposals(): Promise<SyncAllProposalsResult> {
  console.log("[Proposal Sync] Starting sync of all proposals...");

  // 1. Fetch all proposals from Koios
  const allProposals = await koiosGet<KoiosProposal[]>("/proposal_list");

  const results: SyncAllProposalsResult = {
    total: allProposals?.length || 0,
    success: 0,
    failed: 0,
    errors: [],
  };

  if (!allProposals || allProposals.length === 0) {
    console.log("[Proposal Sync] No proposals found in Koios");
    return results;
  }

  console.log(`[Proposal Sync] Found ${results.total} proposals to sync`);

  // 2. Process each proposal sequentially
  for (const koiosProposal of allProposals) {
    try {
      await ingestProposal(koiosProposal.proposal_tx_hash);
      results.success++;
      console.log(
        `[Proposal Sync] ✓ Synced ${koiosProposal.proposal_tx_hash} (${results.success}/${results.total})`
      );
    } catch (error: any) {
      results.failed++;
      results.errors.push({
        proposalHash: koiosProposal.proposal_tx_hash,
        error: error.message,
      });
      console.error(
        `[Proposal Sync] ✗ Failed to sync ${koiosProposal.proposal_tx_hash}:`,
        error.message
      );
      // Continue to next proposal despite failure
    }
  }

  console.log(
    `[Proposal Sync] Completed: ${results.success} succeeded, ${results.failed} failed`
  );

  return results;
}

/**
 * Maps Koios governance action type to Prisma enum
 * TODO: Update this when exact Koios field values are documented
 */
function mapGovernanceType(
  koiosType: string | undefined
): GovernanceType | null {
  if (!koiosType) return null;

  const typeMap: Record<string, GovernanceType> = {
    info: GovernanceType.INFO,
    "info action": GovernanceType.INFO,
    treasury: GovernanceType.TREASURY,
    "treasury withdrawals": GovernanceType.TREASURY,
    constitution: GovernanceType.CONSTITUTION,
    "new constitution": GovernanceType.CONSTITUTION,
    "hard fork": GovernanceType.HARD_FORK,
    "hard fork initiation": GovernanceType.HARD_FORK,
    "protocol parameter change": GovernanceType.PROTOCOL_PARAMETER_CHANGE,
    "parameter change": GovernanceType.PROTOCOL_PARAMETER_CHANGE,
    "no confidence": GovernanceType.NO_CONFIDENCE,
    "update committee": GovernanceType.UPDATE_COMMITTEE,
    "committee update": GovernanceType.UPDATE_COMMITTEE,
  };

  return typeMap[koiosType.toLowerCase()] || null;
}

/**
 * Gets current epoch from Koios API
 */
async function getCurrentEpoch(): Promise<number> {
  const tip = await koiosGet<Array<{ epoch_no: number }>>("/tip");
  return tip?.[0]?.epoch_no || 0;
}

/**
 * Derives proposal status from epoch fields
 * Based on: ratified_epoch, expired_epoch, enacted_epoch, dropped_epoch vs current epoch
 */
function deriveProposalStatus(
  proposal: KoiosProposal,
  currentEpoch: number
): ProposalStatus {
  // If ratified, return RATIFIED
  if (proposal.ratified_epoch && proposal.ratified_epoch <= currentEpoch) {
    return ProposalStatus.RATIFIED;
  }

  // If enacted (approved and executed), return APPROVED
  if (proposal.enacted_epoch && proposal.enacted_epoch <= currentEpoch) {
    return ProposalStatus.APPROVED;
  }

  // If dropped (not approved), return NOT_APPROVED
  if (proposal.dropped_epoch && proposal.dropped_epoch <= currentEpoch) {
    return ProposalStatus.NOT_APPROVED;
  }

  // If expired, return EXPIRED
  if (proposal.expired_epoch && proposal.expired_epoch <= currentEpoch) {
    return ProposalStatus.EXPIRED;
  }

  // Otherwise, still ACTIVE
  return ProposalStatus.ACTIVE;
}

/**
 * Extracts proposal metadata from meta_json or fetches from meta_url
 */
async function extractProposalMetadata(proposal: KoiosProposal): Promise<{
  title: string;
  description: string | null;
  rationale: string | null;
  metadata: string | null;
}> {
  // Try to get from meta_json first
  if (proposal.meta_json?.body) {
    const body = proposal.meta_json.body;
    return {
      title: body.title || "Untitled Proposal",
      description: body.abstract || null,
      rationale: body.rationale || null,
      metadata: JSON.stringify(proposal.meta_json),
    };
  }

  // Fallback to fetching from meta_url
  if (proposal.meta_url) {
    try {
      const axios = (await import("axios")).default;
      const response = await axios.get(proposal.meta_url, { timeout: 10000 });
      const metaData = response.data;

      return {
        title: metaData?.body?.title || "Untitled Proposal",
        description: metaData?.body?.abstract || null,
        rationale: metaData?.body?.rationale || null,
        metadata: JSON.stringify(metaData),
      };
    } catch (error) {
      console.error(`Failed to fetch meta_url: ${proposal.meta_url}`, error);
    }
  }

  // If no metadata available
  return {
    title: "Untitled Proposal",
    description: null,
    rationale: null,
    metadata: null,
  };
}