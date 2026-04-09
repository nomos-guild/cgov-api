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
import {
  isDbConnectivityError,
  recordDbFailureForFailFast,
  shouldFailFastForDb,
} from "./dbFailFast";
import type { ProposalVotingPowerRunCache } from "./proposalVotingPower.service";
import type { VotingPowerUpdateOutcome } from "./proposalVotingPower.service";
import type {
  KoiosProposal,
  KoiosVote,
} from "../../types/koios.types";
import {
  createProposalPipelineRunCaches,
  isProposalStatusRetryable,
  runProposalDownstreamPipeline,
} from "./proposalPipeline";
import type { VoteIngestionRunCache } from "./vote.service";
import { logIntegrityEvent } from "./integrityMetrics";
import type { IngestionDbClient } from "./dbSession";
import { withIngestionDbRead, withIngestionDbWrite } from "./dbSession";

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
      outcome: VotingPowerUpdateOutcome;
      skipped?: boolean;
      skippedReason?: string;
      partial?: boolean;
      partialReasons?: string[];
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
  logPrefix = "[Proposal Sync]",
  db: IngestionDbClient = prisma
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

  await withIngestionDbWrite(
    db,
    `proposal.finalize-status.${result.proposal.proposalId}`,
    () =>
      db.proposal.update({
        where: { proposalId: result.proposal.proposalId },
        data: { status: result.intendedStatus },
      })
  );

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
  /** Optional DB client; defaults to shared Prisma client. */
  db?: IngestionDbClient;
  /** Optional current epoch to reuse across calls */
  currentEpoch?: number;
  /** Optional minimum epoch to fetch votes from */
  minVotesEpoch?: number;
  /** Optional vote rows already fetched by caller (sync-on-read). */
  prefetchedVotes?: KoiosVote[];
  /** Join an in-flight ingestion for the same proposal ID (default: true). */
  joinInFlight?: boolean;
  /** Optional per-run vote cache for bulk syncs */
  voteRunCache?: VoteIngestionRunCache;
  /** Optional per-run cache for inactive DRep power (scoped to syncAllProposals run) */
  inactivePowerRunCache?: Map<string, bigint>;
  /** Optional per-run cache for proposal voting power fetches */
  proposalVotingPowerRunCache?: ProposalVotingPowerRunCache;
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

const proposalIngestionInFlight = new Map<
  string,
  Promise<ProposalIngestionResult>
>();

export function isProposalStatusLocallyRetryable(
  status: ProposalStatus | null | undefined
): boolean {
  return isProposalStatusRetryable(status ?? null);
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
  const joinInFlight = options?.joinInFlight !== false;
  const proposalInFlightKey = koiosProposal.proposal_id;

  if (joinInFlight) {
    const inFlight = proposalIngestionInFlight.get(proposalInFlightKey);
    if (inFlight) {
      console.log(
        `[Proposal Ingest] action=single-flight-join proposalId=${proposalInFlightKey}`
      );
      return inFlight;
    }
  }

  const execute = async (): Promise<ProposalIngestionResult> => {
    if (shouldFailFastForDb("ingestion.proposal.ingest")) {
      throw new Error("DB fail-fast active; skipping proposal ingestion");
    }
    const {
      db = prisma,
      currentEpoch: currentEpochOverride,
      minVotesEpoch: minVotesEpochOverride,
      voteRunCache,
      inactivePowerRunCache,
      proposalVotingPowerRunCache,
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
    const existingProposal = await withIngestionDbRead(
      db,
      `proposal.ingest.find-existing.${koiosProposal.proposal_id}`,
      () =>
        db.proposal.findUnique({
          where: { proposalId: koiosProposal.proposal_id },
          select: {
            title: true,
            description: true,
            rationale: true,
            status: true,
          },
        })
    );

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
    const proposal = await withIngestionDbWrite(
      db,
      `proposal.ingest.upsert.${koiosProposal.proposal_id}`,
      () =>
        db.proposal.upsert({
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
        })
    );

    console.log(
      `[Proposal Ingest] ${isUpdate ? "Updated" : "Created"} proposal - ` +
      `proposalId: ${proposal.proposalId}, ` +
      `type: ${governanceActionType || "null"}, koios_type: "${koiosProposal.proposal_type}"`
    );

    const { votes: voteResult, votingPower: votingPowerResult } =
      await runProposalDownstreamPipeline({
        db,
        proposalId: proposal.proposalId,
        currentEpoch,
        koiosProposal,
        minVotesEpoch: minVotesEpochOverride,
        prefetchedVotes: options?.prefetchedVotes,
        useCache,
        voteRunCache,
        inactivePowerRunCache,
        inactivePowerMetrics,
        proposalVotingPowerRunCache,
      });
    const voteStats = voteResult.stats;

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
        `[Proposal Ingest] action=partial-failure proposalId=${proposal.proposalId} votesSuccess=${voteResult.success} votingPowerSuccess=${votingPowerResult.success} votingPowerOutcome=${votingPowerResult.outcome} voteError=${voteResult.error ?? "none"} votingPowerError=${votingPowerResult.error ?? "none"} skippedReason=${votingPowerResult.skippedReason ?? "none"} partialReasons=${votingPowerResult.partialReasons?.join(",") ?? "none"}`
      );
    }

    return result;
  };

  const executePromise = execute();
  if (joinInFlight) {
    proposalIngestionInFlight.set(proposalInFlightKey, executePromise);
  }

  try {
    return await executePromise;
  } finally {
    if (joinInFlight && proposalIngestionInFlight.get(proposalInFlightKey) === executePromise) {
      proposalIngestionInFlight.delete(proposalInFlightKey);
    }
  }
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
    db: prisma,
    minVotesEpoch: koiosProposal.proposed_epoch,
    // For single-proposal ingestion we prefer the per-proposal fetch path so
    // it matches sync-on-read semantics and avoids cross-proposal paging drift.
    useCache: false,
    deferStatusFinalization: true,
  });

  return finalizeProposalStatusAfterVoteSync(result, "[Ingest Proposal]", prisma);
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
  const { voteRunCache, proposalVotingPowerRunCache } =
    createProposalPipelineRunCaches();

  try {
    // 1. Snapshot existing proposals from DB (IDs + status)
    const db = prisma;
    const existingProposals = await withIngestionDbRead(
      db,
      "proposal.sync-all.find-existing",
      () =>
        db.proposal.findMany({
          select: { proposalId: true, status: true },
        })
    );

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
      upserted: 0,
      updated: 0,
      metadataAttempts: 0,
      metadataSuccess: 0,
      metadataFailed: 0,
      metadataSkipped: 0,
    };
    const votingPowerOutcomeTotals = new Map<VotingPowerUpdateOutcome, number>();

    // 6. Process each proposal sequentially
    for (const koiosProposal of sortedProposals) {
      try {
        const result = await ingestProposalData(koiosProposal, {
          db,
          currentEpoch,
          minVotesEpoch,
          voteRunCache,
          inactivePowerRunCache,
          proposalVotingPowerRunCache,
          inactivePowerMetrics,
          useCache: true,
          deferStatusFinalization: true,
        });

        voteRunTotals.processed += result.stats.votesProcessed;
        voteRunTotals.created += result.stats.votesIngested;
        voteRunTotals.upserted += result.stats.votesUpserted;
        voteRunTotals.updated += result.stats.votesUpdated;
        voteRunTotals.metadataAttempts += result.stats.metadata.attempts;
        voteRunTotals.metadataSuccess += result.stats.metadata.success;
        voteRunTotals.metadataFailed += result.stats.metadata.failed;
        voteRunTotals.metadataSkipped += result.stats.metadata.skipped;
        const votingPowerOutcome = result.downstream.votingPower.outcome;
        votingPowerOutcomeTotals.set(
          votingPowerOutcome,
          (votingPowerOutcomeTotals.get(votingPowerOutcome) ?? 0) + 1
        );

        if (!result.success) {
          results.partial++;
          results.errors.push({
            proposalHash: koiosProposal.proposal_tx_hash,
            error: getProposalIngestionFailureMessage(result),
          });
          console.warn(
            `[Proposal Sync] action=partial-failure proposalId=${result.proposal.proposalId} proposalHash=${koiosProposal.proposal_tx_hash} votesSuccess=${result.downstream.votes.success} votingPowerSuccess=${result.downstream.votingPower.success} votingPowerOutcome=${result.downstream.votingPower.outcome} skippedReason=${result.downstream.votingPower.skippedReason ?? "none"} partialReasons=${result.downstream.votingPower.partialReasons?.join(",") ?? "none"}`
          );
          continue;
        }

        await finalizeProposalStatusAfterVoteSync(result, "[Proposal Sync]", db);
        results.success++;
        console.log(
          `[Proposal Sync] ✓ Synced ${koiosProposal.proposal_tx_hash} (${results.success}/${results.total})`
        );
      } catch (error: any) {
        if (isDbConnectivityError(error)) {
          recordDbFailureForFailFast(error, "ingestion.proposal.sync-all");
        }
        results.failed++;
        results.errors.push({
          proposalHash: koiosProposal.proposal_tx_hash,
          error: error.message,
        });
        console.error(
          `[Proposal Sync] ✗ Failed to sync ${koiosProposal.proposal_tx_hash}:`,
          error.message
        );
        if (shouldFailFastForDb("ingestion.proposal.sync-all")) {
          console.warn(
            "[Proposal Sync] action=stop-early reason=db-fail-fast-active"
          );
          break;
        }
      }
    }

    console.log(
      `[Proposal Sync] Completed: ${results.success} succeeded, ${results.partial} partial, ${results.failed} failed`
    );
    console.log(
      `[Proposal Sync] Run summary durationMs=${Date.now() - startedAtMs} votesProcessed=${voteRunTotals.processed} votesUpserted=${voteRunTotals.upserted} votesCreated=${voteRunTotals.created} votesUpdated=${voteRunTotals.updated} metadataAttempts=${voteRunTotals.metadataAttempts} metadataSuccess=${voteRunTotals.metadataSuccess} metadataFailed=${voteRunTotals.metadataFailed} metadataSkipped=${voteRunTotals.metadataSkipped}`
    );
    const votingPowerOutcomeSummary = Array.from(votingPowerOutcomeTotals.entries())
      .map(([outcome, count]) => `${outcome}:${count}`)
      .join(",");
    console.log(
      `[Proposal Sync] action=voting-power-outcomes summary=${votingPowerOutcomeSummary || "none"}`
    );
    logIntegrityEvent({
      stream: "proposal",
      unit: "sync-all",
      outcome:
        results.failed > 0 ? "failed" : results.partial > 0 ? "partial" : "success",
      lagSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
      partialFailures: results.partial + results.failed,
      retries: results.errors.length,
    });
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
      `voting-power ${result.downstream.votingPower.outcome}${result.downstream.votingPower.error ? `: ${result.downstream.votingPower.error}` : ""}`
    );
  }

  return failures.join("; ") || "proposal ingestion failed";
}

export const getCurrentEpoch = getKoiosCurrentEpoch;
