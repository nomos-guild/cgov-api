/**
 * Proposal Ingestion Service
 * Handles syncing proposals from Koios API to database
 */

import {
  ProposalStatus,
} from "@prisma/client";
import { prisma } from "../prisma";
import { koiosGet } from "../koios";
import {
  createVoteIngestionRunCache,
  type VoteIngestionRunCache,
  ingestVotesForProposal,
  VoteIngestionStats,
  clearVoteCache,
} from "./vote.service";
import { clearVoterKoiosCaches } from "./voterIngestion.service";
import {
  GOVERNANCE_SURVEY_LINK_KIND,
  parseGovernanceSurveyLink,
} from "../../libs/surveyMetadata";
import { getKoiosCurrentEpoch } from "./sync-utils";
import {
  extractProposalMetadata,
  fetchLinkedSurveyDetails,
  hasMissingProposalInfoFields,
} from "./proposalMetadata.service";
import {
  deriveProposalStatus,
  extractTreasuryWithdrawalAmount,
  mapGovernanceType,
} from "./proposalStatus.policy";
import {
  createInactivePowerMetrics,
  logInactivePowerMetrics,
} from "./inactiveDrepPower.service";
import type { InactivePowerMetrics } from "./inactiveDrepPower.service";
import { updateProposalVotingPower } from "./proposalVotingPower.service";
import type {
  KoiosProposal,
} from "../../types/koios.types";

/**
 * Result of proposal ingestion
 */
export interface ProposalIngestionResult {
  success: boolean;
  downstream: {
    votes: {
      success: boolean;
      error?: string;
    };
    votingPower: {
      success: boolean;
      error?: string;
      summaryFound: boolean;
    };
  };
  proposal: {
    id: number;
    proposalId: string;
    status: ProposalStatus;
  };
  stats: VoteIngestionStats;
  /**
   * The intended final status for the proposal.
   * When status finalization is deferred and the derived status would advance
   * beyond the currently stored local status, the proposal keeps its current
   * retryable status during ingestion and returns the derived status here.
   * The caller should update the status after successful sync completion.
   */
  intendedStatus?: ProposalStatus;
}

/**
 * Finalizes deferred proposal status after a successful full sync.
 *
 * When ingestProposalData defers a status advancement, the proposal keeps its
 * current local status during ingestion and returns the derived status as
 * intendedStatus. This helper applies that intended status only after votes
 * (and related proposal data) were synced successfully.
 */
export async function finalizeProposalStatusAfterVoteSync(
  result: ProposalIngestionResult,
  logPrefix = "[Proposal Sync]"
): Promise<ProposalIngestionResult> {
  if (!result.success) {
    console.warn(
      `${logPrefix} action=skip-finalize reason=partial-failure proposalId=${result.proposal.proposalId} votesSuccess=${result.downstream.votes.success} votingPowerSuccess=${result.downstream.votingPower.success}`
    );
    return result;
  }

  if (!result.intendedStatus || result.intendedStatus === result.proposal.status) {
    return result;
  }

  await prisma.proposal.update({
    where: { proposalId: result.proposal.proposalId },
    data: { status: result.intendedStatus },
  });

  console.log(
    `${logPrefix} Updated status for ${result.proposal.proposalId} to ${result.intendedStatus} after successful vote sync`
  );

  return {
    ...result,
    proposal: {
      ...result.proposal,
      status: result.intendedStatus,
    },
  };
}

/**
 * Summary of sync all proposals operation
 */
export interface SyncAllProposalsResult {
  total: number;
  success: number;
  partial: number;
  failed: number;
  errors: Array<{ proposalHash: string; error: string }>;
}

export interface ExistingProposalSyncState {
  proposalId: string;
  status: ProposalStatus;
}

/**
 * Options for ingestProposalData
 */
export interface IngestProposalOptions {
  /** Optional current epoch to reuse across calls */
  currentEpoch?: number;
  /** Optional minimum epoch to fetch votes from */
  minVotesEpoch?: number;
  /** Optional per-run vote cache for bulk syncs */
  voteRunCache?: VoteIngestionRunCache;
  /** Optional per-run cache for inactive DRep power (scoped to syncAllProposals run) */
  inactivePowerRunCache?: Map<string, bigint>;
  /** Optional metrics collector for inactive DRep power cache behavior */
  inactivePowerMetrics?: InactivePowerMetrics;
  /**
   * When true (default), vote fetching can reuse a per-run bulk cache.
   * When false, fetches only this proposal's votes directly from Koios
   * (ideal for sync-on-read).
   */
  useCache?: boolean;
  /**
   * When true, proposal status advancement is deferred until downstream vote
   * sync succeeds. During ingestion, the proposal keeps its current stored
   * status when the newly derived status differs; brand new proposals fall back
   * to ACTIVE so later triggers can retry partial syncs. The intended final
   * status is returned in the result so the caller can update it after
   * successful sync completion.
   */
  deferStatusFinalization?: boolean;
}

export function resolveDeferredProposalStatus(
  derivedStatus: ProposalStatus,
  currentStatus?: ProposalStatus | null,
  deferStatusFinalization = false
): { status: ProposalStatus; intendedStatus?: ProposalStatus } {
  if (!deferStatusFinalization) {
    return { status: derivedStatus };
  }

  if (currentStatus == null) {
    return derivedStatus === ProposalStatus.ACTIVE
      ? { status: ProposalStatus.ACTIVE }
      : {
        status: ProposalStatus.ACTIVE,
        intendedStatus: derivedStatus,
      };
  }

  if (currentStatus === derivedStatus) {
    return { status: derivedStatus };
  }

  return {
    status: currentStatus,
    intendedStatus: derivedStatus,
  };
}

export function isProposalStatusLocallyRetryable(
  status: ProposalStatus | null | undefined
): boolean {
  return status == null || status === ProposalStatus.ACTIVE;
}

export function selectProposalsForBulkSync(
  allProposals: KoiosProposal[],
  existingProposals: ExistingProposalSyncState[]
): KoiosProposal[] {
  const existingIds = new Set(existingProposals.map((p) => p.proposalId));
  const retryableIdsInDb = new Set(
    existingProposals
      .filter((p) => isProposalStatusLocallyRetryable(p.status))
      .map((p) => p.proposalId)
  );

  const proposalsToProcess = allProposals.filter((proposal) => {
    if (!existingIds.has(proposal.proposal_id)) {
      return true;
    }

    return retryableIdsInDb.has(proposal.proposal_id);
  });

  // Keep the last row per proposal_id so a single trigger attempts each
  // proposal only once, even if Koios returns duplicate rows.
  const proposalsById = new Map<string, KoiosProposal>();
  for (const proposal of proposalsToProcess) {
    proposalsById.set(proposal.proposal_id, proposal);
  }

  return [...proposalsById.values()];
}

/**
 * Ingests proposal data from Koios.
 * Attempts the pipeline once per trigger.
 *
 * Note: We intentionally avoid a long-running interactive transaction here.
 * The proposal row is upserted in a single DB operation, and votes/voters are
 * ingested in smaller operations so that partial progress is preserved and
 * retries can safely resume without starting from scratch.
 *
 * @param koiosProposal - Proposal data from Koios API
 * @param options - Optional configuration for ingestion
 * @returns Result with proposal info and vote statistics
 */
export async function ingestProposalData(
  koiosProposal: KoiosProposal,
  options?: IngestProposalOptions
): Promise<ProposalIngestionResult> {
  const {
    currentEpoch: currentEpochOverride,
    minVotesEpoch: minVotesEpochOverride,
    voteRunCache,
    inactivePowerRunCache,
    inactivePowerMetrics,
    useCache,
    deferStatusFinalization,
  } = options ?? {};
  // Koios requests already retry inside `koios.ts`. We intentionally avoid
  // replaying the whole proposal ingest on transient Prisma failures because
  // that can re-enter Koios-heavy work. Later sync triggers can recover when
  // the proposal remains missing from the DB or still ACTIVE.
  // 1. Get current epoch for status calculation
  //    Allow caller to provide it so we don't call Koios /tip for every proposal
  const currentEpoch =
    typeof currentEpochOverride === "number"
      ? currentEpochOverride
      : await getKoiosCurrentEpoch();

  // 2. Map Koios governance type to Prisma enum
  const governanceActionType = mapGovernanceType(koiosProposal.proposal_type);
  const withdrawalAmount = extractTreasuryWithdrawalAmount(koiosProposal);

  // If Koios sends a proposal_type we don't recognize, log it for debugging
  if (koiosProposal.proposal_type && !governanceActionType) {
    console.warn(
      "[Proposal Ingest] Unmapped proposal_type from Koios:",
      koiosProposal.proposal_type
    );
  }

  // 3. Derive status from epoch fields
  const derivedStatus = deriveProposalStatus(koiosProposal, currentEpoch);

  // 4. Check if proposal exists to determine if creating or updating
  const existingProposal = await prisma.proposal.findUnique({
    where: { proposalId: koiosProposal.proposal_id },
    select: {
      title: true,
      description: true,
      rationale: true,
      status: true,
    },
  });

  const isUpdate = !!existingProposal;
  const { status, intendedStatus } = resolveDeferredProposalStatus(
    derivedStatus,
    existingProposal?.status,
    deferStatusFinalization
  );

  const shouldBackfillMissingMetadataFields =
    !!existingProposal &&
    existingProposal.status === ProposalStatus.ACTIVE &&
    hasMissingProposalInfoFields(existingProposal);

  // 5. Extract metadata (from meta_json or fetch from meta_url)
  const { title, description, rationale, metadata } =
    await extractProposalMetadata(koiosProposal, {
      preferMetaUrlForMissingFields: shouldBackfillMissingMetadataFields,
      retryMetaUrlFetch: shouldBackfillMissingMetadataFields,
    });
  const surveyLink = parseGovernanceSurveyLink(metadata);
  const linkedSurveyDetails = surveyLink.surveyTxId
    && surveyLink.kind === GOVERNANCE_SURVEY_LINK_KIND
    && surveyLink.specVersion === "1.0.0"
    ? await fetchLinkedSurveyDetails(surveyLink.surveyTxId)
    : null;
  const serializedLinkedSurveyDetails = linkedSurveyDetails
    ? JSON.stringify(linkedSurveyDetails)
    : null;
  const shouldClearSurveyDetails = !surveyLink.surveyTxId;

  // Always re-inject text fields for active proposals to ensure
  // sanitized data from Koios overwrites any corrupted values.
  const updateInfoFields: {
    title?: string;
    description?: string | null;
    rationale?: string | null;
  } = {};

  if (existingProposal && existingProposal.status === ProposalStatus.ACTIVE) {
    updateInfoFields.title = title;
    updateInfoFields.description = description;
    updateInfoFields.rationale = rationale;
  }

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
      governanceActionType: governanceActionType ?? undefined,
      withdrawalAmount,
      status,
      submissionEpoch: koiosProposal.proposed_epoch,
      ratifiedEpoch: koiosProposal.ratified_epoch,
      enactedEpoch: koiosProposal.enacted_epoch,
      droppedEpoch: koiosProposal.dropped_epoch,
      expiredEpoch: koiosProposal.expired_epoch,
      expirationEpoch: koiosProposal.expiration,
      metadata,
      linkedSurveyTxId: surveyLink.surveyTxId,
      surveyDetails: serializedLinkedSurveyDetails,
    },
    update: {
      // Only update mutable fields
      status,
      withdrawalAmount,
      // Backfill governanceActionType when we have a valid mapping
      ...(governanceActionType !== null && {
        governanceActionType: governanceActionType,
      }),
      ratifiedEpoch: koiosProposal.ratified_epoch,
      enactedEpoch: koiosProposal.enacted_epoch,
      droppedEpoch: koiosProposal.dropped_epoch,
      expiredEpoch: koiosProposal.expired_epoch,
      expirationEpoch: koiosProposal.expiration,
      metadata,
      linkedSurveyTxId: surveyLink.surveyTxId,
      ...(serializedLinkedSurveyDetails !== null
        ? { surveyDetails: serializedLinkedSurveyDetails }
        : shouldClearSurveyDetails
        ? { surveyDetails: null }
        : {}),
      ...updateInfoFields,
    },
  });

  console.log(
    `[Proposal Ingest] ${isUpdate ? "Updated" : "Created"} proposal - ` +
    `proposalId: ${proposal.proposalId}, ` +
    `type: ${governanceActionType || "null"}, koios_type: "${koiosProposal.proposal_type}"`
  );

  // 7. Ingest all votes for this proposal using the root Prisma client.
  // This runs outside of a long-lived transaction so that:
  // - Individual vote/voter inserts can commit as they go.
  // - If we hit a timeout or other error part-way through, the next trigger can
  //   see existing rows and continue without duplicating work.
  const voteResult = await ingestVotesForProposal(
    proposal.proposalId,
    prisma,
    minVotesEpochOverride,
    {
      useCache: useCache !== false,
      runCache: voteRunCache,
    }
  );
  const voteStats = voteResult.stats;

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
  const votingPowerResult = await updateProposalVotingPower(
    proposal.proposalId,
    drepTotalPowerEpoch,
    spoTotalPowerEpoch,
    inactivePowerEpoch,
    isActiveProposal,
    inactivePowerRunCache,
    inactivePowerMetrics
  );

  const result: ProposalIngestionResult = {
    success: voteResult.success && votingPowerResult.success,
    downstream: {
      votes: {
        success: voteResult.success,
        error: voteResult.error,
      },
      votingPower: votingPowerResult,
    },
    proposal: {
      id: proposal.id,
      proposalId: proposal.proposalId,
      status: proposal.status,
    },
    stats: voteStats,
    intendedStatus,
  };

  if (!result.success) {
    console.warn(
      `[Proposal Ingest] action=partial-failure proposalId=${proposal.proposalId} votesSuccess=${voteResult.success} votingPowerSuccess=${votingPowerResult.success} voteError=${voteResult.error ?? "none"} votingPowerError=${votingPowerResult.error ?? "none"}`
    );
  }

  return result;
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
  const allProposals = await koiosGet<KoiosProposal[]>("/proposal_list", undefined, {
    source: "ingestion.proposal.ingest.single",
  });

  // 2. Filter in memory to find the specific proposal
  const koiosProposal = allProposals?.find(
    (p) => p.proposal_tx_hash === proposalHash
  );

  if (!koiosProposal) {
    throw new Error(`Proposal not found in Koios: ${proposalHash}`);
  }

  // 3. Ingest the proposal data (let it fetch current epoch itself) and
  //    only fetch votes from this proposal's submission epoch onward.
  const result = await ingestProposalData(koiosProposal, {
    minVotesEpoch: koiosProposal.proposed_epoch,
    // For single-proposal ingestion we prefer the per-proposal fetch path so
    // it matches sync-on-read semantics and avoids cross-proposal paging drift.
    useCache: false,
    deferStatusFinalization: true,
  });

  return finalizeProposalStatusAfterVoteSync(result, "[Ingest Proposal]");
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
  const startedAtMs = Date.now();
  console.log("[Proposal Sync] Starting sync of all proposals...");

  // Reset long-lived process-local caches so each bulk run starts clean.
  clearVoteCache();
  clearVoterKoiosCaches();
  const voteRunCache = createVoteIngestionRunCache();

  try {
    // 1. Snapshot existing proposals from DB (IDs + status)
    const existingProposals = await prisma.proposal.findMany({
      select: { proposalId: true, status: true },
    });

    // 2. Fetch all proposals from Koios (API does not support server-side filtering)
    const allProposals = await koiosGet<KoiosProposal[]>("/proposal_list", undefined, {
      source: "ingestion.proposal.sync.all",
    });

    if (!allProposals || allProposals.length === 0) {
      console.log("[Proposal Sync] No proposals found in Koios");
      return {
        total: 0,
        success: 0,
        partial: 0,
        failed: 0,
        errors: [],
      };
    }

    // 3. Decide which proposals to (re)ingest:
    //    - Any proposal missing from DB
    //    - Any proposal that is ACTIVE in the DB (so its status/votes stay fresh)
    const dedupedProposalsToProcess = selectProposalsForBulkSync(
      allProposals,
      existingProposals
    );
    const retryableOrNewCount = allProposals.filter((proposal) => {
      const existing = existingProposals.find(
        (row) => row.proposalId === proposal.proposal_id
      );
      return !existing || isProposalStatusLocallyRetryable(existing.status);
    }).length;
    const duplicateCount = retryableOrNewCount - dedupedProposalsToProcess.length;
    if (duplicateCount > 0) {
      console.warn(
        `[Proposal Sync] Deduplicated ${duplicateCount} duplicate proposal rows from Koios payload`
      );
    }

    const results: SyncAllProposalsResult = {
      total: dedupedProposalsToProcess.length,
      success: 0,
      partial: 0,
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
    const sortedProposals = dedupedProposalsToProcess.sort((a, b) => {
      const epochA = a.proposed_epoch || 0;
      const epochB = b.proposed_epoch || 0;
      return epochA - epochB;
    });

    console.log(
      `[Proposal Sync] Processing proposals from epoch ${sortedProposals[0]?.proposed_epoch
      } to ${sortedProposals[sortedProposals.length - 1]?.proposed_epoch}`
    );

    const earliestProposalEpoch = sortedProposals[0]?.proposed_epoch;
    const minVotesEpoch =
      typeof earliestProposalEpoch === "number"
        ? earliestProposalEpoch
        : undefined;

    // 5. Get current epoch once for the whole run and reuse it
    const currentEpoch = await getCurrentEpoch();
    const inactivePowerRunCache = new Map<string, bigint>();
    const inactivePowerMetrics = createInactivePowerMetrics();
    const voteRunTotals = {
      processed: 0,
      created: 0,
      updated: 0,
      metadataAttempts: 0,
      metadataSuccess: 0,
      metadataFailed: 0,
      metadataSkipped: 0,
    };

    // 6. Process each proposal sequentially
    for (const koiosProposal of sortedProposals) {
      try {
        const result = await ingestProposalData(koiosProposal, {
          currentEpoch,
          minVotesEpoch,
          voteRunCache,
          inactivePowerRunCache,
          inactivePowerMetrics,
          useCache: true,
          deferStatusFinalization: true,
        });

        voteRunTotals.processed += result.stats.votesProcessed;
        voteRunTotals.created += result.stats.votesIngested;
        voteRunTotals.updated += result.stats.votesUpdated;
        voteRunTotals.metadataAttempts += result.stats.metadata.attempts;
        voteRunTotals.metadataSuccess += result.stats.metadata.success;
        voteRunTotals.metadataFailed += result.stats.metadata.failed;
        voteRunTotals.metadataSkipped += result.stats.metadata.skipped;

        if (!result.success) {
          results.partial++;
          results.errors.push({
            proposalHash: koiosProposal.proposal_tx_hash,
            error: getProposalIngestionFailureMessage(result),
          });
          console.warn(
            `[Proposal Sync] action=partial-failure proposalId=${result.proposal.proposalId} proposalHash=${koiosProposal.proposal_tx_hash} votesSuccess=${result.downstream.votes.success} votingPowerSuccess=${result.downstream.votingPower.success}`
          );
          continue;
        }

        await finalizeProposalStatusAfterVoteSync(result, "[Proposal Sync]");
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
      }
    }

    console.log(
      `[Proposal Sync] Completed: ${results.success} succeeded, ${results.partial} partial, ${results.failed} failed`
    );
    console.log(
      `[Proposal Sync] Run summary durationMs=${Date.now() - startedAtMs} votesProcessed=${voteRunTotals.processed} votesCreated=${voteRunTotals.created} votesUpdated=${voteRunTotals.updated} metadataAttempts=${voteRunTotals.metadataAttempts} metadataSuccess=${voteRunTotals.metadataSuccess} metadataFailed=${voteRunTotals.metadataFailed} metadataSkipped=${voteRunTotals.metadataSkipped}`
    );
    logInactivePowerMetrics(inactivePowerMetrics);

    return results;
  } finally {
    clearVoteCache();
    clearVoterKoiosCaches();
  }
}

function getProposalIngestionFailureMessage(
  result: ProposalIngestionResult
): string {
  const failures: string[] = [];

  if (!result.downstream.votes.success) {
    failures.push(
      `vote-ingestion failed${result.downstream.votes.error ? `: ${result.downstream.votes.error}` : ""}`
    );
  }

  if (!result.downstream.votingPower.success) {
    failures.push(
      `voting-power failed${result.downstream.votingPower.error ? `: ${result.downstream.votingPower.error}` : ""}`
    );
  }

  return failures.join("; ") || "proposal ingestion failed";
}

export const getCurrentEpoch = getKoiosCurrentEpoch;
