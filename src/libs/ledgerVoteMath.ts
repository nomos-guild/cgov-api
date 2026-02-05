import { GovernanceType, Proposal } from "@prisma/client";
import { shouldUseNewSpoFormula } from "./proposalMapper";
import type { ProposalWithVotes } from "./proposalMapper";

const asBigInt = (value: bigint | null | undefined): bigint => value ?? 0n;

const maxBigInt = (a: bigint, b: bigint): bigint => (a > b ? a : b);

const pct2 = (numerator: bigint, denominator: bigint): number | null => {
  if (denominator <= 0n) return null;
  // Two decimals, truncated like bigint division (consistent and stable)
  return Number((numerator * 10000n) / denominator) / 100;
};

export type DrepVotePowerFields = Pick<
  Proposal,
  | "governanceActionType"
  | "drepTotalVotePower"
  | "drepActiveYesVotePower"
  | "drepActiveNoVotePower"
  | "drepActiveAbstainVotePower"
  | "drepAlwaysAbstainVotePower"
  | "drepAlwaysNoConfidencePower"
  | "drepInactiveVotePower"
>;

export interface DrepLedgerBuckets {
  total: bigint;
  inactive: bigint;
  yes: bigint;
  no: bigint;
  abstain: bigint;
  notVoted: bigint;
  // Percentages for “ledger outcome” (yes/no excludes abstain+inactive)
  yesOutcomePct: number | null;
  noOutcomePct: number | null;
  // Distribution across yes/no/abstain (excludes inactive; sums to ~100)
  yesDistPct: number | null;
  noDistPct: number | null;
  abstainDistPct: number | null;
}

export const computeDrepLedgerBuckets = (
  proposal: DrepVotePowerFields
): DrepLedgerBuckets => {
  const total = asBigInt(proposal.drepTotalVotePower);
  const activeYes = asBigInt(proposal.drepActiveYesVotePower);
  const activeNo = asBigInt(proposal.drepActiveNoVotePower);
  const activeAbstain = asBigInt(proposal.drepActiveAbstainVotePower);
  const alwaysAbstain = asBigInt(proposal.drepAlwaysAbstainVotePower);
  const alwaysNoConfidence = asBigInt(proposal.drepAlwaysNoConfidencePower);
  const inactive = asBigInt(proposal.drepInactiveVotePower);

  const notVotedRaw =
    total -
    activeYes -
    activeNo -
    activeAbstain -
    alwaysAbstain -
    alwaysNoConfidence -
    inactive;
  const notVoted = notVotedRaw > 0n ? notVotedRaw : 0n;

  const isNoConfidence = proposal.governanceActionType === GovernanceType.NO_CONFIDENCE;

  const yes = isNoConfidence ? activeYes + alwaysNoConfidence : activeYes;
  const no = isNoConfidence
    ? activeNo + notVoted
    : activeNo + alwaysNoConfidence + notVoted;
  const abstain = activeAbstain + alwaysAbstain;

  // Outcome % mirrors the proposalMapper ledger math: denominator excludes abstain+inactive
  const yesNoDenom = yes + no;

  const yesOutcomePct = pct2(yes, yesNoDenom);
  const noOutcomePct = pct2(no, yesNoDenom);

  // Distribution for divergence: exclude inactive so yes+no+abstain cover the denominator
  const distDenom = total - inactive;
  const yesDistPct = pct2(yes, distDenom);
  const noDistPct = pct2(no, distDenom);
  const abstainDistPct = pct2(abstain, distDenom);

  return {
    total,
    inactive,
    yes,
    no,
    abstain,
    notVoted,
    yesOutcomePct,
    noOutcomePct,
    yesDistPct,
    noDistPct,
    abstainDistPct,
  };
};

export type SpoVotePowerFields = Pick<
  Proposal,
  | "proposalId"
  | "submissionEpoch"
  | "governanceActionType"
  | "spoTotalVotePower"
  | "spoActiveYesVotePower"
  | "spoActiveNoVotePower"
  | "spoActiveAbstainVotePower"
  | "spoAlwaysAbstainVotePower"
  | "spoAlwaysNoConfidencePower"
  | "spoNoVotePower"
>;

export interface SpoLedgerBuckets {
  effectiveTotal: bigint;
  yes: bigint;
  no: bigint;
  abstain: bigint;
  // Pure “did not vote” (excludes explicit No + AlwaysNoConfidence)
  notVoted: bigint;
  // Percentages for “ledger outcome” (yes/no use ledger denominators)
  yesOutcomePct: number | null;
  noOutcomePct: number | null;
  // Distribution across yes/no/abstain (sums to ~100, denom follows ledger era)
  yesDistPct: number | null;
  noDistPct: number | null;
  abstainDistPct: number | null;
}

export const computeSpoLedgerBuckets = (
  proposal: SpoVotePowerFields
): SpoLedgerBuckets => {
  const storedTotal = asBigInt(proposal.spoTotalVotePower);
  const yesActive = asBigInt(proposal.spoActiveYesVotePower);
  const noActive = asBigInt(proposal.spoActiveNoVotePower);
  const abstainActive = asBigInt(proposal.spoActiveAbstainVotePower);
  const alwaysAbstain = asBigInt(proposal.spoAlwaysAbstainVotePower);
  const alwaysNoConfidence = asBigInt(proposal.spoAlwaysNoConfidencePower);

  const hasKoiosNoVote = proposal.spoNoVotePower !== null && proposal.spoNoVotePower !== undefined;
  const koiosNoVotePower = asBigInt(proposal.spoNoVotePower);

  // Same approach as proposalMapper: build a consistent effectiveTotal and notVotedFromKoios.
  let effectiveTotal: bigint;
  let notVotedFromKoiosRaw: bigint;

  if (hasKoiosNoVote) {
    // Koios pool_no_vote_power = explicit No + alwaysNoConfidence + pureNotVoted
    notVotedFromKoiosRaw = koiosNoVotePower - noActive - alwaysNoConfidence;
    effectiveTotal = yesActive + koiosNoVotePower + abstainActive + alwaysAbstain;
  } else {
    const breakdownSum =
      yesActive +
      noActive +
      abstainActive +
      alwaysAbstain +
      alwaysNoConfidence;
    effectiveTotal = maxBigInt(storedTotal, breakdownSum);
    notVotedFromKoiosRaw =
      effectiveTotal -
      yesActive -
      noActive -
      abstainActive -
      alwaysAbstain -
      alwaysNoConfidence;
  }

  const notVoted = notVotedFromKoiosRaw > 0n ? notVotedFromKoiosRaw : 0n;

  const useNewFormula = shouldUseNewSpoFormula(
    proposal as unknown as ProposalWithVotes
  );

  const isNoConfidence = proposal.governanceActionType === GovernanceType.NO_CONFIDENCE;
  const isHardForkInitiation =
    proposal.governanceActionType === GovernanceType.HARD_FORK_INITIATION;

  let yes: bigint;
  let no: bigint;
  let abstain: bigint;
  let outcomeDenom: bigint;

  if (useNewFormula) {
    let notVotedCalc: bigint;

    if (isHardForkInitiation) {
      // HFI: all non-voters (including always stances) count as No; abstain is explicit-only
      yes = yesActive;
      abstain = abstainActive;
      notVotedCalc = notVoted + alwaysNoConfidence + alwaysAbstain;
    } else if (isNoConfidence) {
      // NoConfidence: AlwaysNoConfidence => Yes, AlwaysAbstain => Abstain
      yes = yesActive + alwaysNoConfidence;
      abstain = abstainActive + alwaysAbstain;
      notVotedCalc = notVoted;
    } else {
      // Other actions: AlwaysNoConfidence => No, AlwaysAbstain => Abstain
      yes = yesActive;
      abstain = abstainActive + alwaysAbstain;
      notVotedCalc = notVoted;
    }

    // no = explicit No votes + notVoted (counts as No)
    no = noActive + notVotedCalc;
    outcomeDenom = effectiveTotal - abstain;
  } else {
    // Old formula: excludes NotVoted and has no special-cases
    yes = yesActive;
    no = noActive + alwaysNoConfidence;
    abstain = abstainActive + alwaysAbstain;
    outcomeDenom = yesActive + noActive + alwaysNoConfidence;
  }

  const yesOutcomePct = pct2(yes, outcomeDenom);
  const noOutcomePct = pct2(no, outcomeDenom);

  // Distribution for divergence: choose denom that matches the era.
  // - Old era: exclude notVoted (it is excluded from ledger threshold math)
  // - New era: include it via `no`
  const distDenom = useNewFormula ? yes + no + abstain : yes + no + abstain;
  const yesDistPct = pct2(yes, distDenom);
  const noDistPct = pct2(no, distDenom);
  const abstainDistPct = pct2(abstain, distDenom);

  return {
    effectiveTotal,
    yes,
    no,
    abstain,
    notVoted,
    yesOutcomePct,
    noOutcomePct,
    yesDistPct,
    noDistPct,
    abstainDistPct,
  };
};
