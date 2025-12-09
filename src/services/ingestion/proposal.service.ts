/**
 * Proposal Ingestion Service
 * Handles syncing proposals from Koios API to database
 */

import { PrismaClient, ProposalStatus, GovernanceType } from "@prisma/client";
import { koiosGet } from "../koios";
import {
  ingestVotesForProposal,
  VoteIngestionStats,
  clearVoteCache,
} from "./vote.service";
import { withRetry } from "./utils";
import type {
  KoiosProposal,
  KoiosProposalVotingSummary,
  KoiosDrepEpochSummary,
  KoiosDrepInfo,
} from "../../types/koios.types";
import { koiosPost } from "../koios";

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
    const governanceActionType = mapGovernanceType(koiosProposal.proposal_type);

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
        ratifiedEpoch: koiosProposal.ratified_epoch,
        enactedEpoch: koiosProposal.enacted_epoch,
        droppedEpoch: koiosProposal.dropped_epoch,
        expiredEpoch: koiosProposal.expired_epoch,
        expirationEpoch: koiosProposal.expiration,
        metadata,
      },
      update: {
        // Only update mutable fields
        status,
        // Backfill governanceActionType when we have a valid mapping
        ...(governanceActionType !== null && { governanceActionType }),
        ratifiedEpoch: koiosProposal.ratified_epoch,
        enactedEpoch: koiosProposal.enacted_epoch,
        droppedEpoch: koiosProposal.dropped_epoch,
        expiredEpoch: koiosProposal.expired_epoch,
        expirationEpoch: koiosProposal.expiration,
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

    // 8. Fetch and update voting power summary data from Koios
    // This populates the DRep/SPO voting power fields for accurate percentage calculations
    // For completed proposals:
    //   - drepTotalVotePower uses:
    //     - ratified_epoch if proposal was ratified/enacted (voting snapshot at ratification)
    //     - expiration epoch if proposal was not ratified/enacted (voting snapshot when voting closed)
    //   - drepInactiveVotePower uses expiration epoch (for historical inactive calculation with certificate checking)
    // For active proposals:
    //   - Both use current epoch
    //   - Uses /drep_info API for more accurate current active status
    const isCompleted =
      koiosProposal.expiration != null &&
      koiosProposal.expiration <= currentEpoch;
    const isActiveProposal = !isCompleted;

    // Determine the epoch for DRep total voting power
    // Ratified/enacted proposals use ratified_epoch, others use expiration epoch
    let drepTotalPowerEpoch: number;
    if (!isCompleted) {
      drepTotalPowerEpoch = currentEpoch;
    } else if (koiosProposal.ratified_epoch != null) {
      drepTotalPowerEpoch = koiosProposal.ratified_epoch;
    } else {
      drepTotalPowerEpoch = koiosProposal.expiration!;
    }

    // Determine the epoch for SPO total voting power
    // SPO voting power uses (epoch - 1) because SPO stake snapshot is taken at epoch boundary
    // Ratified/enacted proposals: (ratified_epoch - 1)
    // Non-ratified completed proposals: (expiration - 1)
    // Active proposals: (currentEpoch - 1)
    let spoTotalPowerEpoch: number;
    if (!isCompleted) {
      spoTotalPowerEpoch = currentEpoch - 1;
    } else if (koiosProposal.ratified_epoch != null) {
      spoTotalPowerEpoch = koiosProposal.ratified_epoch - 1;
    } else {
      spoTotalPowerEpoch = koiosProposal.expiration! - 1;
    }

    const inactivePowerEpoch = isCompleted
      ? koiosProposal.expiration!
      : currentEpoch;
    await updateProposalVotingPower(
      proposal.proposalId,
      drepTotalPowerEpoch,
      spoTotalPowerEpoch,
      inactivePowerEpoch,
      isActiveProposal
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
  return ingestProposalData(
    koiosProposal,
    undefined,
    koiosProposal.proposed_epoch
  );
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
    `[Proposal Sync] Processing proposals from epoch ${
      sortedProposals[0]?.proposed_epoch
    } to ${sortedProposals[sortedProposals.length - 1]?.proposed_epoch}`
  );

  // Determine the earliest proposal submission epoch among the proposals
  // we are actually processing. Votes for these proposals cannot exist
  // before this epoch, so we can safely avoid fetching older votes.
  const earliestProposalEpoch = sortedProposals[0]?.proposed_epoch;
  const minVotesEpoch =
    typeof earliestProposalEpoch === "number"
      ? earliestProposalEpoch
      : undefined;

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
    HardForkInitiation: GovernanceType.HARD_FORK_INITIATION,
    TreasuryWithdrawals: GovernanceType.TREASURY_WITHDRAWALS,
    NoConfidence: GovernanceType.NO_CONFIDENCE,
    NewCommittee: GovernanceType.UPDATE_COMMITTEE,
    NewConstitution: GovernanceType.NEW_CONSTITUTION,
    InfoAction: GovernanceType.INFO_ACTION,
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
 *
 * Status flow:
 * - ACTIVE: Voting is ongoing
 * - RATIFIED: Passed voting, waiting for enactment (non-INFO actions)
 * - ENACTED: Applied to the chain (non-INFO actions)
 * - EXPIRED: Voting period ended without ratification/approval (non-INFO actions)
 * - CLOSED: Expired INFO action (INFO actions don't get ratified/enacted)
 */
function deriveProposalStatus(
  proposal: KoiosProposal,
  currentEpoch: number
): ProposalStatus {
  const isInfoAction = proposal.proposal_type === "InfoAction";

  // If enacted (applied to chain), return ENACTED
  if (proposal.enacted_epoch && proposal.enacted_epoch <= currentEpoch) {
    return ProposalStatus.ENACTED;
  }

  // If ratified but not yet enacted
  if (proposal.ratified_epoch && proposal.ratified_epoch <= currentEpoch) {
    return ProposalStatus.RATIFIED;
  }

  // If expired
  if (proposal.expired_epoch && proposal.expired_epoch <= currentEpoch) {
    // INFO actions use CLOSED status when expired
    return isInfoAction ? ProposalStatus.CLOSED : ProposalStatus.EXPIRED;
  }

  // If dropped
  if (proposal.dropped_epoch && proposal.dropped_epoch <= currentEpoch) {
    // INFO actions use CLOSED status when dropped
    return isInfoAction ? ProposalStatus.CLOSED : ProposalStatus.EXPIRED;
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
      if (proposal.meta_url.startsWith("ipfs://")) {
        const ipfsHash = proposal.meta_url.replace("ipfs://", "");
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
      const errorMsg =
        status === 404
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

/**
 * Fetches voting summary data from Koios for a specific proposal
 * Endpoint: GET /proposal_voting_summary?_proposal_id=<proposal_id>
 */
async function fetchProposalVotingSummary(
  proposalId: string
): Promise<KoiosProposalVotingSummary | null> {
  try {
    const summaries = await koiosGet<KoiosProposalVotingSummary[]>(
      `/proposal_voting_summary?_proposal_id=${proposalId}`
    );
    return summaries?.[0] ?? null;
  } catch (error: any) {
    console.warn(
      `[Voting Summary] Failed to fetch voting summary for ${proposalId}:`,
      error.message
    );
    return null;
  }
}

/**
 * Fetches total DRep voting power for an epoch
 * Endpoint: GET /drep_epoch_summary?_epoch_no=<epoch>
 * Returns value in lovelace as BigInt
 */
async function fetchDrepEpochSummary(epochNo: number): Promise<bigint> {
  try {
    const summaries = await koiosGet<KoiosDrepEpochSummary[]>(
      `/drep_epoch_summary?_epoch_no=${epochNo}`
    );
    if (summaries?.[0]?.amount) {
      return BigInt(summaries[0].amount);
    }
    return BigInt(0);
  } catch (error: any) {
    console.warn(
      `[DRep Epoch Summary] Failed to fetch for epoch ${epochNo}:`,
      error.message
    );
    return BigInt(0);
  }
}

/**
 * Fetches total SPO voting power for an epoch
 * Endpoint: GET /pool_voting_power_history (aggregate all pools)
 * Note: This requires fetching all pool voting powers and summing them
 * Returns value in lovelace as BigInt
 */
async function fetchSpoTotalVotingPower(epochNo: number): Promise<bigint> {
  try {
    // Fetch all pool voting power for the epoch (with pagination)
    let totalLovelace = BigInt(0);
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;
    let poolCount = 0;

    while (hasMore) {
      const poolPowers = await koiosGet<
        Array<{ pool_id_bech32: string; epoch_no: number; amount: string }>
      >(`/pool_voting_power_history?_epoch_no=${epochNo}&limit=${pageSize}&offset=${offset}`);

      if (poolPowers && poolPowers.length > 0) {
        for (const pool of poolPowers) {
          if (pool.amount) {
            totalLovelace += BigInt(pool.amount);
            poolCount++;
          }
        }
        offset += poolPowers.length;
        hasMore = poolPowers.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    console.log(
      `[SPO Total Voting Power] Summed ${poolCount} pools for epoch ${epochNo}`
    );

    return totalLovelace;
  } catch (error: any) {
    console.warn(
      `[SPO Total Voting Power] Failed to fetch for epoch ${epochNo}:`,
      error.message
    );
    return BigInt(0);
  }
}

/**
 * DRep Update entry from Koios API
 */
interface KoiosDrepUpdate {
  drep_id: string;
  block_time: number;
  action: string;
}

/**
 * Converts block_time to epoch number
 * Cardano mainnet: Epoch 0 started at 1596491091 (Shelley era start)
 * Each epoch is 432000 seconds (5 days)
 */
function blockTimeToEpoch(blockTime: number): number {
  const shelleyStart = 1596491091; // Unix timestamp for epoch 208 start (Shelley era)
  const epochLength = 432000; // 5 days in seconds
  const shelleyStartEpoch = 208;

  if (blockTime < shelleyStart) {
    return 0; // Before Shelley era
  }

  return (
    shelleyStartEpoch + Math.floor((blockTime - shelleyStart) / epochLength)
  );
}

/**
 * Fetches inactive DRep voting power for ACTIVE proposals using /drep_info API.
 *
 * For active proposals, we use the /drep_info API which provides both the `active` field
 * and the `amount` (voting power) directly. This approach:
 * 1. Fetches all DRep IDs with voting power from /drep_voting_power_history
 * 2. Batch queries /drep_info which returns both active status AND amount
 * 3. Sums the amount for all DReps where active == false
 *
 * Using batch size of 50 to stay safely under Koios API's 5120 byte payload limit.
 *
 * @param referenceEpoch - The current epoch (for fetching voting power)
 * @returns Inactive voting power in lovelace as BigInt
 */
async function fetchInactiveDrepVotingPowerForActiveProposal(
  referenceEpoch: number
): Promise<bigint> {
  try {
    console.log(
      `[Inactive DRep Power] Calculating for ACTIVE proposal at epoch ${referenceEpoch} using /drep_info API`
    );

    // 1. Get all DRep IDs with voting power for the reference epoch from Koios (with pagination)
    const drepIds: string[] = [];
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await koiosGet<
        Array<{ drep_id: string; epoch_no: number; amount: string }>
      >(
        `/drep_voting_power_history?_epoch_no=${referenceEpoch}&limit=${pageSize}&offset=${offset}`
      );
      if (page && page.length > 0) {
        for (const dp of page) {
          // Only include DReps with non-zero voting power, excluding special voting options
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

    // 2. Batch fetch DRep info using POST /drep_info (in batches of 50)
    // The /drep_info endpoint returns both `active` status and `amount` (voting power)
    // so we can calculate inactive power directly from this response.
    // Note: Koios API has a 5120 byte payload limit, and each DRep ID is ~64 bytes
    // 50 DReps = ~3200 bytes which is safely under the limit
    let inactivePowerLovelace = BigInt(0);
    let inactiveCount = 0;
    let activeCount = 0;
    const batchSize = 50;

    for (let i = 0; i < drepIds.length; i += batchSize) {
      const batch = drepIds.slice(i, i + batchSize);
      try {
        const drepInfos = await koiosPost<KoiosDrepInfo[]>("/drep_info", {
          _drep_ids: batch,
        });

        // Check if response is an array (success) or error object
        if (Array.isArray(drepInfos)) {
          for (const info of drepInfos) {
            if (info.active === false && info.amount) {
              // Sum voting power for inactive DReps directly from drep_info response
              inactivePowerLovelace += BigInt(info.amount);
              inactiveCount++;
            } else if (info.active === true) {
              activeCount++;
            }
          }
        } else {
          // API returned an error (e.g., payload too large)
          console.warn(
            `[Inactive DRep Power] Unexpected response from /drep_info:`,
            drepInfos
          );
        }
      } catch (error: any) {
        console.warn(
          `[Inactive DRep Power] Failed to fetch drep_info batch: ${error.message}`
        );
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

/**
 * Fetches inactive DRep voting power for COMPLETED proposals.
 *
 * A DRep is considered INACTIVE if they have NOT done any of the following
 * in the past 20 epochs from the reference epoch:
 * 1. Voted on any proposal
 * 2. Updated their DRep certificate (registered, updated, or deregistered)
 *
 * This function uses the local database to check voting activity (faster than API),
 * and only calls Koios API for certificate updates when needed.
 *
 * Note: The result excludes drep_always_abstain and drep_always_no_confidence power
 * since these are special voting options tracked separately, not real inactive DReps.
 *
 * @param referenceEpoch - The epoch to calculate inactive power for (expirationEpoch for completed proposals)
 * @returns Inactive voting power in lovelace as BigInt
 */
async function fetchInactiveDrepVotingPowerForCompletedProposal(
  referenceEpoch: number
): Promise<bigint> {
  const ACTIVITY_WINDOW = 20; // Check activity in past 20 epochs
  const minActiveEpoch = referenceEpoch - ACTIVITY_WINDOW;

  try {
    console.log(
      `[Inactive DRep Power] Calculating for epoch ${referenceEpoch} (activity window: epochs ${minActiveEpoch} to ${referenceEpoch})`
    );

    // 1. Get DRep voting power for the reference epoch from Koios (with pagination)
    const drepPowerMap = new Map<string, string>();
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await koiosGet<
        Array<{ drep_id: string; epoch_no: number; amount: string }>
      >(
        `/drep_voting_power_history?_epoch_no=${referenceEpoch}&limit=${pageSize}&offset=${offset}`
      );
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

    // 2. Query local database to find DReps who voted on proposals within the activity window
    // A DRep is active if they voted on any proposal where the proposal's submission or expiration
    // epoch falls within the activity window
    const activeDrepIds = new Set<string>();

    const activeVoters = await prisma.onchainVote.findMany({
      where: {
        voterType: "DREP",
        drepId: { not: null },
        proposal: {
          OR: [
            // Proposal was submitted within the activity window
            {
              submissionEpoch: {
                gte: minActiveEpoch,
                lte: referenceEpoch,
              },
            },
            // Proposal expires within or after the activity window (was active during the window)
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

    // // 3. Find DReps who haven't voted - only these need certificate update checks
    // // Skip special predefined voting options (they don't have certificate updates)
    const drepsWithoutVotes: string[] = [];
    for (const drepId of drepPowerMap.keys()) {
      if (!activeDrepIds.has(drepId) && !SPECIAL_DREP_IDS.includes(drepId)) {
        drepsWithoutVotes.push(drepId);
      }
    }

    console.log(
      `[Inactive DRep Power] ${drepsWithoutVotes.length} DReps haven't voted, checking certificate updates...`
    );

    // // 4. For DReps who haven't voted, check if they updated their certificate in the activity window
    // // Only fetch updates for specific DReps instead of all DRep updates globally
    // // Note: /drep_updates API requires bech32 format DRep ID
    for (const drepId of drepsWithoutVotes) {
      try {
        const updates = await koiosGet<KoiosDrepUpdate[]>(
          `/drep_updates?_drep_id=${drepId}`
        );
        if (updates && updates.length > 0) {
          // Check if any update is within the activity window
          for (const update of updates) {
            const updateEpoch = blockTimeToEpoch(update.block_time);
            if (
              updateEpoch >= minActiveEpoch &&
              updateEpoch <= referenceEpoch
            ) {
              activeDrepIds.add(drepId);
              break; // Found activity, no need to check more updates
            }
          }
        }
      } catch (error: any) {
        // If we can't fetch updates for this DRep, assume inactive (conservative approach)
        console.warn(
          `[Inactive DRep Power] Failed to fetch updates for ${drepId}: ${error.message}`
        );
      }
    }

    console.log(
      `[Inactive DRep Power] Total active DReps (voted or updated certificate): ${activeDrepIds.size}`
    );

    // 5. Calculate inactive DRep voting power (in lovelace)
    // Exclude special voting options (drep_always_abstain, drep_always_no_confidence)
    // as they are not real inactive DReps - they are tracked separately
    let inactivePowerLovelace = BigInt(0);
    let inactiveCount = 0;

    for (const [drepId, amount] of drepPowerMap) {
      // Skip special voting options and active DReps
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

/**
 * Converts lovelace string to BigInt (for Prisma BigInt fields)
 * Returns null if input is null/undefined
 */
function lovelaceToBigInt(lovelace: string | null | undefined): bigint | null {
  if (!lovelace) return null;
  return BigInt(lovelace);
}

/**
 * Updates voting power data for a proposal
 * Fetches voting summary from Koios and updates the proposal record
 * All values are stored in lovelace (as BigInt) for precision
 *
 * @param proposalId - The proposal ID to update
 * @param epochNo - The epoch to use for fetching total voting powers
 *                  (should be expirationEpoch for completed proposals, currentEpoch for active)
 */
// DRep inactivity rules (20-epoch activity window) were introduced starting from epoch 527.
// The drep_activity field started at 20 in epoch 507, so the ledger began checking
// DRep activity from epoch 507 + 20 = 527.
// Proposals before this epoch should have drepInactiveVotePower = 0.
const DREP_INACTIVITY_START_EPOCH = 527;

// Special predefined voting options - not real DReps, tracked separately in voting summary.
// These are included in drep_voting_power_history but don't have certificate updates.
const SPECIAL_DREP_IDS = ["drep_always_abstain", "drep_always_no_confidence"];

async function updateProposalVotingPower(
  proposalId: string,
  drepTotalPowerEpoch: number,
  spoTotalPowerEpoch: number,
  inactivePowerEpoch: number,
  isActiveProposal: boolean
): Promise<void> {
  try {
    // Fetch voting summary for this proposal
    const votingSummary = await fetchProposalVotingSummary(proposalId);

    if (!votingSummary) {
      console.log(
        `[Voting Power] No voting summary available for ${proposalId}`
      );
      return;
    }

    console.log(
      `[Voting Power] Fetching voting power data - drepTotal: epoch ${drepTotalPowerEpoch}, spoTotal: epoch ${spoTotalPowerEpoch}, inactive: epoch ${inactivePowerEpoch}, isActive: ${isActiveProposal} (proposal: ${proposalId})`
    );

    // Fetch total voting powers for the epoch (these are needed for "Not Voted" calculation)
    // - drepTotalVotePower uses drepTotalPowerEpoch
    // - spoTotalVotePower uses spoTotalPowerEpoch (epoch - 1 because SPO stake snapshot is taken at epoch boundary)
    // - drepInactiveVotePower uses inactivePowerEpoch (expiration epoch for completed proposals)
    // Only calculate inactive DRep power for epochs >= 527 (when inactivity rules were introduced)
    const shouldCalculateInactive =
      inactivePowerEpoch >= DREP_INACTIVITY_START_EPOCH;

    // Use different methods for active vs completed proposals:
    // - Active proposals: Use /drep_info API which has `active` field for current state
    // - Completed proposals: Use certificate update checking for historical state
    const fetchInactivePower = isActiveProposal
      ? fetchInactiveDrepVotingPowerForActiveProposal
      : fetchInactiveDrepVotingPowerForCompletedProposal;

    const [drepTotalVotePower, spoTotalVotePower, drepInactiveVotePower] =
      await Promise.all([
        fetchDrepEpochSummary(drepTotalPowerEpoch),
        fetchSpoTotalVotingPower(spoTotalPowerEpoch),
        shouldCalculateInactive
          ? fetchInactivePower(inactivePowerEpoch)
          : Promise.resolve(BigInt(0)),
      ]);

    if (!shouldCalculateInactive) {
      console.log(
        `[Voting Power] Skipping inactive DRep calculation for epoch ${inactivePowerEpoch} (before epoch ${DREP_INACTIVITY_START_EPOCH})`
      );
    }

    // Update proposal with voting power data (all values stored in lovelace as BigInt)
    await prisma.proposal.update({
      where: { proposalId },
      data: {
        // DRep voting power fields (lovelace)
        drepTotalVotePower,
        drepActiveYesVotePower: lovelaceToBigInt(
          votingSummary.drep_active_yes_vote_power
        ),
        drepActiveNoVotePower: lovelaceToBigInt(
          votingSummary.drep_active_no_vote_power
        ),
        drepActiveAbstainVotePower: lovelaceToBigInt(
          votingSummary.drep_active_abstain_vote_power
        ),
        drepAlwaysAbstainVotePower: lovelaceToBigInt(
          votingSummary.drep_always_abstain_vote_power
        ),
        drepAlwaysNoConfidenceVotePower: lovelaceToBigInt(
          votingSummary.drep_always_no_confidence_vote_power
        ),
        drepInactiveVotePower,
        // SPO voting power fields (lovelace) - Koios uses "pool_" prefix
        spoTotalVotePower,
        spoActiveYesVotePower: lovelaceToBigInt(
          votingSummary.pool_active_yes_vote_power
        ),
        spoActiveNoVotePower: lovelaceToBigInt(
          votingSummary.pool_active_no_vote_power
        ),
        spoActiveAbstainVotePower: lovelaceToBigInt(
          votingSummary.pool_active_abstain_vote_power
        ),
        spoAlwaysAbstainVotePower: lovelaceToBigInt(
          votingSummary.pool_passive_always_abstain_vote_power
        ),
        spoAlwaysNoConfidenceVotePower: lovelaceToBigInt(
          votingSummary.pool_passive_always_no_confidence_vote_power
        ),
      },
    });

    console.log(`[Voting Power] Updated voting power data for ${proposalId}`);
  } catch (error: any) {
    console.warn(
      `[Voting Power] Failed to update for ${proposalId}:`,
      error.message
    );
  }
}
