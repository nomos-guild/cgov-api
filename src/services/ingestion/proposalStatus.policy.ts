import { GovernanceType, ProposalStatus } from "@prisma/client";
import type { KoiosProposal } from "../../types/koios.types";

export function mapGovernanceType(
  koiosType: string | undefined
): GovernanceType | null {
  if (!koiosType) return null;

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

export function deriveProposalStatus(
  proposal: KoiosProposal,
  currentEpoch: number
): ProposalStatus {
  const isInfoAction = proposal.proposal_type === "InfoAction";

  if (proposal.enacted_epoch && proposal.enacted_epoch <= currentEpoch) {
    return ProposalStatus.ENACTED;
  }

  if (proposal.ratified_epoch && proposal.ratified_epoch <= currentEpoch) {
    return ProposalStatus.RATIFIED;
  }

  const droppedBeforeExpiration =
    proposal.dropped_epoch != null &&
    proposal.dropped_epoch <= currentEpoch &&
    (proposal.expired_epoch == null ||
      proposal.dropped_epoch < proposal.expired_epoch);
  if (droppedBeforeExpiration) {
    return isInfoAction ? ProposalStatus.CLOSED : ProposalStatus.DROPPED;
  }

  if (proposal.expired_epoch && proposal.expired_epoch <= currentEpoch) {
    return isInfoAction ? ProposalStatus.CLOSED : ProposalStatus.EXPIRED;
  }

  return ProposalStatus.ACTIVE;
}

function parseLovelaceUnknown(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      return null;
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    return BigInt(trimmed);
  }
  return null;
}

function isKoiosTreasuryRecipient(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { network?: unknown; credential?: unknown };
  return (
    typeof candidate.network === "string" &&
    candidate.credential != null &&
    typeof candidate.credential === "object"
  );
}

function collectTreasuryWithdrawalAmounts(value: unknown, amounts: bigint[]): void {
  if (!Array.isArray(value)) {
    return;
  }

  if (value.length === 2 && isKoiosTreasuryRecipient(value[0])) {
    const parsedAmount = parseLovelaceUnknown(value[1]);
    if (parsedAmount !== null) {
      amounts.push(parsedAmount);
    }
  }

  for (const entry of value) {
    collectTreasuryWithdrawalAmounts(entry, amounts);
  }
}

export function extractTreasuryWithdrawalAmount(
  proposal: KoiosProposal
): bigint | null {
  if (proposal.proposal_type !== "TreasuryWithdrawals") {
    return null;
  }

  // Koios returns withdrawal as an array of {amount, stake_address}
  if (proposal.withdrawal && proposal.withdrawal.length > 0) {
    let total = BigInt(0);
    for (const w of proposal.withdrawal) {
      const parsed = parseLovelaceUnknown(w.amount);
      if (parsed !== null) {
        total += parsed;
      }
    }
    if (total > BigInt(0)) {
      return total;
    }
  }

  const nestedAmounts: bigint[] = [];
  collectTreasuryWithdrawalAmounts(
    proposal.proposal_description?.contents,
    nestedAmounts
  );
  if (nestedAmounts.length > 0) {
    return nestedAmounts.reduce((sum, amount) => sum + amount, BigInt(0));
  }

  return null;
}
