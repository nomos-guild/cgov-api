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
  VotingThreshold,
  VotingStatus,
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
  proposalId: true,
  txHash: true,
  certIndex: true,
  title: true,
  description: true,
  rationale: true,
  governanceActionType: true,
  status: true,
  submissionEpoch: true,
  ratifiedEpoch: true,
  enactedEpoch: true,
  droppedEpoch: true,
  expiredEpoch: true,
  expirationEpoch: true,
  // DRep voting power fields
  drepTotalVotePower: true,
  drepActiveYesVotePower: true,
  drepActiveNoVotePower: true,
  drepActiveAbstainVotePower: true,
  drepAlwaysAbstainVotePower: true,
  drepAlwaysNoConfidenceVotePower: true,
  drepInactiveVotePower: true,
  // SPO voting power fields
  spoTotalVotePower: true,
  spoActiveYesVotePower: true,
  spoActiveNoVotePower: true,
  spoActiveAbstainVotePower: true,
  spoAlwaysAbstainVotePower: true,
  spoAlwaysNoConfidenceVotePower: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
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
  ENACTED: "Enacted",
  EXPIRED: "Expired",
  CLOSED: "Closed",
};

/**
 * Maps database GovernanceType enum to full display labels
 */
const governanceTypeLabelMap: Record<GovernanceType, string> = {
  INFO_ACTION: "Info Action",
  TREASURY_WITHDRAWALS: "Treasury Withdrawals",
  NEW_CONSTITUTION: "New Constitution",
  HARD_FORK_INITIATION: "Hard Fork Initiation",
  PROTOCOL_PARAMETER_CHANGE: "Protocol Parameter Change",
  NO_CONFIDENCE: "No Confidence",
  UPDATE_COMMITTEE: "Update Committee",
};

const formatGovernanceType = (type?: GovernanceType | null): string => {
  if (!type) {
    return "Unknown";
  }
  return governanceTypeLabelMap[type] ?? "Unknown";
};

const formatStatus = (status: ProposalStatus) =>
  statusLabelMap[status] ?? "Active";

const percent = (value: number, total: number) =>
  total === 0 ? 0 : Number(((value / total) * 100).toFixed(2));

/**
 * Gets voting power in lovelace from a vote (BigInt stored, returned as number for tallying)
 */
const getLovelaceValue = (vote: VoteWithRelations): number => {
  if (vote.votingPower !== null && vote.votingPower !== undefined) {
    return Number(vote.votingPower);
  }
  return 0;
};

/**
 * Tallies voting power in lovelace for each vote type
 */
const tallyLovelaceVotes = (votes: VoteWithRelations[]): AdaTally => {
  const totals: AdaTally = { yes: 0, no: 0, abstain: 0, total: 0 };

  for (const vote of votes) {
    const power = getLovelaceValue(vote);
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

/**
 * Helper to safely convert BigInt or number to number for calculations
 * Accepts both types for compatibility during schema migration
 */
const toNumber = (value: bigint | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  return Number(value);
};

/**
 * Calculate DRep vote info using the new formula:
 * - Not Voted = Total - Yes - No - Abstain - AlwaysAbstain - AlwaysNoConfidence - Inactive
 * - Yes % = Yes / (Yes + No + AlwaysNoConfidence + NotVoted)
 * - No % = (No + AlwaysNoConfidence + NotVoted) / (Yes + No + AlwaysNoConfidence + NotVoted)
 *
 * All values from proposal are stored in lovelace (BigInt), returned as lovelace strings
 */
const buildDrepVoteInfo = (
  proposal: ProposalWithVotes
): GovernanceActionVoteInfo => {
  // Convert to number for calculations (values are in lovelace)
  const total = toNumber(proposal.drepTotalVotePower);
  const yes = toNumber(proposal.drepActiveYesVotePower);
  const no = toNumber(proposal.drepActiveNoVotePower);
  const abstain = toNumber(proposal.drepActiveAbstainVotePower);
  const alwaysAbstain = toNumber(proposal.drepAlwaysAbstainVotePower);
  const alwaysNoConfidence = toNumber(proposal.drepAlwaysNoConfidenceVotePower);
  const inactive = toNumber(proposal.drepInactiveVotePower);

  // Calculate "Not Voted" power
  const notVoted =
    total - yes - no - abstain - alwaysAbstain - alwaysNoConfidence - inactive;

  // Denominator for percentage calculation (excludes abstain and inactive)
  const denominator = yes + no + alwaysNoConfidence + Math.max(0, notVoted);

  // Calculate percentages
  const yesPercent = denominator > 0 ? (yes / denominator) * 100 : 0;
  const noPercent =
    denominator > 0
      ? ((no + alwaysNoConfidence + Math.max(0, notVoted)) / denominator) * 100
      : 0;
  const abstainPercent =
    total > 0 ? ((abstain + alwaysAbstain) / total) * 100 : 0;

  // Return lovelace values as strings
  return {
    yesPercent: Number(yesPercent.toFixed(2)),
    noPercent: Number(noPercent.toFixed(2)),
    abstainPercent: Number(abstainPercent.toFixed(2)),
    yesLovelace: Math.round(yes).toString(),
    noLovelace: Math.round(
      no + alwaysNoConfidence + Math.max(0, notVoted)
    ).toString(),
    abstainLovelace: Math.round(abstain + alwaysAbstain).toString(),
  };
};

/**
 * The governance action ID that marks the transition to the new SPO voting formula.
 * This is the "Hard Fork to Protocol Version 10 (Plomin Hard Fork)" governance action.
 * Starting from this governance action (inclusive), NotVoted power is included in calculations.
 * Before this governance action, NotVoted power is NOT included.
 *
 * The submission epoch for this governance action is 534.
 */
const SPO_FORMULA_TRANSITION_GOV_ACTION =
  "gov_action1pvv5wmjqhwa4u85vu9f4ydmzu2mgt8n7et967ph2urhx53r70xusqnmm525";
const SPO_FORMULA_TRANSITION_EPOCH = 534;

/**
 * Determines if a proposal should use the new SPO voting formula.
 * The new formula (which includes NotVoted power) applies to:
 * - The Plomin Hard Fork governance action itself
 * - Any governance action submitted on or after the Plomin Hard Fork epoch (534)
 *
 * @param proposal - The proposal to check
 * @returns true if the new formula should be used, false for old formula
 */
const shouldUseNewSpoFormula = (proposal: ProposalWithVotes): boolean => {
  // Check if this is the transition governance action itself
  if (proposal.proposalId === SPO_FORMULA_TRANSITION_GOV_ACTION) {
    return true;
  }

  // Check by submission epoch - new formula for epoch >= 534
  const submissionEpoch = proposal.submissionEpoch;
  if (submissionEpoch !== null && submissionEpoch !== undefined) {
    return submissionEpoch >= SPO_FORMULA_TRANSITION_EPOCH;
  }

  // If no submission epoch data, default to old formula for safety
  return false;
};

/**
 * Calculate SPO vote info using the formula:
 *
 * For governance actions starting from gov_action1pvv5wmjqhwa4u85vu9f4ydmzu2mgt8n7et967ph2urhx53r70xusqnmm525 (epoch 534):
 * - NotVoted = Total - Yes - No - Abstain - AlwaysAbstain - AlwaysNoConfidence
 * - Yes % = Yes / (Yes + No + AlwaysNoConfidence + NotVoted)
 * - No % = (No + AlwaysNoConfidence + NotVoted) / (Yes + No + AlwaysNoConfidence + NotVoted)
 *
 * For governance actions before epoch 534:
 * - Yes % = Yes / (Yes + No + AlwaysNoConfidence)
 * - No % = (No + AlwaysNoConfidence) / (Yes + No + AlwaysNoConfidence)
 *
 * All values from proposal are stored in lovelace (BigInt), returned as lovelace strings
 */
const buildSpoVoteInfo = (
  proposal: ProposalWithVotes
): GovernanceActionVoteInfo | undefined => {
  // If no SPO voting power data, return undefined
  if (
    proposal.spoTotalVotePower === null ||
    proposal.spoTotalVotePower === undefined
  ) {
    return undefined;
  }

  // Convert to number for calculations (values are in lovelace)
  const total = toNumber(proposal.spoTotalVotePower);
  const yes = toNumber(proposal.spoActiveYesVotePower);
  const no = toNumber(proposal.spoActiveNoVotePower);
  const abstain = toNumber(proposal.spoActiveAbstainVotePower);
  const alwaysAbstain = toNumber(proposal.spoAlwaysAbstainVotePower);
  const alwaysNoConfidence = toNumber(proposal.spoAlwaysNoConfidenceVotePower);

  // Calculate "Not Voted" power
  const notVoted = total - yes - no - abstain - alwaysAbstain - alwaysNoConfidence;

  // Determine if this governance action uses the new formula (includes NotVoted)
  const useNewFormula = shouldUseNewSpoFormula(proposal);

  let denominator: number;
  let noTotal: number;

  if (useNewFormula) {
    // New formula: includes NotVoted in denominator and No calculation
    denominator = yes + no + alwaysNoConfidence + Math.max(0, notVoted);
    noTotal = no + alwaysNoConfidence + Math.max(0, notVoted);
  } else {
    // Old formula: excludes NotVoted
    denominator = yes + no + alwaysNoConfidence;
    noTotal = no + alwaysNoConfidence;
  }

  // Calculate percentages
  const yesPercent = denominator > 0 ? (yes / denominator) * 100 : 0;
  const noPercent = denominator > 0 ? (noTotal / denominator) * 100 : 0;
  const abstainPercent =
    total > 0 ? ((abstain + alwaysAbstain) / total) * 100 : 0;

  // Return lovelace values as strings
  return {
    yesPercent: Number(yesPercent.toFixed(2)),
    noPercent: Number(noPercent.toFixed(2)),
    abstainPercent: Number(abstainPercent.toFixed(2)),
    yesLovelace: Math.round(yes).toString(),
    noLovelace: Math.round(noTotal).toString(),
    abstainLovelace: Math.round(abstain + alwaysAbstain).toString(),
  };
};

/**
 * Build vote info from tally (values are already in lovelace)
 */
const buildVoteInfo = (tally: AdaTally): GovernanceActionVoteInfo => ({
  yesPercent: percent(tally.yes, tally.total),
  noPercent: percent(tally.no, tally.total),
  abstainPercent: percent(tally.abstain, tally.total),
  yesLovelace: Math.round(tally.yes).toString(),
  noLovelace: Math.round(tally.no).toString(),
  abstainLovelace: Math.round(tally.abstain).toString(),
});

/**
 * Total number of Constitutional Committee members
 * Non-voting CC members are treated as "No" votes for ratification purposes
 */
const TOTAL_CC_MEMBERS = 7;

/**
 * Build CC vote info with the formula:
 * - Non-voting CC members are treated as "No" votes
 * - Explicit Abstain is NOT counted as No, but excluded from the denominator
 * - Yes % = YesCount / (TotalMembers - AbstainCount) × 100
 * - No % = (NoCount + NotVoted) / (TotalMembers - AbstainCount) × 100
 *
 * @param tally - The count of actual votes cast (yes, no, abstain)
 */
const buildCcVoteInfo = (tally: CountTally): CCGovernanceActionVoteInfo => {
  const { yes, no, abstain } = tally;

  // Calculate not voted members (those who haven't voted at all)
  const notVoted = Math.max(0, TOTAL_CC_MEMBERS - yes - no - abstain);

  // Effective "No" includes explicit No votes plus non-voters
  const effectiveNo = no + notVoted;

  // Denominator excludes abstain votes (as per Cardano governance rules)
  const denominator = TOTAL_CC_MEMBERS - abstain;

  // Calculate percentages
  const yesPercent = denominator > 0 ? (yes / denominator) * 100 : 0;
  const noPercent = denominator > 0 ? (effectiveNo / denominator) * 100 : 0;
  const abstainPercent =
    TOTAL_CC_MEMBERS > 0 ? (abstain / TOTAL_CC_MEMBERS) * 100 : 0;

  return {
    yesPercent: Number(yesPercent.toFixed(2)),
    noPercent: Number(noPercent.toFixed(2)),
    abstainPercent: Number(abstainPercent.toFixed(2)),
    yesCount: yes,
    noCount: effectiveNo, // Includes non-voters
    abstainCount: abstain,
  };
};

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
    // Prefer the DRep's display name, falling back to their payment address if available
    return vote.drep?.name ?? vote.drep?.paymentAddress ?? undefined;
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

  // votingPower is stored as BigInt in lovelace, convert to string for API response
  if (vote.votingPower !== null && vote.votingPower !== undefined) {
    record.votingPower = vote.votingPower.toString();
  }

  if (vote.anchorUrl) {
    record.anchorUrl = vote.anchorUrl;
  }

  if (vote.anchorHash) {
    record.anchorHash = vote.anchorHash;
  }

  return record;
};

/**
 * Determines constitutionality based on CC (Constitutional Committee) voting results
 * A proposal is considered "Constitutional" if it receives ≥67% "Yes" votes from CC members
 *
 * Formula (same as buildCcVoteInfo):
 * - Non-voting CC members are treated as "No" votes
 * - Explicit Abstain is excluded from the denominator
 * - Yes % = YesCount / (TotalMembers - AbstainCount) × 100
 *
 * @param ccCountTally - The CC vote count tally
 * @returns "Constitutional", "Unconstitutional", or "Pending" if no CC votes yet
 */
const determineConstitutionality = (ccCountTally: CountTally): string => {
  const { yes, no, abstain } = ccCountTally;
  const totalVotesCast = yes + no + abstain;

  // If no CC votes yet
  if (totalVotesCast === 0) {
    return "Pending";
  }

  // Denominator excludes abstain votes (as per Cardano governance rules)
  const denominator = TOTAL_CC_MEMBERS - abstain;

  // Calculate yes percentage
  const yesPercent = denominator > 0 ? (yes / denominator) * 100 : 0;

  // ≥67% threshold for constitutional approval
  if (yesPercent >= 67) {
    return "Constitutional";
  }

  return "Unconstitutional";
};

const aggregateVotes = (votes: VoteWithRelations[]) => {
  const drepVotes = votes.filter((vote) => vote.voterType === VoterType.DREP);
  const spoVotes = votes.filter((vote) => vote.voterType === VoterType.SPO);
  const ccVotes = votes.filter((vote) => vote.voterType === VoterType.CC);

  // Tally voting power in lovelace
  const drepLovelaceTally = tallyLovelaceVotes(drepVotes);
  const spoLovelaceTally = tallyLovelaceVotes(spoVotes);
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
    drepLovelaceTally,
    spoLovelaceTally,
    ccCountTally,
    totals,
  };
};

/**
 * Voting thresholds per governance action type
 * Based on Cardano governance specifications:
 * - CC threshold: 2/3 majority required (null if CC doesn't vote)
 * - DRep threshold: varies by action type
 * - SPO threshold: varies by action type (null if SPO doesn't vote)
 *
 * Note: Protocol Parameter Change has sub-types with different thresholds,
 * but we don't have sub-type information from Koios, so we use the most common threshold (0.67)
 */
const VOTING_THRESHOLDS: Record<GovernanceType, VotingThreshold> = {
  // 1. Motion of no-confidence: CC doesn't vote, DRep 0.67, SPO 0.51
  NO_CONFIDENCE: {
    ccThreshold: null,
    drepThreshold: 0.67,
    spoThreshold: 0.51,
  },
  // 2. Update committee: CC doesn't vote (in normal state), DRep 0.67, SPO 0.51
  // Note: In state of no-confidence, thresholds change to DRep 0.60, SPO 0.51
  // We use normal state thresholds as default
  UPDATE_COMMITTEE: {
    ccThreshold: null,
    drepThreshold: 0.67,
    spoThreshold: 0.51,
  },
  // 3. New Constitution or Guardrails Script: CC 2/3, DRep 0.75, SPO doesn't vote
  NEW_CONSTITUTION: {
    ccThreshold: 0.67,
    drepThreshold: 0.75,
    spoThreshold: null,
  },
  // 4. Hard-fork initiation: CC 2/3, DRep 0.60, SPO 0.51
  HARD_FORK_INITIATION: {
    ccThreshold: 0.67,
    drepThreshold: 0.60,
    spoThreshold: 0.51,
  },
  // 5. Protocol parameter changes: CC 2/3, DRep 0.67 (varies by group), SPO doesn't vote
  // Note: Different parameter groups have different thresholds (0.67, 0.75)
  // Using 0.67 as default since we don't have sub-type information
  PROTOCOL_PARAMETER_CHANGE: {
    ccThreshold: 0.67,
    drepThreshold: 0.67,
    spoThreshold: null,
  },
  // 6. Treasury withdrawal: CC 2/3, DRep 0.67, SPO doesn't vote
  TREASURY_WITHDRAWALS: {
    ccThreshold: 0.67,
    drepThreshold: 0.67,
    spoThreshold: null,
  },
  // 7. Info action: CC 2/3, DRep 1.0 (100%), SPO 1.0 (100%)
  // Note: Info actions cannot be ratified, these thresholds are for display only
  INFO_ACTION: {
    ccThreshold: 0.67,
    drepThreshold: 1.0,
    spoThreshold: 1.0,
  },
};

/**
 * Get voting threshold for a governance action type
 */
const getVotingThreshold = (
  governanceType: GovernanceType | null | undefined
): VotingThreshold => {
  if (!governanceType) {
    // Default to Info Action thresholds for unknown types
    return VOTING_THRESHOLDS.INFO_ACTION;
  }
  return VOTING_THRESHOLDS[governanceType] ?? VOTING_THRESHOLDS.INFO_ACTION;
};

/**
 * Evaluate if a voter type meets its threshold
 * Returns true if yesPercent >= threshold * 100
 */
const evaluateThreshold = (
  yesPercent: number,
  threshold: number | null
): boolean | null => {
  if (threshold === null) {
    return null; // This voter type doesn't participate
  }
  return yesPercent >= threshold * 100;
};

/**
 * Determine voting status for all voter types
 */
const determineVotingStatus = (
  threshold: VotingThreshold,
  drepInfo: GovernanceActionVoteInfo,
  spoInfo: GovernanceActionVoteInfo | undefined,
  ccInfo: CCGovernanceActionVoteInfo | undefined
): VotingStatus => {
  // DRep always participates
  const drepPassing = evaluateThreshold(drepInfo.yesPercent, threshold.drepThreshold) ?? false;

  // SPO may or may not participate
  const spoPassing =
    threshold.spoThreshold === null
      ? null
      : spoInfo
        ? evaluateThreshold(spoInfo.yesPercent, threshold.spoThreshold)
        : false;

  // CC may or may not participate
  const ccPassing =
    threshold.ccThreshold === null
      ? null
      : ccInfo
        ? evaluateThreshold(ccInfo.yesPercent, threshold.ccThreshold)
        : false;

  return {
    ccPassing,
    drepPassing,
    spoPassing,
  };
};

/**
 * Determine if the proposal is passing overall
 * A proposal passes if ALL required voter types meet their thresholds
 */
const isProposalPassing = (votingStatus: VotingStatus): boolean => {
  // DRep must pass (always required)
  if (!votingStatus.drepPassing) {
    return false;
  }

  // SPO must pass if required (not null)
  if (votingStatus.spoPassing === false) {
    return false;
  }

  // CC must pass if required (not null)
  if (votingStatus.ccPassing === false) {
    return false;
  }

  return true;
};

const buildProposalIdentifier = (proposal: ProposalWithVotes) => {
  // Use the proposalId field from the database (Cardano governance action ID)
  if (proposal.proposalId) {
    return proposal.proposalId;
  }

  // Fallback to txHash:certIndex format if proposalId is not available
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

  // Use new voting power-based calculations if data is available, otherwise fall back to vote tally
  const hasDrepVotingPowerData =
    proposal.drepTotalVotePower !== null &&
    proposal.drepTotalVotePower !== undefined;
  const drepInfo = hasDrepVotingPowerData
    ? buildDrepVoteInfo(proposal)
    : buildVoteInfo(voteAggregation.drepLovelaceTally);

  // SPO info uses new formula if voting power data exists
  const spoInfo =
    buildSpoVoteInfo(proposal) ??
    (voteAggregation.spoVotes.length
      ? buildVoteInfo(voteAggregation.spoLovelaceTally)
      : undefined);

  const ccInfo = voteAggregation.ccVotes.length
    ? buildCcVoteInfo(voteAggregation.ccCountTally)
    : undefined;

  // Determine constitutionality based on CC voting results (≥67% Yes = Constitutional)
  const constitutionality = determineConstitutionality(
    voteAggregation.ccCountTally
  );

  // Build hash field (txHash:certIndex format)
  const hash = proposal.certIndex
    ? `${proposal.txHash}:${proposal.certIndex}`
    : proposal.txHash;

  // Get voting thresholds based on governance action type
  const threshold = getVotingThreshold(proposal.governanceActionType);

  // Determine voting status for each voter type
  const votingStatus = determineVotingStatus(threshold, drepInfo, spoInfo, ccInfo);

  // Determine if proposal is passing overall
  const passing = isProposalPassing(votingStatus);

  return {
    proposalId: buildProposalIdentifier(proposal),
    hash,
    title: proposal.title,
    type: formatGovernanceType(proposal.governanceActionType),
    status: formatStatus(proposal.status),
    constitutionality,
    drep: drepInfo,
    spo: spoInfo,
    cc: ccInfo,
    totalYes: voteAggregation.totals.yes,
    totalNo: voteAggregation.totals.no,
    totalAbstain: voteAggregation.totals.abstain,
    submissionEpoch: proposal.submissionEpoch ?? 0,
    expiryEpoch: proposal.expirationEpoch ?? 0,
    threshold,
    votingStatus,
    passing,
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
