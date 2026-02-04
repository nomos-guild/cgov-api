import {
  Proposal,
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
  RawVotingPowerValues,
  VoteBreakdown,
} from "../models";

// Partial types for vote relations - only the fields we select
type PartialDrep = Pick<Drep, "drepId" | "name" | "paymentAddr">;
type PartialSPO = Pick<SPO, "poolId" | "poolName" | "ticker">;
type PartialCC = Pick<CC, "ccId" | "memberName">;

type VoteWithRelations = OnchainVote & {
  drep: PartialDrep | null;
  spo: PartialSPO | null;
  cc: PartialCC | null;
};

export type ProposalWithVotes = Proposal & {
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
  drepAlwaysNoConfidencePower: true,
  drepInactiveVotePower: true,
  // SPO voting power fields
  spoTotalVotePower: true,
  spoActiveYesVotePower: true,
  spoActiveNoVotePower: true,
  spoActiveAbstainVotePower: true,
  spoAlwaysAbstainVotePower: true,
  spoAlwaysNoConfidencePower: true,
  spoNoVotePower: true, // Koios pool_no_vote_power (includes notVoted)
  metadata: true,
  createdAt: true,
  updatedAt: true,
  onchainVotes: {
    include: {
      // Only select fields actually used in vote mapping
      drep: { select: { drepId: true, name: true, paymentAddr: true } },
      spo: { select: { poolId: true, poolName: true, ticker: true } },
      cc: { select: { ccId: true, memberName: true } },
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
 * Calculate DRep vote info using the formula:
 * - Not Voted = Total - Yes - No - Abstain - AlwaysAbstain - AlwaysNoConfidence - Inactive
 *
 * For NO_CONFIDENCE governance actions:
 * - Yes = Yes + AlwaysNoConfidence (AlwaysNoConfidence voters support "No Confidence" motions)
 * - No = No + NotVoted
 *
 * For all other governance actions:
 * - Yes = Yes
 * - No = No + AlwaysNoConfidence + NotVoted
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
  const alwaysNoConfidence = toNumber(proposal.drepAlwaysNoConfidencePower);
  const inactive = toNumber(proposal.drepInactiveVotePower);

  // Calculate "Not Voted" power
  const notVoted =
    total - yes - no - abstain - alwaysAbstain - alwaysNoConfidence - inactive;

  // Check if this is a No Confidence governance action
  const isNoConfidence =
    proposal.governanceActionType === GovernanceType.NO_CONFIDENCE;

  // Calculate yes/no totals based on governance action type
  let yesTotal: number;
  let noTotal: number;

  if (isNoConfidence) {
    // For No Confidence actions: AlwaysNoConfidence voters count as YES
    yesTotal = yes + alwaysNoConfidence;
    noTotal = no + Math.max(0, notVoted);
  } else {
    // For all other actions: AlwaysNoConfidence voters count as NO
    yesTotal = yes;
    noTotal = no + alwaysNoConfidence + Math.max(0, notVoted);
  }

  // Denominator for percentage calculation (excludes abstain and inactive)
  const denominator = yesTotal + noTotal;

  // Calculate percentages
  const yesPercent = denominator > 0 ? (yesTotal / denominator) * 100 : 0;
  const noPercent = denominator > 0 ? (noTotal / denominator) * 100 : 0;
  const abstainPercent =
    total > 0 ? ((abstain + alwaysAbstain) / total) * 100 : 0;

  // Build breakdown for pie chart display
  const breakdown: VoteBreakdown = {
    activeYes: Math.round(yes).toString(),
    activeNo: Math.round(no).toString(),
    activeAbstain: Math.round(abstain).toString(),
    alwaysAbstain: Math.round(alwaysAbstain).toString(),
    alwaysNoConfidence: Math.round(alwaysNoConfidence).toString(),
    inactive: Math.round(inactive).toString(),
    notVoted: Math.round(Math.max(0, notVoted)).toString(),
  };

  // Return lovelace values as strings
  return {
    yesPercent: Number(yesPercent.toFixed(2)),
    noPercent: Number(noPercent.toFixed(2)),
    abstainPercent: Number(abstainPercent.toFixed(2)),
    yesLovelace: Math.round(yesTotal).toString(),
    noLovelace: Math.round(noTotal).toString(),
    abstainLovelace: Math.round(abstain + alwaysAbstain).toString(),
    breakdown,
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
 * Calculate SPO vote info using the Cardano ledger formula:
 *
 * Base formula: Yes % = yesTotal / (total - abstainTotal) × 100
 *
 * For epoch >= 534, the formula varies by governance action type:
 *
 * HARD_FORK_INITIATION:
 * - yesTotal = yes
 * - abstainTotal = abstain (only explicit abstain votes)
 * - notVoted = total - yes - no - abstain (includes alwaysNoConfidence + alwaysAbstain)
 *
 * NO_CONFIDENCE:
 * - yesTotal = yes + alwaysNoConfidence (AlwaysNoConfidence counts as Yes)
 * - abstainTotal = abstain + alwaysAbstain
 * - notVoted = total - yes - no - abstain - alwaysAbstain - alwaysNoConfidence
 *
 * Other actions:
 * - yesTotal = yes
 * - abstainTotal = abstain + alwaysAbstain
 * - notVoted = total - yes - no - abstain - alwaysAbstain - alwaysNoConfidence
 *
 * For all action types: noTotal = no + notVoted
 *
 * For epoch < 534 (unchanged):
 * - Denominator: yes + no + alwaysNoConfidence
 * - yesTotal: yes
 * - noTotal: no + alwaysNoConfidence
 * - abstainTotal: abstain + alwaysAbstain
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
  const storedTotal = toNumber(proposal.spoTotalVotePower);
  const yes = toNumber(proposal.spoActiveYesVotePower);
  const no = toNumber(proposal.spoActiveNoVotePower);
  const abstain = toNumber(proposal.spoActiveAbstainVotePower);
  const alwaysAbstain = toNumber(proposal.spoAlwaysAbstainVotePower);
  const alwaysNoConfidence = toNumber(proposal.spoAlwaysNoConfidencePower);

  // Koios pool_no_vote_power (includes notVoted + alwaysNoConfidence + explicit no)
  const koiosNoVotePower = toNumber(proposal.spoNoVotePower);

  let effectiveTotal: number;
  let notVotedFromKoios: number;

  // PRIORITY: Use Koios pool_no_vote_power if available for consistent data
  // This ensures all values come from the same epoch snapshot
  if (proposal.spoNoVotePower !== null && proposal.spoNoVotePower !== undefined) {
    // Derive notVoted from Koios: pool_no_vote_power - explicit_no - alwaysNoConfidence
    notVotedFromKoios = koiosNoVotePower - no - alwaysNoConfidence;

    // Calculate effectiveTotal from consistent Koios data
    // effectiveTotal = yes + koiosNoVotePower + abstain + alwaysAbstain
    // (koiosNoVotePower already includes: no + alwaysNoConfidence + notVoted)
    effectiveTotal = yes + koiosNoVotePower + abstain + alwaysAbstain;
  } else {
    // FALLBACK: Use old logic for historical data without Koios pool_no_vote_power
    const breakdownSum = yes + no + abstain + alwaysAbstain + alwaysNoConfidence;

    // Detect and log data inconsistency (breakdown > total indicates epoch mismatch)
    if (breakdownSum > storedTotal && storedTotal > 0) {
      console.warn(
        `[SPO Vote] Data inconsistency detected: breakdown sum (${breakdownSum}) > total (${storedTotal}) for proposal`
      );
    }

    // Use effective total to ensure consistent calculations
    effectiveTotal = Math.max(storedTotal, breakdownSum);
    notVotedFromKoios = effectiveTotal - yes - no - abstain - alwaysAbstain - alwaysNoConfidence;
  }

  // Determine if this governance action uses the new formula (epoch >= 534)
  const useNewFormula = shouldUseNewSpoFormula(proposal);

  // Check governance action type for special handling
  const isNoConfidence =
    proposal.governanceActionType === GovernanceType.NO_CONFIDENCE;
  const isHardForkInitiation =
    proposal.governanceActionType === GovernanceType.HARD_FORK_INITIATION;

  let yesTotal: number;
  let noTotal: number;
  let abstainTotal: number;
  let denominator: number;

  if (useNewFormula) {
    // New formula (epoch >= 534): varies by governance action type
    let notVotedCalc: number;

    if (isHardForkInitiation) {
      // HardForkInitiation: ALL non-voters (including alwaysNoConfidence/alwaysAbstain) count as No
      yesTotal = yes;
      abstainTotal = abstain; // Only explicit abstain votes
      // notVotedCalc includes: pureNotVoted + alwaysNoConfidence + alwaysAbstain
      notVotedCalc = notVotedFromKoios + alwaysNoConfidence + alwaysAbstain;
    } else if (isNoConfidence) {
      // NoConfidence: AlwaysNoConfidence counts as Yes, AlwaysAbstain counts as Abstain
      yesTotal = yes + alwaysNoConfidence;
      abstainTotal = abstain + alwaysAbstain;
      // Pure notVoted only
      notVotedCalc = notVotedFromKoios;
    } else {
      // Other actions: AlwaysAbstain counts as Abstain, AlwaysNoConfidence counts as No
      yesTotal = yes;
      abstainTotal = abstain + alwaysAbstain;
      // Pure notVoted only
      notVotedCalc = notVotedFromKoios;
    }

    // noTotal = explicit No votes + notVoted (which counts as No)
    noTotal = no + Math.max(0, notVotedCalc);

    // Denominator per Cardano ledger: effectiveTotal - abstainTotal
    denominator = effectiveTotal - abstainTotal;
  } else {
    // Old formula (epoch < 534): excludes NotVoted, no special cases
    yesTotal = yes;
    noTotal = no + alwaysNoConfidence;
    abstainTotal = abstain + alwaysAbstain;
    denominator = yes + no + alwaysNoConfidence;
  }

  // Calculate percentages
  let yesPercent = denominator > 0 ? (yesTotal / denominator) * 100 : 0;
  let noPercent = denominator > 0 ? (noTotal / denominator) * 100 : 0;
  const abstainPercent =
    effectiveTotal > 0 ? (abstainTotal / effectiveTotal) * 100 : 0;

  // Safety net: cap individual percentages at 100%
  yesPercent = Math.min(100, yesPercent);
  noPercent = Math.min(100, noPercent);

  // Safety net: normalize if combined yes + no exceeds 100%
  const combinedPercent = yesPercent + noPercent;
  if (combinedPercent > 100) {
    const scale = 100 / combinedPercent;
    yesPercent = yesPercent * scale;
    noPercent = noPercent * scale;
  }

  // Build breakdown for pie chart display
  // Use notVotedFromKoios for accurate "not voted" display
  const breakdown: VoteBreakdown = {
    activeYes: Math.round(yes).toString(),
    activeNo: Math.round(no).toString(),
    activeAbstain: Math.round(abstain).toString(),
    alwaysAbstain: Math.round(alwaysAbstain).toString(),
    alwaysNoConfidence: Math.round(alwaysNoConfidence).toString(),
    inactive: null, // SPO doesn't have inactive concept
    notVoted: Math.round(Math.max(0, notVotedFromKoios)).toString(),
  };

  // Return lovelace values as strings
  return {
    yesPercent: Number(yesPercent.toFixed(2)),
    noPercent: Number(noPercent.toFixed(2)),
    abstainPercent: Number(abstainPercent.toFixed(2)),
    yesLovelace: Math.round(yesTotal).toString(),
    noLovelace: Math.round(noTotal).toString(),
    abstainLovelace: Math.round(abstainTotal).toString(),
    breakdown,
  };
};

/**
 * Build vote info from tally (values are already in lovelace)
 * This is a fallback when voting power data is not available from Koios
 */
const buildVoteInfo = (tally: AdaTally): GovernanceActionVoteInfo => ({
  yesPercent: percent(tally.yes, tally.total),
  noPercent: percent(tally.no, tally.total),
  abstainPercent: percent(tally.abstain, tally.total),
  yesLovelace: Math.round(tally.yes).toString(),
  noLovelace: Math.round(tally.no).toString(),
  abstainLovelace: Math.round(tally.abstain).toString(),
  breakdown: {
    activeYes: Math.round(tally.yes).toString(),
    activeNo: Math.round(tally.no).toString(),
    activeAbstain: Math.round(tally.abstain).toString(),
    alwaysAbstain: "0",
    alwaysNoConfidence: "0",
    inactive: null,
    notVoted: "0",
  },
});

/**
 * Default number of Constitutional Committee members (fallback if not provided)
 */
const DEFAULT_CC_MEMBERS = 7;

/**
 * Minimum number of eligible CC members required for a valid committee
 * Based on Cardano governance rules
 */
const MIN_ELIGIBLE_CC_MEMBERS = 7;

/**
 * Build CC vote info with the formula:
 * - Explicit Abstain votes are excluded from the denominator for Yes/No percentages
 * - Yes % = YesCount / (EligibleMembers - AbstainCount) × 100
 * - No % = NoCount / (EligibleMembers - AbstainCount) × 100
 * - Abstain % = AbstainCount / EligibleMembers × 100
 * - NotVoted % = NotVotedCount / EligibleMembers × 100
 *
 * Note: For ratification purposes, non-voting CC members are effectively treated as "No" votes
 * (since they reduce the denominator for Yes % calculation), but the No % displayed here
 * only reflects explicit "No" votes.
 *
 * A CC member is eligible if:
 * - status === "authorized" (not resigned)
 * - expiration_epoch > currentEpoch (not expired)
 *
 * @param tally - The count of actual votes cast (yes, no, abstain)
 * @param eligibleMembers - Number of eligible CC members (optional, defaults to 7)
 */
const buildCcVoteInfo = (
  tally: CountTally,
  eligibleMembers?: number
): CCGovernanceActionVoteInfo => {
  const { yes, no, abstain } = tally;

  // Use provided eligible members count or default to 7
  const totalEligible = eligibleMembers ?? DEFAULT_CC_MEMBERS;

  // Check if committee is valid (has enough eligible members)
  const isCommitteeValid = totalEligible >= MIN_ELIGIBLE_CC_MEMBERS;

  // Calculate not voted members (those who haven't voted at all)
  const notVoted = Math.max(0, totalEligible - yes - no - abstain);

  // Denominator excludes abstain votes (as per Cardano governance rules)
  const denominator = totalEligible - abstain;

  // Calculate percentages
  const yesPercent = denominator > 0 ? (yes / denominator) * 100 : 0;
  const noPercent = denominator > 0 ? (no / denominator) * 100 : 0;
  const abstainPercent =
    totalEligible > 0 ? (abstain / totalEligible) * 100 : 0;
  const notVotedPercent =
    totalEligible > 0 ? (notVoted / totalEligible) * 100 : 0;

  return {
    yesPercent: Number(yesPercent.toFixed(2)),
    noPercent: Number(noPercent.toFixed(2)),
    abstainPercent: Number(abstainPercent.toFixed(2)),
    notVotedPercent: Number(notVotedPercent.toFixed(2)),
    yesCount: yes,
    noCount: no,
    abstainCount: abstain,
    notVotedCount: notVoted,
    eligibleMembers: totalEligible,
    isCommitteeValid,
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

/**
 * Gets the timestamp for a vote, preferring votedAt, then createdAt, then updatedAt
 */
const getVoteTimestamp = (vote: VoteWithRelations): Date => {
  return (
    vote.votedAt ??
    vote.createdAt ??
    vote.updatedAt ??
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
  if (vote.voterType === VoterType.DREP) {
    // Prefer the DRep's display name, falling back to their payment address if available
    return vote.drep?.name ?? vote.drep?.paymentAddr ?? undefined;
  }

  if (vote.voterType === VoterType.SPO) {
    return vote.spo?.poolName ?? vote.spo?.ticker ?? undefined;
  }

  return vote.cc?.memberName ?? undefined;
};

const mapVoteRecord = (vote: VoteWithRelations): VoteRecord => {
  const record: VoteRecord = {
    txHash: vote.txHash,
    voterType: formatVoterType(vote.voterType),
    voterId: resolveVoterId(vote),
    vote: formatVoteChoice(vote.vote),
    votedAt: formatVoteDate(
      vote.votedAt ?? vote.createdAt ?? vote.updatedAt
    ),
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
 * - Yes % = YesCount / (EligibleMembers - AbstainCount) × 100
 * - Non-voting CC members effectively reduce the denominator (same effect as "No" votes)
 *
 * @param ccCountTally - The CC vote count tally
 * @param eligibleMembers - Number of eligible CC members (optional, defaults to 7)
 * @returns "Constitutional", "Unconstitutional", "Pending", or "Committee Too Small"
 */
const determineConstitutionality = (
  ccCountTally: CountTally,
  eligibleMembers?: number
): string => {
  const { yes, no, abstain } = ccCountTally;
  const totalVotesCast = yes + no + abstain;

  // Use provided eligible members count or default
  const totalEligible = eligibleMembers ?? DEFAULT_CC_MEMBERS;

  // Check if committee is valid
  if (totalEligible < MIN_ELIGIBLE_CC_MEMBERS) {
    return "Committee Too Small";
  }

  // If no CC votes yet
  if (totalVotesCast === 0) {
    return "Pending";
  }

  // Denominator excludes abstain votes (as per Cardano governance rules)
  const denominator = totalEligible - abstain;

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
  const allCcVotes = votes.filter((vote) => vote.voterType === VoterType.CC);

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
  proposal: ProposalWithVotes,
  eligibleCCMembers?: number
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
    ? buildCcVoteInfo(voteAggregation.ccCountTally, eligibleCCMembers)
    : undefined;

  // Determine constitutionality based on CC voting results (≥67% Yes = Constitutional)
  const constitutionality = determineConstitutionality(
    voteAggregation.ccCountTally,
    eligibleCCMembers
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

  // Calculate SPO effective total (same logic as buildSpoVoteInfo)
  // Uses Koios pool_no_vote_power when available for consistent data
  const spoTotal = toNumber(proposal.spoTotalVotePower);
  const spoKoiosNoVotePower = toNumber(proposal.spoNoVotePower);
  let spoEffectiveTotal: number;

  if (proposal.spoNoVotePower !== null && proposal.spoNoVotePower !== undefined) {
    // Use Koios data for consistent effective total
    const yes = toNumber(proposal.spoActiveYesVotePower);
    const abstain = toNumber(proposal.spoActiveAbstainVotePower);
    const alwaysAbstain = toNumber(proposal.spoAlwaysAbstainVotePower);
    spoEffectiveTotal = yes + spoKoiosNoVotePower + abstain + alwaysAbstain;
  } else {
    // Fallback to old logic
    const spoBreakdownSum =
      toNumber(proposal.spoActiveYesVotePower) +
      toNumber(proposal.spoActiveNoVotePower) +
      toNumber(proposal.spoActiveAbstainVotePower) +
      toNumber(proposal.spoAlwaysAbstainVotePower) +
      toNumber(proposal.spoAlwaysNoConfidencePower);
    spoEffectiveTotal = Math.max(spoTotal, spoBreakdownSum);
  }

  const rawVotingPowerValues: RawVotingPowerValues = {
    drep_total_vote_power: proposal.drepTotalVotePower?.toString() ?? null,
    drep_active_yes_vote_power:
      proposal.drepActiveYesVotePower?.toString() ?? null,
    drep_active_no_vote_power:
      proposal.drepActiveNoVotePower?.toString() ?? null,
    drep_active_abstain_vote_power:
      proposal.drepActiveAbstainVotePower?.toString() ?? null,
    drep_always_abstain_vote_power:
      proposal.drepAlwaysAbstainVotePower?.toString() ?? null,
    drep_always_no_confidence_power:
      proposal.drepAlwaysNoConfidencePower?.toString() ?? null,
    drep_inactive_vote_power:
      proposal.drepInactiveVotePower?.toString() ?? null,
    spo_total_vote_power: proposal.spoTotalVotePower?.toString() ?? null,
    spo_effective_total_vote_power:
      proposal.spoTotalVotePower !== null ? spoEffectiveTotal.toString() : null,
    spo_no_vote_power: proposal.spoNoVotePower?.toString() ?? null,
    spo_active_yes_vote_power:
      proposal.spoActiveYesVotePower?.toString() ?? null,
    spo_active_no_vote_power:
      proposal.spoActiveNoVotePower?.toString() ?? null,
    spo_active_abstain_vote_power:
      proposal.spoActiveAbstainVotePower?.toString() ?? null,
    spo_always_abstain_vote_power:
      proposal.spoAlwaysAbstainVotePower?.toString() ?? null,
    spo_always_no_confidence_power:
      proposal.spoAlwaysNoConfidencePower?.toString() ?? null,
  };

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
    rawVotingPowerValues,
  };
};

export const mapProposalToGovernanceActionDetail = (
  proposal: ProposalWithVotes,
  eligibleCCMembers?: number
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

  const base = mapProposalToGovernanceAction(proposal, eligibleCCMembers);
  const votes = proposal.onchainVotes ?? [];
  const standardVotes = votes.filter((vote) => vote.voterType !== VoterType.CC);
  const allCcVotes = votes.filter((vote) => vote.voterType === VoterType.CC);

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