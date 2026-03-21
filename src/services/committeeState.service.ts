import type { Prisma } from "@prisma/client";
import { getCommitteeInfo } from "./governanceProvider";
import { getKoiosCurrentEpoch } from "./ingestion/sync-utils";

export interface EligibleCCInfo {
  totalMembers: number;
  eligibleMembers: number;
  quorumNumerator: number;
  quorumDenominator: number;
  isCommitteeValid: boolean;
}

export interface SyncCommitteeStateResult {
  epoch: number;
  totalMembers: number;
  eligibleMembers: number;
  isCommitteeValid: boolean;
  updated: boolean;
}

const MIN_ELIGIBLE_CC_MEMBERS = 7;

export async function getEligibleCCInfo(): Promise<EligibleCCInfo> {
  const committeeInfo = await getCommitteeInfo({
    source: "committee-state.eligible-cc.committee-info",
  });

  if (!committeeInfo?.members) {
    return {
      totalMembers: 0,
      eligibleMembers: 0,
      quorumNumerator: 2,
      quorumDenominator: 3,
      isCommitteeValid: false,
    };
  }

  const currentEpoch = await getKoiosCurrentEpoch();
  const eligibleMembers = committeeInfo.members.filter(
    (member) =>
      member.status === "authorized" && member.expiration_epoch > currentEpoch
  );
  const eligibleCount = eligibleMembers.length;

  return {
    totalMembers: committeeInfo.members.length,
    eligibleMembers: eligibleCount,
    quorumNumerator: committeeInfo.quorum_numerator,
    quorumDenominator: committeeInfo.quorum_denominator,
    isCommitteeValid: eligibleCount >= MIN_ELIGIBLE_CC_MEMBERS,
  };
}

export async function syncCommitteeState(
  prisma: Prisma.TransactionClient
): Promise<SyncCommitteeStateResult> {
  const ccInfo = await getEligibleCCInfo();
  const currentEpoch = await getKoiosCurrentEpoch();

  await prisma.committeeState.upsert({
    where: { id: "current" },
    update: {
      epoch: currentEpoch,
      totalMembers: ccInfo.totalMembers,
      eligibleMembers: ccInfo.eligibleMembers,
      quorumNumerator: ccInfo.quorumNumerator,
      quorumDenominator: ccInfo.quorumDenominator,
      isCommitteeValid: ccInfo.isCommitteeValid,
    },
    create: {
      id: "current",
      epoch: currentEpoch,
      totalMembers: ccInfo.totalMembers,
      eligibleMembers: ccInfo.eligibleMembers,
      quorumNumerator: ccInfo.quorumNumerator,
      quorumDenominator: ccInfo.quorumDenominator,
      isCommitteeValid: ccInfo.isCommitteeValid,
    },
  });

  return {
    epoch: currentEpoch,
    totalMembers: ccInfo.totalMembers,
    eligibleMembers: ccInfo.eligibleMembers,
    isCommitteeValid: ccInfo.isCommitteeValid,
    updated: true,
  };
}

export async function getCachedEligibleCCInfo(
  prisma: Prisma.TransactionClient
): Promise<EligibleCCInfo> {
  const cached = await prisma.committeeState.findUnique({
    where: { id: "current" },
  });

  if (cached) {
    return {
      totalMembers: cached.totalMembers,
      eligibleMembers: cached.eligibleMembers,
      quorumNumerator: cached.quorumNumerator,
      quorumDenominator: cached.quorumDenominator,
      isCommitteeValid: cached.isCommitteeValid,
    };
  }

  return getEligibleCCInfo();
}
