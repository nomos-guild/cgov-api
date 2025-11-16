import {
  Proposal as PrismaProposal,
  OnchainVote,
  GovernanceType,
  ProposalStatus,
  VoteType,
  VoterType,
  Drep,
  SPO,
  CC,
  Prisma,
} from "@prisma/client";
import {
  GovernanceAction,
  GovernanceActionDetail,
  GovernanceActionVoteInfo,
  CCGovernanceActionVoteInfo,
  VoteRecord,
} from "../models";

type VoteWithRelations = OnchainVote & {
  drep: Drep | null;
  spo: SPO | null;
  cc: CC | null;
};

export type ProposalWithVotes = PrismaProposal & {
  onchainVotes: VoteWithRelations[];
};

export const proposalWithVotesSelect = {
  id: true,
  txHash: true,
  certIndex: true,
  title: true,
  description: true,
  rationale: true,
  governanceActionType: true,
  status: true,
  submissionEpoch: true,
  expiryEpoch: true,
  metadata: true,
  onchainVotes: {
    include: {
      drep: true,
      spo: true,
      cc: true,
    },
  },
} satisfies Prisma.ProposalSelect;

interface AdaTally {
  yes: number;
  no: number;
  abstain: number;
  total: number;
}

interface CountTally extends AdaTally {}

const statusLabelMap: Record<ProposalStatus, GovernanceAction["status"]> = {
  ACTIVE: "Active",
  RATIFIED: "Ratified",
  EXPIRED: "Expired",
  APPROVED: "Approved",
  NOT_APPROVED: "Not approved",
};

const toTitleCase = (value: string) =>
  value
    .toLowerCase()
    .split(" ")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");

const formatGovernanceType = (type?: GovernanceType | null) => {
  if (!type) {
    return "Unknown";
  }
  return toTitleCase(type.replace(/_/g, " "));
};

const formatStatus = (status: ProposalStatus) =>
  statusLabelMap[status] ?? "Active";

const percent = (value: number, total: number) =>
  total === 0 ? 0 : Number(((value / total) * 100).toFixed(2));

const getAdaValue = (vote: VoteWithRelations) => {
  if (vote.votingPowerLovelace) {
    const parsed = Number(vote.votingPowerLovelace);
    return Number.isFinite(parsed) ? parsed / 1_000_000 : 0; // Convert lovelace to ADA
  }

  return 0;
};

const tallyAdaVotes = (votes: VoteWithRelations[]): AdaTally => {
  const totals: AdaTally = { yes: 0, no: 0, abstain: 0, total: 0 };

  for (const vote of votes) {
    const power = getAdaValue(vote);
    if (vote.vote === VoteType.YES) {
      totals.yes += power;
    } else if (vote.vote === VoteType.NO) {
      totals.no += power;
    } else {
      totals.abstain += power;
    }
  }

  totals.total = totals.yes + totals.no + totals.abstain;
  return totals;
};

const tallyCountVotes = (votes: VoteWithRelations[]): CountTally => {
  const totals: CountTally = { yes: 0, no: 0, abstain: 0, total: 0 };

  for (const vote of votes) {
    if (vote.vote === VoteType.YES) {
      totals.yes += 1;
    } else if (vote.vote === VoteType.NO) {
      totals.no += 1;
    } else {
      totals.abstain += 1;
    }
  }

  totals.total = totals.yes + totals.no + totals.abstain;
  return totals;
};

const combineCountTallies = (...counts: CountTally[]): CountTally =>
  counts.reduce(
    (acc, current) => ({
      yes: acc.yes + current.yes,
      no: acc.no + current.no,
      abstain: acc.abstain + current.abstain,
      total: acc.total + current.total,
    }),
    { yes: 0, no: 0, abstain: 0, total: 0 }
  );

const buildVoteInfo = (tally: AdaTally): GovernanceActionVoteInfo => ({
  yesPercent: percent(tally.yes, tally.total),
  noPercent: percent(tally.no, tally.total),
  abstainPercent: percent(tally.abstain, tally.total),
  yesAda: tally.yes.toString(),
  noAda: tally.no.toString(),
  abstainAda: tally.abstain.toString(),
});

const buildCcVoteInfo = (tally: CountTally): CCGovernanceActionVoteInfo => ({
  yesPercent: percent(tally.yes, tally.total),
  noPercent: percent(tally.no, tally.total),
  abstainPercent: percent(tally.abstain, tally.total),
  yesCount: tally.yes,
  noCount: tally.no,
  abstainCount: tally.abstain,
});

const formatVoterType = (type: VoterType): VoteRecord["voterType"] => {
  switch (type) {
    case VoterType.DREP:
      return "DRep";
    case VoterType.SPO:
      return "SPO";
    case VoterType.CC:
    default:
      return "CC";
  }
};

const formatVoteChoice = (vote?: VoteType | null): VoteRecord["vote"] => {
  if (vote === VoteType.YES) {
    return "Yes";
  }
  if (vote === VoteType.NO) {
    return "No";
  }
  return "Abstain";
};

const formatVoteDate = (value?: Date | null) =>
  value ? value.toISOString() : new Date().toISOString();

const resolveVoterId = (vote: VoteWithRelations): string => {
  if (vote.voterType === VoterType.DREP) {
    return vote.drep?.drepId ?? vote.drepId ?? vote.id;
  }

  if (vote.voterType === VoterType.SPO) {
    return vote.spo?.poolId ?? vote.spoId ?? vote.id;
  }

  return vote.cc?.ccId ?? vote.ccId ?? vote.id;
};

const resolveVoterName = (vote: VoteWithRelations): string | undefined => {
  if (vote.voterType === VoterType.DREP) {
    return vote.drep?.stakeKey;
  }

  if (vote.voterType === VoterType.SPO) {
    return vote.spo?.poolName ?? vote.spo?.ticker ?? undefined;
  }

  return vote.cc?.memberName ?? undefined;
};

const mapVoteRecord = (vote: VoteWithRelations): VoteRecord => {
  const record: VoteRecord = {
    voterType: formatVoterType(vote.voterType),
    voterId: resolveVoterId(vote),
    vote: formatVoteChoice(vote.vote),
    votedAt: formatVoteDate(vote.votedAt ?? vote.createdAt ?? vote.updatedAt),
  };

  const voterName = resolveVoterName(vote);
  if (voterName) {
    record.voterName = voterName;
  }

  if (vote.votingPowerLovelace) {
    record.votingPower = vote.votingPowerLovelace;
  }

  if (vote.anchorUrl) {
    record.anchorUrl = vote.anchorUrl;
  }

  if (vote.anchorHash) {
    record.anchorHash = vote.anchorHash;
  }

  return record;
};

const parseMetadata = (metadata?: string | null) => {
  if (!metadata) {
    return undefined;
  }

  try {
    return JSON.parse(metadata);
  } catch {
    return undefined;
  }
};

const extractConstitutionality = (metadata: unknown): string | undefined => {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  if (
    "constitutionality" in metadata &&
    typeof (metadata as Record<string, unknown>).constitutionality === "string"
  ) {
    return (metadata as Record<string, string>).constitutionality;
  }

  if (
    "status" in metadata &&
    typeof (metadata as Record<string, unknown>).status === "string"
  ) {
    return (metadata as Record<string, string>).status;
  }

  return undefined;
};

const aggregateVotes = (votes: VoteWithRelations[]) => {
  const drepVotes = votes.filter((vote) => vote.voterType === VoterType.DREP);
  const spoVotes = votes.filter((vote) => vote.voterType === VoterType.SPO);
  const ccVotes = votes.filter((vote) => vote.voterType === VoterType.CC);

  const drepAdaTally = tallyAdaVotes(drepVotes);
  const spoAdaTally = tallyAdaVotes(spoVotes);
  const ccCountTally = tallyCountVotes(ccVotes);

  const drepCountTally = tallyCountVotes(drepVotes);
  const spoCountTally = tallyCountVotes(spoVotes);
  const totals = combineCountTallies(
    drepCountTally,
    spoCountTally,
    ccCountTally
  );

  return {
    drepVotes,
    spoVotes,
    ccVotes,
    drepAdaTally,
    spoAdaTally,
    ccCountTally,
    totals,
  };
};

const buildProposalIdentifier = (proposal: ProposalWithVotes) => {
  if (proposal.txHash) {
    if (proposal.certIndex !== null && proposal.certIndex !== undefined) {
      return `${proposal.txHash}:${proposal.certIndex}`;
    }
    return proposal.txHash;
  }

  return proposal.id.toString();
};

export const mapProposalToGovernanceAction = (
  proposal: ProposalWithVotes
): GovernanceAction => {
  const voteAggregation = aggregateVotes(proposal.onchainVotes ?? []);

  const drepInfo = buildVoteInfo(voteAggregation.drepAdaTally);
  const spoInfo = voteAggregation.spoVotes.length
    ? buildVoteInfo(voteAggregation.spoAdaTally)
    : undefined;
  const ccInfo = voteAggregation.ccVotes.length
    ? buildCcVoteInfo(voteAggregation.ccCountTally)
    : undefined;

  const metadata = parseMetadata(proposal.metadata);
  const constitutionality = extractConstitutionality(metadata) ?? "Unspecified";

  return {
    proposalId: buildProposalIdentifier(proposal),
    txHash: proposal.txHash,
    title: proposal.title,
    type: formatGovernanceType(proposal.governanceActionType),
    status: formatStatus(proposal.status),
    constitutionality,
    drep: drepInfo,
    ...(spoInfo && { spo: spoInfo }),
    ...(ccInfo && { cc: ccInfo }),
    submissionEpoch: proposal.submissionEpoch ?? 0,
    expiryEpoch: proposal.expiryEpoch ?? 0,
  };
};

export const mapProposalToGovernanceActionDetail = (
  proposal: ProposalWithVotes
): GovernanceActionDetail => {
  const base = mapProposalToGovernanceAction(proposal);
  const votes = proposal.onchainVotes ?? [];
  const standardVotes = votes.filter((vote) => vote.voterType !== VoterType.CC);
  const ccVotes = votes.filter((vote) => vote.voterType === VoterType.CC);

  const mappedVotes = standardVotes.map(mapVoteRecord);
  const mappedCcVotes = ccVotes.map(mapVoteRecord);

  return {
    ...base,
    description: proposal.description ?? undefined,
    rationale: proposal.rationale ?? undefined,
    votes: mappedVotes.length ? mappedVotes : undefined,
    ccVotes: mappedCcVotes.length ? mappedCcVotes : undefined,
  };
};
