import { ProposalStatus } from "@prisma/client";
import type { KoiosProposal } from "../../types/koios.types";
import {
  createProposalVotingPowerRunCache,
  type ProposalVotingPowerRunCache,
  updateProposalVotingPower,
} from "./proposalVotingPower.service";
import {
  createVoteIngestionRunCache,
  type VoteIngestionRunCache,
  ingestVotesForProposal,
  type VoteIngestionResult,
} from "./vote.service";
import type { InactivePowerMetrics } from "./inactiveDrepPower.service";
import { getKoiosPressureState } from "../koios";
import { prisma } from "../prisma";

export interface ProposalPipelineContext {
  proposalId: string;
  currentEpoch: number;
  koiosProposal: KoiosProposal;
  minVotesEpoch?: number;
  useCache?: boolean;
  voteRunCache?: VoteIngestionRunCache;
  inactivePowerRunCache?: Map<string, bigint>;
  inactivePowerMetrics?: InactivePowerMetrics;
  proposalVotingPowerRunCache?: ProposalVotingPowerRunCache;
}

export function createProposalPipelineRunCaches() {
  return {
    voteRunCache: createVoteIngestionRunCache(),
    proposalVotingPowerRunCache: createProposalVotingPowerRunCache(),
  };
}

export function resolveVotingPowerEpochs(
  koiosProposal: KoiosProposal,
  currentEpoch: number
): {
  isActiveProposal: boolean;
  drepTotalPowerEpoch: number;
  spoTotalPowerEpoch: number;
  inactivePowerEpoch: number;
} {
  const isCompleted =
    koiosProposal.expiration != null && koiosProposal.expiration <= currentEpoch;
  const isActiveProposal = !isCompleted;

  const drepTotalPowerEpoch = !isCompleted
    ? currentEpoch
    : koiosProposal.ratified_epoch ?? koiosProposal.expiration!;

  const spoTotalPowerEpoch = !isCompleted
    ? currentEpoch - 1
    : (koiosProposal.ratified_epoch ?? koiosProposal.expiration!) - 1;

  return {
    isActiveProposal,
    drepTotalPowerEpoch,
    spoTotalPowerEpoch,
    inactivePowerEpoch: isCompleted ? koiosProposal.expiration! : currentEpoch,
  };
}

export async function runProposalDownstreamPipeline(
  context: ProposalPipelineContext
): Promise<{
  votes: VoteIngestionResult;
  votingPower: Awaited<ReturnType<typeof updateProposalVotingPower>>;
}> {
  const votes = await ingestVotesForProposal(
    context.proposalId,
    prisma,
    context.minVotesEpoch,
    {
      useCache: context.useCache !== false,
      runCache: context.voteRunCache,
      fetchSurveyMetadata:
        process.env.KOIOS_SKIP_TX_METADATA_WHEN_DEGRADED !== "false"
          ? !getKoiosPressureState().active
          : true,
    }
  );

  const votingEpochs = resolveVotingPowerEpochs(
    context.koiosProposal,
    context.currentEpoch
  );
  const votingPower = await updateProposalVotingPower(
    context.proposalId,
    votingEpochs.drepTotalPowerEpoch,
    votingEpochs.spoTotalPowerEpoch,
    votingEpochs.inactivePowerEpoch,
    votingEpochs.isActiveProposal,
    context.inactivePowerRunCache,
    context.inactivePowerMetrics,
    context.proposalVotingPowerRunCache
  );

  if (
    votingPower.success
    && votingPower.summaryFound
    && votingEpochs.spoTotalPowerEpoch < 0
  ) {
    console.warn(
      `[Proposal Pipeline] action=partial proposalId=${context.proposalId} stage=voting-power reason=negative-spo-epoch`
    );
  }

  return { votes, votingPower };
}

export function isProposalStatusRetryable(status: ProposalStatus | null): boolean {
  return status == null || status === ProposalStatus.ACTIVE;
}
