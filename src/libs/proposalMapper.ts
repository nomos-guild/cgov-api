import {
  proposal,
  onchain_vote,
  governance_type,
  proposal_status,
  vote_type,
  voter_type,
  drep,
  spo,
  cc,
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
  RawVotingPowerValues,
} from "../models";

type VoteWithRelations = onchain_vote & {
  drep: drep | null;
  spo: spo | null;
  cc: cc | null;
};

export type ProposalWithVotes = proposal & {
  onchain_votes: VoteWithRelations[];
};

export const proposalWithVotesSelect = {
  id: true,
  proposal_id: true,
  tx_hash: true,
  cert_index: true,
  title: true,
  description: true,
  rationale: true,
  governance_action_type: true,
  status: true,
  submission_epoch: true,
  ratified_epoch: true,
  enacted_epoch: true,
  dropped_epoch: true,
  expired_epoch: true,
  expiration_epoch: true,
  // DRep voting power fields
  drep_total_vote_power: true,
  drep_active_yes_vote_power: true,
  drep_active_no_vote_power: true,
  drep_active_abstain_vote_power: true,
  drep_always_abstain_vote_power: true,
  drep_always_no_confidence_power: true,
  drep_inactive_vote_power: true,
  // SPO voting power fields
  spo_total_vote_power: true,
  spo_active_yes_vote_power: true,
  spo_active_no_vote_power: true,
  spo_active_abstain_vote_power: true,
  spo_always_abstain_vote_power: true,
  spo_always_no_confidence_power: true,
  metadata: true,
  created_at: true,
  updated_at: true,
  onchain_votes: {
    include: {
      drep: true,
      spo: true,
      cc: true,
    },
  },
} satisfies Prisma.proposalSelect;

interface AdaTally {
  yes: number;
  no: number;
  abstain: number;
  total: number;
}

interface CountTally extends AdaTally {}

const statusLabelMap: Record<proposal_status, GovernanceAction["status"]> = {
  ACTIVE: "Active",
  RATIFIED: "Ratified",
  ENACTED: "Enacted",
  EXPIRED: "Expired",
  CLOSED: "Closed",
};

/**
 * Maps database GovernanceType enum to full display labels
 */
const governanceTypeLabelMap: Record<governance_type, string> = {
  INFO_ACTION: "Info Action",
  TREASURY_WITHDRAWALS: "Treasury Withdrawals",
  NEW_CONSTITUTION: "New Constitution",
  HARD_FORK_INITIATION: "Hard Fork Initiation",
  PROTOCOL_PARAMETER_CHANGE: "Protocol Parameter Change",
  NO_CONFIDENCE: "No Confidence",
  UPDATE_COMMITTEE: "Update Committee",
};

const formatGovernanceType = (type?: governance_type | null): string => {
  if (!type) {
    return "Unknown";
  }
  return governanceTypeLabelMap[type] ?? "Unknown";
};

const formatStatus = (status: proposal_status) =>
  statusLabelMap[status] ?? "Active";

const percent = (value: number, total: number) =>
  total === 0 ? 0 : Number(((value / total) * 100).toFixed(2));

/**
 * Gets voting power in lovelace from a vote (BigInt stored, returned as number for tallying)
 */
const getLovelaceValue = (vote: VoteWithRelations): number => {
  if (vote.voting_power !== null && vote.voting_power !== undefined) {
    return Number(vote.voting_power);
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
    if (vote.vote === vote_type.YES) {
      totals.yes += power;
    } else if (vote.vote === vote_type.NO) {
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
    if (vote.vote === vote_type.YES) {
      totals.yes += 1;
    } else if (vote.vote === vote_type.NO) {
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
  const total = toNumber(proposal.drep_total_vote_power);
  const yes = toNumber(proposal.drep_active_yes_vote_power);
  const no = toNumber(proposal.drep_active_no_vote_power);
  const abstain = toNumber(proposal.drep_active_abstain_vote_power);
  const alwaysAbstain = toNumber(proposal.drep_always_abstain_vote_power);
  const alwaysNoConfidence = toNumber(proposal.drep_always_no_confidence_power);
  const inactive = toNumber(proposal.drep_inactive_vote_power);

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
  if (proposal.proposal_id === SPO_FORMULA_TRANSITION_GOV_ACTION) {
    return true;
  }

  // Check by submission epoch - new formula for epoch >= 534
  const submissionEpoch = proposal.submission_epoch;
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
    proposal.spo_total_vote_power === null ||
    proposal.spo_total_vote_power === undefined
  ) {
    return undefined;
  }

  // Convert to number for calculations (values are in lovelace)
  const total = toNumber(proposal.spo_total_vote_power);
  const yes = toNumber(proposal.spo_active_yes_vote_power);
  const no = toNumber(proposal.spo_active_no_vote_power);
  const abstain = toNumber(proposal.spo_active_abstain_vote_power);
  const alwaysAbstain = toNumber(proposal.spo_always_abstain_vote_power);
  const alwaysNoConfidence = toNumber(proposal.spo_always_no_confidence_power);

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
 * For ratification purposes, non-voting CC members effectively reduce the denominator
 * for Yes % calculation (since denominator = TotalMembers - AbstainCount),
 * which means they have the same effect as "No" votes on the ratification threshold.
 */
const TOTAL_CC_MEMBERS = 7;

/**
 * Build CC vote info with the formula:
 * - Explicit Abstain votes are excluded from the denominator for Yes/No percentages
 * - Yes % = YesCount / (TotalMembers - AbstainCount) × 100
 * - No % = NoCount / (TotalMembers - AbstainCount) × 100
 * - Abstain % = AbstainCount / TotalMembers × 100
 * - NotVoted % = NotVotedCount / TotalMembers × 100
 *
 * Note: For ratification purposes, non-voting CC members are effectively treated as "No" votes
 * (since they reduce the denominator for Yes % calculation), but the No % displayed here
 * only reflects explicit "No" votes.
 *
 * @param tally - The count of actual votes cast (yes, no, abstain)
 */
const buildCcVoteInfo = (tally: CountTally): CCGovernanceActionVoteInfo => {
  const { yes, no, abstain } = tally;

  // Calculate not voted members (those who haven't voted at all)
  const notVoted = Math.max(0, TOTAL_CC_MEMBERS - yes - no - abstain);

  // Denominator excludes abstain votes (as per Cardano governance rules)
  const denominator = TOTAL_CC_MEMBERS - abstain;

  // Calculate percentages
  const yesPercent = denominator > 0 ? (yes / denominator) * 100 : 0;
  const noPercent = denominator > 0 ? (no / denominator) * 100 : 0;
  const abstainPercent =
    TOTAL_CC_MEMBERS > 0 ? (abstain / TOTAL_CC_MEMBERS) * 100 : 0;
  const notVotedPercent =
    TOTAL_CC_MEMBERS > 0 ? (notVoted / TOTAL_CC_MEMBERS) * 100 : 0;

  return {
    yesPercent: Number(yesPercent.toFixed(2)),
    noPercent: Number(noPercent.toFixed(2)),
    abstainPercent: Number(abstainPercent.toFixed(2)),
    notVotedPercent: Number(notVotedPercent.toFixed(2)),
    yesCount: yes,
    noCount: no,
    abstainCount: abstain,
    notVotedCount: notVoted,
  };
};

const formatVoterType = (type: voter_type): VoteRecord["voterType"] => {
  switch (type) {
    case voter_type.DREP:
      return "DRep";
    case voter_type.SPO:
      return "SPO";
    case voter_type.CC:
    default:
      return "CC";
  }
};

const formatVoteChoice = (vote?: vote_type | null): VoteRecord["vote"] => {
  if (vote === vote_type.YES) {
    return "Yes";
  }
  if (vote === vote_type.NO) {
    return "No";
  }
  return "Abstain";
};

const formatVoteDate = (value?: Date | null) =>
  value ? value.toISOString() : new Date().toISOString();

const resolveVoterId = (vote: VoteWithRelations): string => {
  if (vote.voter_type === voter_type.DREP) {
    return vote.drep?.drep_id ?? vote.drep_id ?? vote.id;
  }

  if (vote.voter_type === voter_type.SPO) {
    return vote.spo?.pool_id ?? vote.spo_id ?? vote.id;
  }

  return vote.cc?.cc_id ?? vote.cc_id ?? vote.id;
};

/**
 * Gets the timestamp for a vote, preferring voted_at, then created_at, then updated_at
 */
const getVoteTimestamp = (vote: VoteWithRelations): Date => {
  return (
    vote.voted_at ??
    vote.created_at ??
    vote.updated_at ??
    new Date(0)
  );
};

/**
 * Filters CC votes to only include the most recent vote per CC member.
 * When a CC member changes their vote, only their latest vote is counted.
 */
const getLatestCcVotes = (ccVotes: VoteWithRelations[]): VoteWithRelations[] => {
  // Group votes by CC member ID
  const votesByMember = new Map<string, VoteWithRelations[]>();

  for (const vote of ccVotes) {
    const ccId = resolveVoterId(vote);
    const existing = votesByMember.get(ccId) ?? [];
    existing.push(vote);
    votesByMember.set(ccId, existing);
  }

  // For each CC member, get their most recent vote
  const latestVotes: VoteWithRelations[] = [];
  for (const [, votes] of votesByMember.entries()) {
    if (votes.length === 1) {
      // Only one vote, use it
      latestVotes.push(votes[0]);
    } else {
      // Multiple votes - find the most recent one
      const mostRecent = votes.reduce((latest, current) => {
        const latestTime = getVoteTimestamp(latest);
        const currentTime = getVoteTimestamp(current);
        return currentTime > latestTime ? current : latest;
      });
      latestVotes.push(mostRecent);
    }
  }

  return latestVotes;
};

const resolveVoterName = (vote: VoteWithRelations): string | undefined => {
  if (vote.voter_type === voter_type.DREP) {
    // Prefer the DRep's display name, falling back to their payment address if available
    return vote.drep?.name ?? vote.drep?.payment_addr ?? undefined;
  }

  if (vote.voter_type === voter_type.SPO) {
    return vote.spo?.pool_name ?? vote.spo?.ticker ?? undefined;
  }

  return vote.cc?.member_name ?? undefined;
};

const mapVoteRecord = (vote: VoteWithRelations): VoteRecord => {
  const record: VoteRecord = {
    txHash: vote.tx_hash,
    voterType: formatVoterType(vote.voter_type),
    voterId: resolveVoterId(vote),
    vote: formatVoteChoice(vote.vote),
    votedAt: formatVoteDate(
      vote.voted_at ?? vote.created_at ?? vote.updated_at
    ),
  };

  const voterName = resolveVoterName(vote);
  if (voterName) {
    record.voterName = voterName;
  }

  // votingPower is stored as BigInt in lovelace, convert to string for API response
  if (vote.voting_power !== null && vote.voting_power !== undefined) {
    record.votingPower = vote.voting_power.toString();
  }

  if (vote.anchor_url) {
    record.anchorUrl = vote.anchor_url;
  }

  if (vote.anchor_hash) {
    record.anchorHash = vote.anchor_hash;
  }

  // Rationale/metadata JSON for this specific vote (stored as string in DB)
  if (vote.rationale) {
    record.rationale = vote.rationale;
  }

  return record;
};

/**
 * Determines constitutionality based on CC (Constitutional Committee) voting results
 * A proposal is considered "Constitutional" if it receives ≥67% "Yes" votes from CC members
 *
 * Formula (same as buildCcVoteInfo):
 * - Explicit Abstain is excluded from the denominator
 * - Yes % = YesCount / (TotalMembers - AbstainCount) × 100
 * - Non-voting CC members effectively reduce the denominator (same effect as "No" votes)
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
  const drepVotes = votes.filter((vote) => vote.voter_type === voter_type.DREP);
  const spoVotes = votes.filter((vote) => vote.voter_type === voter_type.SPO);
  const allCcVotes = votes.filter((vote) => vote.voter_type === voter_type.CC);

  // Filter CC votes to only include the most recent vote per CC member
  // This handles cases where CC members change their vote
  const ccVotes = getLatestCcVotes(allCcVotes);

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
const VOTING_THRESHOLDS: Record<governance_type, VotingThreshold> = {
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
  governanceType: governance_type | null | undefined
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
  // Use the proposal_id field from the database (Cardano governance action ID)
  if (proposal.proposal_id) {
    return proposal.proposal_id;
  }

  // Fallback to tx_hash:cert_index format if proposal_id is not available
  if (proposal.tx_hash) {
    if (proposal.cert_index !== null && proposal.cert_index !== undefined) {
      return `${proposal.tx_hash}:${proposal.cert_index}`;
    }
    return proposal.tx_hash;
  }

  return proposal.id.toString();
};

export const mapProposalToGovernanceAction = (
  proposal: ProposalWithVotes
): GovernanceAction => {
  const voteAggregation = aggregateVotes(proposal.onchain_votes ?? []);

  // Use new voting power-based calculations if data is available, otherwise fall back to vote tally
  const hasDrepVotingPowerData =
    proposal.drep_total_vote_power !== null &&
    proposal.drep_total_vote_power !== undefined;
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
  const hash = proposal.cert_index
    ? `${proposal.tx_hash}:${proposal.cert_index}`
    : proposal.tx_hash;

  // Get voting thresholds based on governance action type
  const threshold = getVotingThreshold(proposal.governance_action_type);

  // Determine voting status for each voter type
  const votingStatus = determineVotingStatus(threshold, drepInfo, spoInfo, ccInfo);

  // Determine if proposal is passing overall
  const passing = isProposalPassing(votingStatus);

  const rawVotingPowerValues: RawVotingPowerValues = {
    drep_total_vote_power: proposal.drep_total_vote_power?.toString() ?? null,
    drep_active_yes_vote_power:
      proposal.drep_active_yes_vote_power?.toString() ?? null,
    drep_active_no_vote_power:
      proposal.drep_active_no_vote_power?.toString() ?? null,
    drep_active_abstain_vote_power:
      proposal.drep_active_abstain_vote_power?.toString() ?? null,
    drep_always_abstain_vote_power:
      proposal.drep_always_abstain_vote_power?.toString() ?? null,
    drep_always_no_confidence_power:
      proposal.drep_always_no_confidence_power?.toString() ?? null,
    drep_inactive_vote_power:
      proposal.drep_inactive_vote_power?.toString() ?? null,
    spo_total_vote_power: proposal.spo_total_vote_power?.toString() ?? null,
    spo_active_yes_vote_power:
      proposal.spo_active_yes_vote_power?.toString() ?? null,
    spo_active_no_vote_power:
      proposal.spo_active_no_vote_power?.toString() ?? null,
    spo_active_abstain_vote_power:
      proposal.spo_active_abstain_vote_power?.toString() ?? null,
    spo_always_abstain_vote_power:
      proposal.spo_always_abstain_vote_power?.toString() ?? null,
    spo_always_no_confidence_power:
      proposal.spo_always_no_confidence_power?.toString() ?? null,
  };

  return {
    proposalId: buildProposalIdentifier(proposal),
    hash,
    title: proposal.title,
    type: formatGovernanceType(proposal.governance_action_type),
    status: formatStatus(proposal.status),
    constitutionality,
    drep: drepInfo,
    spo: spoInfo,
    cc: ccInfo,
    totalYes: voteAggregation.totals.yes,
    totalNo: voteAggregation.totals.no,
    totalAbstain: voteAggregation.totals.abstain,
    submissionEpoch: proposal.submission_epoch ?? 0,
    expiryEpoch: proposal.expiration_epoch ?? 0,
    threshold,
    votingStatus,
    passing,
    rawVotingPowerValues,
  };
};

export const mapProposalToGovernanceActionDetail = (
  proposal: ProposalWithVotes
): GovernanceActionDetail => {
  // Extract references from CIP-108 metadata (if present)
  let references: GovernanceActionDetail["references"];

  if (proposal.metadata) {
    try {
      const parsed = JSON.parse(proposal.metadata as unknown as string) as {
        body?: { references?: unknown };
        [key: string]: unknown;
      };

      const maybeRefs = parsed?.body?.references;
      if (Array.isArray(maybeRefs)) {
        // Pass through as-is; shape is described by GovernanceActionReference
        references = maybeRefs as GovernanceActionDetail["references"];
      }
    } catch {
      // If metadata is not valid JSON, ignore and leave references undefined
    }
  }

  const base = mapProposalToGovernanceAction(proposal);
  const votes = proposal.onchain_votes ?? [];
  const standardVotes = votes.filter((vote) => vote.voter_type !== voter_type.CC);
  const allCcVotes = votes.filter((vote) => vote.voter_type === voter_type.CC);
  
  // Filter CC votes to only include the most recent vote per CC member
  // This ensures the detail view also shows only final votes
  const ccVotes = getLatestCcVotes(allCcVotes);

  const mappedVotes = standardVotes.map(mapVoteRecord);
  const mappedCcVotes = ccVotes.map(mapVoteRecord);

  return {
    ...base,
    description: proposal.description ?? undefined,
    rationale: proposal.rationale ?? undefined,
    votes: mappedVotes.length ? mappedVotes : undefined,
    ccVotes: mappedCcVotes.length ? mappedCcVotes : undefined,
    references,
  };
};