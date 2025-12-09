import type { Proposal } from "@prisma/client";
import { prisma } from "./prisma";
import { koiosGet } from "./koios";
import { ingestProposalData } from "./ingestion/proposal.service";
import type {
  KoiosProposal,
  KoiosProposalVotingSummary,
} from "../types/koios.types";

/**
 * Columns to fetch from Koios /proposal_list for minimal comparison/ingestion.
 * Using vertical filtering keeps responses small.
 */
const PROPOSAL_SELECT_COLUMNS =
  [
    "proposal_id",
    "proposal_tx_hash",
    "proposal_index",
    "proposal_type",
    "proposed_epoch",
    "ratified_epoch",
    "enacted_epoch",
    "dropped_epoch",
    "expired_epoch",
    "expiration",
    "meta_url",
    "meta_hash",
    "meta_json",
    "block_time",
    "withdrawal",
  ].join(",");

type DbProposalForSync = Pick<
  Proposal,
  | "proposalId"
  | "txHash"
  | "certIndex"
  | "submissionEpoch"
  | "ratifiedEpoch"
  | "enactedEpoch"
  | "droppedEpoch"
  | "expiredEpoch"
  | "expirationEpoch"
  | "status"
  | "drepActiveYesVotePower"
  | "drepActiveNoVotePower"
  | "drepActiveAbstainVotePower"
  | "drepAlwaysAbstainVotePower"
  | "drepAlwaysNoConfidenceVotePower"
  | "spoActiveYesVotePower"
  | "spoActiveNoVotePower"
  | "spoActiveAbstainVotePower"
  | "spoAlwaysAbstainVotePower"
  | "spoAlwaysNoConfidenceVotePower"
>;

/**
 * Small helper to normalise BigInt DB values to string for comparison
 * with Koios voting summary (which returns lovelace as string).
 */
function bigIntToString(value: bigint | null): string | null {
  if (value == null) return null;
  return value.toString();
}

/**
 * Converts block_time (Unix seconds) to epoch number.
 * Same logic as in the proposal ingestion service – duplicated here to keep
 * sync-on-read self-contained.
 *
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

  return shelleyStartEpoch + Math.floor((blockTime - shelleyStart) / epochLength);
}

/**
 * Ensure that new proposals are synced into the database before
 * we serve overview data. This only looks for proposals whose
 * proposed_epoch is greater than the newest one we already have
 * and ingests just those.
 */
export async function syncProposalsOverviewOnRead(): Promise<void> {
  // Find the highest submissionEpoch we currently have
  const latest = await prisma.proposal.findFirst({
    orderBy: [
      { submissionEpoch: "desc" },
      { createdAt: "desc" },
    ],
    select: { submissionEpoch: true },
  });

  const maxEpoch = latest?.submissionEpoch ?? null;

  // If we don't have any proposals yet, fall back to full sync logic
  // but still using vertical filtering & pagination.
  const paramsBase: Record<string, any> = {
    select: PROPOSAL_SELECT_COLUMNS,
    order: "proposed_epoch.asc",
    limit: 100,
  };

  if (maxEpoch != null) {
    // Only fetch proposals that were submitted after the last one we know about
    paramsBase.proposed_epoch = `gt.${maxEpoch}`;
  }

  let offset = 0;
  let firstPage = true;
  let minVotesEpoch: number | undefined = undefined;

  // Paginate through new proposals (if any)
  // We stop as soon as Koios returns an empty page.
  // This keeps network usage minimal when there are no new proposals.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = { ...paramsBase, offset };
    const page = await koiosGet<KoiosProposal[]>("/proposal_list", params);

    if (!page || page.length === 0) {
      break;
    }

    if (firstPage) {
      firstPage = false;
      // Because we order by proposed_epoch.asc, the very first element we see
      // is the earliest proposal we will ingest in this run. We use its epoch
      // to limit vote ingestion (ingestVotesForProposal uses this to restrict
      // /vote_list to a smaller epoch range).
      const firstEpoch = page[0]?.proposed_epoch;
      if (typeof firstEpoch === "number") {
        minVotesEpoch = firstEpoch;
      }
    }

    for (const koiosProposal of page) {
      try {
        await ingestProposalData(koiosProposal, undefined, minVotesEpoch, {
          useCache: false,
        });
      } catch (error) {
        // We deliberately swallow individual errors here – a failure to ingest
        // one proposal shouldn't prevent the overview from working.
        // Detailed errors will be logged from within ingestProposalData.
        // eslint-disable-next-line no-console
        console.warn(
          "[SyncOnRead] Failed to ingest proposal from overview sync:",
          (error as Error).message
        );
      }
    }

    if (page.length < paramsBase.limit) {
      // Last page
      break;
    }

    offset += page.length;
  }
}

/**
 * Synchronise a single proposal (and its votes) on-demand when the
 * frontend requests proposal details.
 *
 * The flow is:
 * 1. Resolve the identifier to an existing DB proposal (if present)
 *    and/or to a Koios filter (proposal_id / proposal_tx_hash / index).
 * 2. Fetch a minimal Koios proposal row using vertical/horizontal filters.
 * 3. If DB is missing but Koios has it → ingest it.
 * 4. If both exist → compare key epoch / voting summary fields and only
 *    re-ingest when there is a difference.
 */
export async function syncProposalDetailsOnRead(
  identifier: string
): Promise<void> {
  const trimmed = identifier.trim();
  if (!trimmed) return;

  // 1. Try to resolve an existing DB proposal and a Koios filter
  let dbProposal: DbProposalForSync | null = null;

  // Prefer resolving numeric DB id first, if this looks like a number
  const numericId = Number(trimmed);
  if (!Number.isNaN(numericId)) {
    dbProposal = await prisma.proposal.findUnique({
      where: { id: numericId },
      select: {
        proposalId: true,
        txHash: true,
        certIndex: true,
        submissionEpoch: true,
        ratifiedEpoch: true,
        enactedEpoch: true,
        droppedEpoch: true,
        expiredEpoch: true,
        expirationEpoch: true,
        status: true,
        drepActiveYesVotePower: true,
        drepActiveNoVotePower: true,
        drepActiveAbstainVotePower: true,
        drepAlwaysAbstainVotePower: true,
        drepAlwaysNoConfidenceVotePower: true,
        spoActiveYesVotePower: true,
        spoActiveNoVotePower: true,
        spoActiveAbstainVotePower: true,
        spoAlwaysAbstainVotePower: true,
        spoAlwaysNoConfidenceVotePower: true,
      },
    });
  }

  let koiosFilter: {
    proposal_id?: string;
    proposal_tx_hash?: string;
    proposal_index?: number;
  } = {};

  if (trimmed.startsWith("gov_action")) {
    // Cardano governance action ID
    if (!dbProposal) {
      dbProposal = await prisma.proposal.findUnique({
        where: { proposalId: trimmed },
        select: {
          proposalId: true,
          txHash: true,
          certIndex: true,
          submissionEpoch: true,
          ratifiedEpoch: true,
          enactedEpoch: true,
          droppedEpoch: true,
          expiredEpoch: true,
          expirationEpoch: true,
          status: true,
          drepActiveYesVotePower: true,
          drepActiveNoVotePower: true,
          drepActiveAbstainVotePower: true,
          drepAlwaysAbstainVotePower: true,
          drepAlwaysNoConfidenceVotePower: true,
          spoActiveYesVotePower: true,
          spoActiveNoVotePower: true,
          spoActiveAbstainVotePower: true,
          spoAlwaysAbstainVotePower: true,
          spoAlwaysNoConfidenceVotePower: true,
        },
      });
    }
    koiosFilter.proposal_id = trimmed;
  } else if (trimmed.includes(":") && !trimmed.startsWith("gov_action")) {
    // txHash:certIndex format
    const [hashCandidate, certCandidate] = trimmed.split(":");
    if (hashCandidate && certCandidate) {
      if (!dbProposal) {
        dbProposal = await prisma.proposal.findFirst({
          where: { txHash: hashCandidate, certIndex: certCandidate },
          select: {
            proposalId: true,
            txHash: true,
            certIndex: true,
            submissionEpoch: true,
            ratifiedEpoch: true,
            enactedEpoch: true,
            droppedEpoch: true,
            expiredEpoch: true,
            expirationEpoch: true,
            status: true,
            drepActiveYesVotePower: true,
            drepActiveNoVotePower: true,
            drepActiveAbstainVotePower: true,
            drepAlwaysAbstainVotePower: true,
            drepAlwaysNoConfidenceVotePower: true,
            spoActiveYesVotePower: true,
            spoActiveNoVotePower: true,
            spoActiveAbstainVotePower: true,
            spoAlwaysAbstainVotePower: true,
            spoAlwaysNoConfidenceVotePower: true,
          },
        });
      }
      koiosFilter.proposal_tx_hash = hashCandidate;
      const idx = Number(certCandidate);
      if (!Number.isNaN(idx)) {
        koiosFilter.proposal_index = idx;
      }
    }
  } else if (!trimmed.startsWith("gov_action")) {
    // Plain txHash (or some other string identifier)
    if (!dbProposal) {
      dbProposal = await prisma.proposal.findFirst({
        where: { txHash: trimmed },
        select: {
          proposalId: true,
          txHash: true,
          certIndex: true,
          submissionEpoch: true,
          ratifiedEpoch: true,
          enactedEpoch: true,
          droppedEpoch: true,
          expiredEpoch: true,
          expirationEpoch: true,
          status: true,
          drepActiveYesVotePower: true,
          drepActiveNoVotePower: true,
          drepActiveAbstainVotePower: true,
          drepAlwaysAbstainVotePower: true,
          drepAlwaysNoConfidenceVotePower: true,
          spoActiveYesVotePower: true,
          spoActiveNoVotePower: true,
          spoActiveAbstainVotePower: true,
          spoAlwaysAbstainVotePower: true,
          spoAlwaysNoConfidenceVotePower: true,
        },
      });
    }
    koiosFilter.proposal_tx_hash = trimmed;
  }

  // If we have a DB proposal but no explicit Koios filter yet, derive it
  if (!koiosFilter.proposal_id && !koiosFilter.proposal_tx_hash && dbProposal) {
    koiosFilter.proposal_id = dbProposal.proposalId;
  }

  // If we still don't have any way to query Koios, give up silently.
  if (!koiosFilter.proposal_id && !koiosFilter.proposal_tx_hash) {
    return;
  }

  // 2. Fetch minimal Koios proposal row for comparison / ingestion
  const params: Record<string, any> = {
    select: PROPOSAL_SELECT_COLUMNS,
    limit: 1,
  };

  if (koiosFilter.proposal_id) {
    params.proposal_id = `eq.${koiosFilter.proposal_id}`;
  }
  if (koiosFilter.proposal_tx_hash) {
    params.proposal_tx_hash = `eq.${koiosFilter.proposal_tx_hash}`;
  }
  if (typeof koiosFilter.proposal_index === "number") {
    params.proposal_index = `eq.${koiosFilter.proposal_index}`;
  }

  const koiosRows = await koiosGet<KoiosProposal[]>("/proposal_list", params);
  const koiosProposal = koiosRows?.[0];

  if (!koiosProposal) {
    // Nothing on Koios side – nothing to sync
    return;
  }

  // Determine the minimum epoch to fetch votes from.
  // If we already have votes in the database, we:
  //   1) Find the latest vote's votedAt timestamp,
  //   2) Convert it to an epoch number,
  //   3) Fetch from the PREVIOUS epoch onward (epoch - 1) to avoid missing
  //      any votes around the boundary while still limiting Koios traffic.
  // If there are no votes yet, fall back to the proposal's submission epoch.
  let minEpochForVotes: number | undefined =
    typeof koiosProposal.proposed_epoch === "number"
      ? koiosProposal.proposed_epoch
      : undefined;

  try {
    const lastVote = await prisma.onchainVote.findFirst({
      where: { proposalId: koiosProposal.proposal_id },
      orderBy: { votedAt: "desc" },
      select: { votedAt: true },
    });

    if (lastVote?.votedAt) {
      const lastBlockTime = Math.floor(lastVote.votedAt.getTime() / 1000);
      const lastEpoch = blockTimeToEpoch(lastBlockTime);
      const fromEpoch = Math.max(lastEpoch - 1, 0);

      if (
        typeof minEpochForVotes !== "number" ||
        fromEpoch < minEpochForVotes
      ) {
        minEpochForVotes = fromEpoch;
      }
    }
  } catch (error) {
    // If we can't determine last vote epoch, we simply fall back to
    // proposed_epoch-based lower bound.
    // eslint-disable-next-line no-console
    console.warn(
      "[SyncOnRead] Failed to determine last vote epoch for proposal:",
      (error as Error).message
    );
  }

  // 3. If DB is missing but Koios has the proposal, ingest it now
  if (!dbProposal) {
    try {
      await ingestProposalData(
        koiosProposal,
        undefined,
        minEpochForVotes,
        { useCache: false }
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        "[SyncOnRead] Failed to ingest missing proposal on details read:",
        (error as Error).message
      );
    }
    return;
  }

  // 4. Compare epoch fields first – if any differ, we re-ingest completely.
  const epochChanged =
    (dbProposal.submissionEpoch ?? null) !==
      (koiosProposal.proposed_epoch ?? null) ||
    (dbProposal.ratifiedEpoch ?? null) !==
      (koiosProposal.ratified_epoch ?? null) ||
    (dbProposal.enactedEpoch ?? null) !==
      (koiosProposal.enacted_epoch ?? null) ||
    (dbProposal.droppedEpoch ?? null) !==
      (koiosProposal.dropped_epoch ?? null) ||
    (dbProposal.expiredEpoch ?? null) !==
      (koiosProposal.expired_epoch ?? null) ||
    (dbProposal.expirationEpoch ?? null) !==
      (koiosProposal.expiration ?? null);

  if (epochChanged) {
    try {
      await ingestProposalData(
        koiosProposal,
        undefined,
        minEpochForVotes,
        { useCache: false }
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        "[SyncOnRead] Failed to re-ingest proposal after epoch change:",
        (error as Error).message
      );
    }
    return;
  }

  // 5. Epochs match – there might still be new votes. We do a very small
  //    comparison by fetching the proposal voting summary from Koios and
  //    comparing it to the summary fields we store on the proposal row.
  let votingSummary: KoiosProposalVotingSummary | null = null;
  try {
    const summaries = await koiosGet<KoiosProposalVotingSummary[]>(
      "/proposal_voting_summary",
      { _proposal_id: koiosProposal.proposal_id }
    );
    votingSummary = summaries?.[0] ?? null;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      "[SyncOnRead] Failed to fetch proposal voting summary:",
      (error as Error).message
    );
  }

  if (!votingSummary) {
    return;
  }

  const hasVotingSummaryDiff =
    bigIntToString(dbProposal.drepActiveYesVotePower ?? null) !==
      (votingSummary.drep_active_yes_vote_power ?? null) ||
    bigIntToString(dbProposal.drepActiveNoVotePower ?? null) !==
      (votingSummary.drep_active_no_vote_power ?? null) ||
    bigIntToString(dbProposal.drepActiveAbstainVotePower ?? null) !==
      (votingSummary.drep_active_abstain_vote_power ?? null) ||
    bigIntToString(dbProposal.drepAlwaysAbstainVotePower ?? null) !==
      (votingSummary.drep_always_abstain_vote_power ?? null) ||
    bigIntToString(
      dbProposal.drepAlwaysNoConfidenceVotePower ?? null
    ) !== (votingSummary.drep_always_no_confidence_vote_power ?? null) ||
    bigIntToString(dbProposal.spoActiveYesVotePower ?? null) !==
      (votingSummary.pool_active_yes_vote_power ?? null) ||
    bigIntToString(dbProposal.spoActiveNoVotePower ?? null) !==
      (votingSummary.pool_active_no_vote_power ?? null) ||
    bigIntToString(dbProposal.spoActiveAbstainVotePower ?? null) !==
      (votingSummary.pool_active_abstain_vote_power ?? null) ||
    bigIntToString(dbProposal.spoAlwaysAbstainVotePower ?? null) !==
      (votingSummary.pool_passive_always_abstain_vote_power ?? null) ||
    bigIntToString(
      dbProposal.spoAlwaysNoConfidenceVotePower ?? null
    ) !== (votingSummary.pool_passive_always_no_confidence_vote_power ??
      null);

  if (!hasVotingSummaryDiff) {
    // Nothing changed since we last ingested this proposal.
    return;
  }

  try {
    await ingestProposalData(
      koiosProposal,
      undefined,
      minEpochForVotes,
      { useCache: false }
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      "[SyncOnRead] Failed to re-ingest proposal after voting summary change:",
      (error as Error).message
    );
  }
}


