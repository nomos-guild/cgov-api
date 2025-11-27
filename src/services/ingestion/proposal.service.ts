/**
 * Proposal Ingestion Service
 * Handles syncing proposals from Koios API to database
 */

import { PrismaClient, ProposalStatus, GovernanceType } from "@prisma/client";
import { koiosGet } from "../koios";
import { ingestVotesForProposal, VoteIngestionStats, clearVoteCache } from "./vote.service";
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
 * Internal function to ingest proposal data
 * Wrapped with retry logic for transient failures.
 *
 * Note: We intentionally avoid a long-running interactive transaction here.
 * The proposal row is upserted in a single DB operation, and votes/voters are
 * ingested in smaller operations so that partial progress is preserved and
 * retries can safely resume without starting from scratch.
 *
 * @param koiosProposal - Proposal data from Koios API
 * @returns Result with proposal info and vote statistics
 */
async function ingestProposalData(
  koiosProposal: KoiosProposal
): Promise<ProposalIngestionResult> {
  // Wrap entire operation in retry logic
  return withRetry(async () => {
    // 1. Get current epoch for status calculation
    const currentEpoch = await getCurrentEpoch();

    // 2. Map Koios governance type to Prisma enum
    const governanceActionType = mapGovernanceType(
      koiosProposal.proposal_type
    );

    // If Koios sends a proposal_type we don't recognize, log it for debugging
    if (koiosProposal.proposal_type && !governanceActionType) {
      console.warn(
        "[Proposal Ingest] Unmapped proposal_type from Koios:",
        koiosProposal.proposal_type
      );
    }

    // 3. Derive status from epoch fields
    const status = deriveProposalStatus(koiosProposal, currentEpoch);

    // 4. Extract metadata (from meta_json or fetch from meta_url)
    const { title, description, rationale, metadata } =
      await extractProposalMetadata(koiosProposal);

    // 5. Check if proposal exists to determine if creating or updating
    const existingProposal = await prisma.proposal.findUnique({
      where: { proposalId: koiosProposal.proposal_id },
    });

    const isUpdate = !!existingProposal;

    // 6. Upsert proposal (single atomic DB operation, no long transaction)
    const proposal = await prisma.proposal.upsert({
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
        // Backfill governanceActionType when we have a valid mapping
        ...(governanceActionType !== null && { governanceActionType }),
        expiryEpoch: koiosProposal.expired_epoch,
        metadata,
      },
    });

    console.log(
      `[Proposal Ingest] ${isUpdate ? "Updated" : "Created"} proposal - ` +
        `DB ID: ${proposal.id}, proposalId: ${proposal.proposalId}, ` +
        `type: ${governanceActionType || "null"}, koios_type: "${
          koiosProposal.proposal_type
        }"`
    );

    // 7. Ingest all votes for this proposal using the root Prisma client.
    // This runs outside of a long-lived transaction so that:
    // - Individual vote/voter inserts can commit as they go.
    // - If we hit a timeout or other error part-way through, a retry will
    //   see existing rows and continue without duplicating work.
    const voteStats = await ingestVotesForProposal(
      proposal.id,
      koiosProposal.proposal_id,
      prisma
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
}

/**
 * Ingests a single proposal by transaction hash
 * Fetches proposal data from Koios API and processes it
 *
 * @param proposalHash - Transaction hash of the proposal
 * @returns Result with proposal info and vote statistics
 */
export async function ingestProposal(
  proposalHash: string
): Promise<ProposalIngestionResult> {
  // 1. Fetch ALL proposals from Koios (API doesn't support filtering)
  const allProposals = await koiosGet<KoiosProposal[]>("/proposal_list");

  // 2. Filter in memory to find the specific proposal
  const koiosProposal = allProposals?.find(
    (p) => p.proposal_tx_hash === proposalHash
  );

  if (!koiosProposal) {
    throw new Error(`Proposal not found in Koios: ${proposalHash}`);
  }

  // 3. Ingest the proposal data
  return ingestProposalData(koiosProposal);
}

/**
 * Syncs all proposals from Koios API
 * Used by cron job to keep database up to date
 *
 * @returns Summary of sync operation
 */
export async function syncAllProposals(): Promise<SyncAllProposalsResult> {
  console.log("[Proposal Sync] Starting sync of all proposals...");

  // Clear vote cache to ensure fresh data
  clearVoteCache();

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

  // 2. Sort proposals by submission epoch (oldest first) for consistent DB ordering
  const sortedProposals = allProposals.sort((a, b) => {
    const epochA = a.proposed_epoch || 0;
    const epochB = b.proposed_epoch || 0;
    return epochA - epochB;
  });

  console.log(`[Proposal Sync] Processing proposals from epoch ${sortedProposals[0]?.proposed_epoch} to ${sortedProposals[sortedProposals.length - 1]?.proposed_epoch}`);

  // 3. Process each proposal sequentially
  for (const koiosProposal of sortedProposals) {
    try {
      await ingestProposalData(koiosProposal);
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
 * Koios returns PascalCase values like "TreasuryWithdrawals", "InfoAction", etc.
 */
function mapGovernanceType(
  koiosType: string | undefined
): GovernanceType | null {
  if (!koiosType) return null;

  // Koios uses PascalCase for proposal_type
  const typeMap: Record<string, GovernanceType> = {
    ParameterChange: GovernanceType.PROTOCOL_PARAMETER_CHANGE,
    HardForkInitiation: GovernanceType.HARD_FORK,
    TreasuryWithdrawals: GovernanceType.TREASURY,
    NoConfidence: GovernanceType.NO_CONFIDENCE,
    NewCommittee: GovernanceType.UPDATE_COMMITTEE,
    NewConstitution: GovernanceType.CONSTITUTION,
    InfoAction: GovernanceType.INFO
  };

  return typeMap[koiosType] || null;
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
      // Convert IPFS URLs to use an HTTP gateway
      let fetchUrl = proposal.meta_url;
      if (proposal.meta_url.startsWith('ipfs://')) {
        const ipfsHash = proposal.meta_url.replace('ipfs://', '');
        fetchUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
        console.log(`[Metadata] Converting IPFS URL to gateway: ${fetchUrl}`);
      }

      const axios = (await import("axios")).default;
      const response = await axios.get(fetchUrl, { timeout: 10000 });
      const metaData = response.data;

      return {
        title: metaData?.body?.title || "Untitled Proposal",
        description: metaData?.body?.abstract || null,
        rationale: metaData?.body?.rationale || null,
        metadata: JSON.stringify(metaData),
      };
    } catch (error: any) {
      const status = error.response?.status;
      const errorMsg = status === 404
        ? `Metadata URL not found (404): ${proposal.meta_url}`
        : `Failed to fetch metadata from ${proposal.meta_url}`;

      console.warn(`[Metadata] ${errorMsg}`);
      // Continue with default values instead of failing
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