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
 * @param currentEpochOverride - Optional current epoch to reuse across calls
 * @param minVotesEpochOverride - Optional minimum epoch to fetch votes from
 * @returns Result with proposal info and vote statistics
 */
async function ingestProposalData(
  koiosProposal: KoiosProposal,
  currentEpochOverride?: number,
  minVotesEpochOverride?: number
): Promise<ProposalIngestionResult> {
  // Wrap entire operation in retry logic
  return withRetry(async () => {
    // 1. Get current epoch for status calculation
    //    Allow caller to provide it so we don't call Koios /tip for every proposal
    const currentEpoch =
      typeof currentEpochOverride === "number"
        ? currentEpochOverride
        : await getCurrentEpoch();

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
        `proposalId: ${proposal.proposalId}, ` +
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
      proposal.proposalId,
      prisma,
      minVotesEpochOverride
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

  // 3. Ingest the proposal data (let it fetch current epoch itself) and
  //    only fetch votes from this proposal's submission epoch onward.
  return ingestProposalData(koiosProposal, undefined, koiosProposal.proposed_epoch);
}

/**
 * Syncs proposals from Koios API
 * Used by cron job to keep database up to date.
 *
 * Behavior:
 * - On first run (empty DB): ingests all proposals from Koios.
 * - On subsequent runs: only processes
 *   - proposals that do not yet exist in the DB, and
 *   - proposals that are currently ACTIVE in the DB (to keep their status/votes up to date).
 *
 * This significantly reduces Koios load while still converging the DB state.
 *
 * @returns Summary of sync operation for proposals that were actually processed.
 */
export async function syncAllProposals(): Promise<SyncAllProposalsResult> {
  console.log("[Proposal Sync] Starting sync of all proposals...");

  // Clear vote cache to ensure fresh data
  clearVoteCache();

  // 1. Snapshot existing proposals from DB (IDs + status)
  const existingProposals = await prisma.proposal.findMany({
    select: { proposalId: true, status: true },
  });

  const existingIds = new Set(existingProposals.map((p) => p.proposalId));
  const activeIdsInDb = new Set(
    existingProposals
      .filter((p) => p.status === ProposalStatus.ACTIVE)
      .map((p) => p.proposalId)
  );

  // 2. Fetch all proposals from Koios (API does not support server-side filtering)
  const allProposals = await koiosGet<KoiosProposal[]>("/proposal_list");

  if (!allProposals || allProposals.length === 0) {
    console.log("[Proposal Sync] No proposals found in Koios");
    return {
      total: 0,
      success: 0,
      failed: 0,
      errors: [],
    };
  }

  // 3. Decide which proposals to (re)ingest:
  //    - Any proposal missing from DB
  //    - Any proposal that is ACTIVE in the DB (so its status/votes stay fresh)
  const proposalsToProcess = allProposals.filter((p) => {
    const proposalId = p.proposal_id;
    if (!existingIds.has(proposalId)) {
      return true; // New proposal
    }
    if (activeIdsInDb.has(proposalId)) {
      return true; // Still active in DB, keep it updated
    }
    return false; // Historical proposal that can remain as-is
  });

  const results: SyncAllProposalsResult = {
    // "total" now reflects how many proposals we are actually processing this run
    total: proposalsToProcess.length,
    success: 0,
    failed: 0,
    errors: [],
  };

  if (results.total === 0) {
    console.log(
      "[Proposal Sync] No new or active proposals to sync - database is up to date for historical proposals"
    );
    return results;
  }

  console.log(
    `[Proposal Sync] Found ${results.total} proposals to sync (new or currently ACTIVE in DB)`
  );

  // 4. Sort proposals by submission epoch (oldest first) for consistent DB ordering
  const sortedProposals = proposalsToProcess.sort((a, b) => {
    const epochA = a.proposed_epoch || 0;
    const epochB = b.proposed_epoch || 0;
    return epochA - epochB;
  });

  console.log(
    `[Proposal Sync] Processing proposals from epoch ${sortedProposals[0]?.proposed_epoch} to ${
      sortedProposals[sortedProposals.length - 1]?.proposed_epoch
    }`
  );

  // Determine the earliest proposal submission epoch among the proposals
  // we are actually processing. Votes for these proposals cannot exist
  // before this epoch, so we can safely avoid fetching older votes.
  const earliestProposalEpoch = sortedProposals[0]?.proposed_epoch;
  const minVotesEpoch =
    typeof earliestProposalEpoch === "number" ? earliestProposalEpoch : undefined;

  // 5. Get current epoch once for the whole run and reuse it
  const currentEpoch = await getCurrentEpoch();

  // 6. Process each proposal sequentially
  for (const koiosProposal of sortedProposals) {
    try {
      await ingestProposalData(koiosProposal, currentEpoch, minVotesEpoch);
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