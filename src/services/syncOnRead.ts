/**
 * Sync-on-Read Service
 *
 * Provides on-demand syncing of proposals and votes from Koios API.
 * This enables near-real-time updates when users access proposal data,
 * so that new votes are reflected within seconds of being submitted on-chain.
 *
 * IMPORTANT: All sync functions run in the BACKGROUND (non-blocking) to ensure
 * fast API response times. The page loads instantly with existing data, and
 * new data will be available on the next request after the background sync completes.
 *
 * Throttling/cooldowns are implemented to avoid overwhelming Koios API:
 * - Overview sync: 60 second cooldown
 * - Per-proposal sync: 30 second cooldown per proposal
 */

import {
  PrismaClient,
  proposal_status,
} from "@prisma/client";
import { koiosGet } from "./koios";
import {
  ingestProposalData,
  getCurrentEpoch,
} from "./ingestion/proposal.service";
import type {
  KoiosProposal,
  KoiosProposalVotingSummary,
} from "../types/koios.types";

const prisma = new PrismaClient();

// Cooldown periods (in milliseconds)
const OVERVIEW_SYNC_COOLDOWN_MS = 1_000; // 1 second
const PROPOSAL_SYNC_COOLDOWN_MS = 1_000; // 1 second per proposal

// Last sync timestamps
let lastOverviewSyncTime = 0;
const proposalSyncTimes = new Map<string, number>();

// Track proposals currently being synced to prevent concurrent syncs
let isOverviewSyncInProgress = false;
const proposalSyncsInProgress = new Set<string>();

/**
 * Syncs the proposals overview on read (BACKGROUND/NON-BLOCKING).
 * Called before returning the proposals list to trigger a background sync.
 *
 * This function returns immediately and runs the sync in the background,
 * so the API response is not delayed.
 *
 * This function:
 * 1. Checks if cooldown has elapsed since last sync
 * 2. If not in cooldown, triggers background sync
 * 3. Background sync compares Koios proposal count with DB count
 * 4. If there are new proposals, ingests them in the background
 */
export function syncProposalsOverviewOnRead(): void {
  const now = Date.now();

  // Check if sync is already in progress
  if (isOverviewSyncInProgress) {
    return;
  }

  // Check cooldown
  if (now - lastOverviewSyncTime < OVERVIEW_SYNC_COOLDOWN_MS) {
    // Skip silently during cooldown to reduce log noise
    return;
  }

  lastOverviewSyncTime = now;
  isOverviewSyncInProgress = true;

  // Run sync in background (non-blocking) - don't await
  doOverviewSync()
    .catch((error) => {
      console.error(
        "[Sync-on-Read] Background overview sync failed:",
        error.message
      );
    })
    .finally(() => {
      isOverviewSyncInProgress = false;
    });
}

/**
 * Internal function that performs the actual overview sync
 */
async function doOverviewSync(): Promise<void> {
  console.log("[Sync-on-Read] Starting background overview sync...");

  // Get counts from DB and Koios in parallel
  const [dbCount, koiosProposals] = await Promise.all([
    prisma.proposal.count(),
    koiosGet<KoiosProposal[]>("/proposal_list"),
  ]);

  if (!koiosProposals || koiosProposals.length === 0) {
    console.log("[Sync-on-Read] No proposals from Koios");
    return;
  }

  const koiosCount = koiosProposals.length;
  console.log(
    `[Sync-on-Read] DB has ${dbCount} proposals, Koios has ${koiosCount}`
  );

  // If Koios has more proposals, find and ingest the new ones
  if (koiosCount > dbCount) {
    // Get existing proposal IDs from DB
    const existingProposals = await prisma.proposal.findMany({
      select: { proposal_id: true },
    });
    const existingIds = new Set(existingProposals.map((p) => p.proposal_id));

    // Find new proposals from Koios
    const newProposals = koiosProposals.filter(
      (p) => !existingIds.has(p.proposal_id)
    );

    console.log(
      `[Sync-on-Read] Found ${newProposals.length} new proposals to ingest`
    );

    // Get current epoch once for all new proposals
    const currentEpoch = await getCurrentEpoch();

    // Ingest new proposals (without using global vote cache)
    for (const proposal of newProposals) {
      try {
        await ingestProposalData(proposal, {
          currentEpoch,
          minVotesEpoch: proposal.proposed_epoch,
          useCache: false, // Don't use global cache for on-demand sync
        });
        console.log(
          `[Sync-on-Read] ✓ Ingested new proposal ${proposal.proposal_tx_hash}`
        );
      } catch (error: any) {
        console.error(
          `[Sync-on-Read] ✗ Failed to ingest proposal ${proposal.proposal_tx_hash}:`,
          error.message
        );
      }
    }
  } else {
    console.log("[Sync-on-Read] No new proposals to sync");
  }
}

/**
 * Syncs a specific proposal's details on read (BACKGROUND/NON-BLOCKING).
 * Called before returning proposal details to trigger a background sync.
 *
 * This function returns immediately and runs the sync in the background,
 * so the API response is not delayed.
 *
 * This function:
 * 1. Checks if cooldown has elapsed for this proposal
 * 2. If not in cooldown, triggers background sync
 * 3. Background sync fetches latest voting summary from Koios
 * 4. Compares vote counts - if different, re-ingests the proposal
 *
 * @param identifier - Proposal identifier (proposalId, txHash, txHash:certIndex, or numeric id)
 */
export function syncProposalDetailsOnRead(identifier: string): void {
  const now = Date.now();

  // Check if sync is already in progress for this proposal
  if (proposalSyncsInProgress.has(identifier)) {
    return;
  }

  // Check cooldown for this specific proposal
  const lastSyncTime = proposalSyncTimes.get(identifier) || 0;
  if (now - lastSyncTime < PROPOSAL_SYNC_COOLDOWN_MS) {
    // Skip silently during cooldown to reduce log noise
    return;
  }

  proposalSyncTimes.set(identifier, now);
  proposalSyncsInProgress.add(identifier);

  // Run sync in background (non-blocking) - don't await
  doProposalSync(identifier)
    .catch((error) => {
      console.error(
        `[Sync-on-Read] Background sync failed for ${identifier}:`,
        error.message
      );
    })
    .finally(() => {
      proposalSyncsInProgress.delete(identifier);
    });
}

/**
 * Internal function that performs the actual proposal sync
 */
async function doProposalSync(identifier: string): Promise<void> {
  console.log(
    `[Sync-on-Read] Starting background sync for proposal ${identifier}...`
  );

  // First, look up the proposal in our DB to get its proposalId
  const dbProposal = await findProposalByIdentifier(identifier);

  if (!dbProposal) {
    // Proposal doesn't exist in DB - might be a new proposal
    // Try to fetch from Koios and ingest if found
    console.log(
      `[Sync-on-Read] Proposal ${identifier} not in DB, checking Koios...`
    );
    await tryIngestNewProposal(identifier);
    return;
  }

  // Only sync if proposal is still ACTIVE (voting ongoing)
  if (dbProposal.status !== proposal_status.ACTIVE) {
    console.log(
      `[Sync-on-Read] Proposal ${identifier} is ${dbProposal.status}, skipping sync`
    );
    return;
  }

  // Fetch votes from Koios for this proposal to compare count
  // This catches cases where a voter changes their vote back to the same choice
  // (e.g., Yes -> Abstain -> Yes), which wouldn't change voting power totals
  const koiosVotes = await fetchVotesForProposal(dbProposal.proposal_id);
  const koiosVoteCount = koiosVotes.length;

  // Get vote count from DB
  const dbVoteCount = await prisma.onchain_vote.count({
    where: { proposal_id: dbProposal.proposal_id },
  });

  console.log(
    `[Sync-on-Read] Vote count - DB: ${dbVoteCount}, Koios: ${koiosVoteCount}`
  );

  // If vote counts differ, we have new vote transactions to sync
  const hasVoteCountChange = koiosVoteCount !== dbVoteCount;

  // Also check voting power totals for additional safety
  const koiosSummary = await koiosGet<KoiosProposalVotingSummary[]>(
    `/proposal_voting_summary?_proposal_id=${dbProposal.proposal_id}`
  );

  let hasVotingPowerChange = false;
  if (koiosSummary && koiosSummary.length > 0) {
    const summary = koiosSummary[0];

    const koiosDrepYes = BigInt(summary.drep_active_yes_vote_power || "0");
    const koiosDrepNo = BigInt(summary.drep_active_no_vote_power || "0");
    const koiosDrepAbstain = BigInt(
      summary.drep_active_abstain_vote_power || "0"
    );
    const koiosSpoYes = BigInt(summary.pool_active_yes_vote_power || "0");
    const koiosSpoNo = BigInt(summary.pool_active_no_vote_power || "0");
    const koiosSpoAbstain = BigInt(
      summary.pool_active_abstain_vote_power || "0"
    );

    const dbDrepYes = dbProposal.drep_active_yes_vote_power || BigInt(0);
    const dbDrepNo = dbProposal.drep_active_no_vote_power || BigInt(0);
    const dbDrepAbstain =
      dbProposal.drep_active_abstain_vote_power || BigInt(0);
    const dbSpoYes = dbProposal.spo_active_yes_vote_power || BigInt(0);
    const dbSpoNo = dbProposal.spo_active_no_vote_power || BigInt(0);
    const dbSpoAbstain =
      dbProposal.spo_active_abstain_vote_power || BigInt(0);

    const hasDrepChanges =
      koiosDrepYes !== dbDrepYes ||
      koiosDrepNo !== dbDrepNo ||
      koiosDrepAbstain !== dbDrepAbstain;
    const hasSpoChanges =
      koiosSpoYes !== dbSpoYes ||
      koiosSpoNo !== dbSpoNo ||
      koiosSpoAbstain !== dbSpoAbstain;

    hasVotingPowerChange = hasDrepChanges || hasSpoChanges;

    if (hasVotingPowerChange) {
      console.log(
        `[Sync-on-Read] Voting power differences detected for ${dbProposal.proposal_id}`
      );
    }
  }

  // Sync if either vote count or voting power differs
  if (hasVoteCountChange || hasVotingPowerChange) {
    console.log(
      `[Sync-on-Read] Changes detected for ${dbProposal.proposal_id}:` +
        ` voteCount=${hasVoteCountChange}, votingPower=${hasVotingPowerChange}`
    );

    // Re-ingest the proposal to get updated votes
    const koiosProposals = await koiosGet<KoiosProposal[]>("/proposal_list");
    const koiosProposal = koiosProposals?.find(
      (p) => p.proposal_id === dbProposal.proposal_id
    );

    if (koiosProposal) {
      await ingestProposalData(koiosProposal, {
        minVotesEpoch: koiosProposal.proposed_epoch,
        useCache: false, // Don't use global cache for on-demand sync
      });
      console.log(
        `[Sync-on-Read] ✓ Re-synced proposal ${dbProposal.proposal_id}`
      );
    }
  } else {
    console.log(`[Sync-on-Read] No changes for ${dbProposal.proposal_id}`);
  }
}

/**
 * Fetches all votes for a specific proposal from Koios
 * Used for vote count comparison
 */
async function fetchVotesForProposal(
  proposalId: string
): Promise<Array<{ vote_tx_hash: string }>> {
  const votes: Array<{ vote_tx_hash: string }> = [];
  let offset = 0;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const batch = await koiosGet<Array<{ vote_tx_hash: string }>>(
      `/vote_list?proposal_id=eq.${proposalId}&limit=${limit}&offset=${offset}`
    );

    if (!batch || batch.length === 0) {
      hasMore = false;
    } else {
      votes.push(...batch);
      offset += batch.length;
      if (batch.length < limit) {
        hasMore = false;
      }
    }
  }

  return votes;
}

/**
 * Helper to find a proposal by various identifier formats
 */
async function findProposalByIdentifier(identifier: string) {
  const trimmed = identifier.trim();

  // Try proposalId (starts with "gov_action")
  if (trimmed.startsWith("gov_action")) {
    return prisma.proposal.findUnique({
      where: { proposal_id: trimmed },
      select: {
        proposal_id: true,
        status: true,
        drep_active_yes_vote_power: true,
        drep_active_no_vote_power: true,
        drep_active_abstain_vote_power: true,
        spo_active_yes_vote_power: true,
        spo_active_no_vote_power: true,
        spo_active_abstain_vote_power: true,
      },
    });
  }

  // Try numeric id
  const numericId = Number(trimmed);
  if (!Number.isNaN(numericId)) {
    const proposal = await prisma.proposal.findUnique({
      where: { id: numericId },
      select: {
        proposal_id: true,
        status: true,
        drep_active_yes_vote_power: true,
        drep_active_no_vote_power: true,
        drep_active_abstain_vote_power: true,
        spo_active_yes_vote_power: true,
        spo_active_no_vote_power: true,
        spo_active_abstain_vote_power: true,
      },
    });
    if (proposal) return proposal;
  }

  // Try txHash:certIndex or plain txHash
  if (trimmed.includes(":")) {
    const [txHash, certIndex] = trimmed.split(":");
    return prisma.proposal.findFirst({
      where: { tx_hash: txHash, cert_index: certIndex },
      select: {
        proposal_id: true,
        status: true,
        drep_active_yes_vote_power: true,
        drep_active_no_vote_power: true,
        drep_active_abstain_vote_power: true,
        spo_active_yes_vote_power: true,
        spo_active_no_vote_power: true,
        spo_active_abstain_vote_power: true,
      },
    });
  }

  // Plain txHash
  return prisma.proposal.findFirst({
    where: { tx_hash: trimmed },
    select: {
      proposal_id: true,
      status: true,
      drep_active_yes_vote_power: true,
      drep_active_no_vote_power: true,
      drep_active_abstain_vote_power: true,
      spo_active_yes_vote_power: true,
      spo_active_no_vote_power: true,
      spo_active_abstain_vote_power: true,
    },
  });
}

/**
 * Helper to try ingesting a new proposal by txHash
 */
async function tryIngestNewProposal(identifier: string): Promise<void> {
  try {
    // Fetch all proposals from Koios and look for a match
    const koiosProposals = await koiosGet<KoiosProposal[]>("/proposal_list");
    if (!koiosProposals) return;

    const trimmed = identifier.trim();
    let koiosProposal: KoiosProposal | undefined;

    // Try to find by proposalId
    if (trimmed.startsWith("gov_action")) {
      koiosProposal = koiosProposals.find((p) => p.proposal_id === trimmed);
    } else if (trimmed.includes(":")) {
      // txHash:certIndex format
      const [txHash, certIndex] = trimmed.split(":");
      koiosProposal = koiosProposals.find(
        (p) =>
          p.proposal_tx_hash === txHash &&
          String(p.proposal_index) === certIndex
      );
    } else {
      // Plain txHash
      koiosProposal = koiosProposals.find(
        (p) => p.proposal_tx_hash === trimmed
      );
    }

    if (koiosProposal) {
      await ingestProposalData(koiosProposal, {
        minVotesEpoch: koiosProposal.proposed_epoch,
        useCache: false,
      });
      console.log(
        `[Sync-on-Read] ✓ Ingested new proposal ${koiosProposal.proposal_tx_hash}`
      );
    } else {
      console.log(`[Sync-on-Read] Proposal ${identifier} not found in Koios`);
    }
  } catch (error: any) {
    console.error(
      `[Sync-on-Read] Failed to ingest new proposal ${identifier}:`,
      error.message
    );
  }
}
