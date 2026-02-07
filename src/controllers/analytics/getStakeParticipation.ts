import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import { GetStakeParticipationResponse } from "../../responses/analytics.response";

/**
 * GET /analytics/stake-participation
 * Returns delegated stake participation stats.
 *
 * Participating delegators are stake addresses delegated to a DRep that has voted (optionally scoped to a proposal).
 * Default-stance delegations (always abstain / always no confidence) are treated as participating and are included
 * via epoch-level aggregates.
 *
 * Query params:
 * - proposalId: Filter by specific proposal (optional)
 */
export const getStakeParticipation = async (req: Request, res: Response) => {
  try {
    const proposalId = req.query.proposalId as string | undefined;

    const pctOrNull = (numerator: bigint | number, denominator: bigint | number) => {
      const denom = typeof denominator === "bigint" ? denominator : BigInt(denominator);
      if (denom <= 0n) return null;
      const num = typeof numerator === "bigint" ? numerator : BigInt(numerator);
      // Two decimals, round down (matches existing style)
      return Number(((num * 10000n) / denom)) / 100;
    };

    // Get DReps that voted on the proposal(s)
    const votingDrepFilter: any = {
      voterType: VoterType.DREP,
      drepId: { not: null },
    };

    if (proposalId) {
      votingDrepFilter.proposalId = proposalId;
    }

    // Get distinct DRep IDs that have voted
    const votingDreps = await prisma.onchainVote.findMany({
      where: votingDrepFilter,
      select: { drepId: true },
      distinct: ["drepId"],
    });

    const votingDrepIds = votingDreps
      .map((v) => v.drepId)
      .filter((id): id is string => id !== null);

    // Get delegation stats - participating delegators are those delegated to a DRep that voted
    // Also include special DRep delegation aggregates which are tracked in EpochTotals (not as stake addresses)
    // NOTE: Special DRep voting power fields in EpochTotals are per-epoch snapshots; do not sum them across epochs.
    const [participatingStats, totalStats, specialDrepDelegatorTotals, latestEpochTotals] = await Promise.all([
      // Delegators whose DRep voted
      prisma.stakeDelegationState.aggregate({
        where: {
          drepId: { in: votingDrepIds },
        },
        _count: { stakeAddress: true },
        _sum: { amount: true },
      }),
      // All delegators
      prisma.stakeDelegationState.aggregate({
        where: {
          drepId: { not: null },
        },
        _count: { stakeAddress: true },
        _sum: { amount: true },
      }),
      // Aggregate special DRep delegator counts across all epochs (ingested as per-epoch aggregates)
      prisma.epochTotals.aggregate({
        _sum: {
          drepAlwaysAbstainDelegatorCount: true,
          drepAlwaysNoConfidenceDelegatorCount: true,
        },
      }),
      // Latest epoch totals row (for snapshot voting power values)
      prisma.epochTotals.findFirst({
        orderBy: { epoch: "desc" },
        select: {
          epoch: true,
          drepAlwaysAbstainVotingPower: true,
          drepAlwaysNoConfidenceVotingPower: true,
        },
      }),
    ]);

    const alwaysAbstainDelegators =
      specialDrepDelegatorTotals._sum.drepAlwaysAbstainDelegatorCount ?? 0;
    const alwaysNoConfidenceDelegators =
      specialDrepDelegatorTotals._sum.drepAlwaysNoConfidenceDelegatorCount ?? 0;
    const defaultDelegators = alwaysAbstainDelegators + alwaysNoConfidenceDelegators;

    const alwaysAbstainAmount = latestEpochTotals?.drepAlwaysAbstainVotingPower ?? 0n;
    const alwaysNoConfidenceAmount =
      latestEpochTotals?.drepAlwaysNoConfidenceVotingPower ?? 0n;
    const defaultAmount = alwaysAbstainAmount + alwaysNoConfidenceAmount;

    const actualParticipatingDelegators = participatingStats._count.stakeAddress;
    const actualTotalDelegators = totalStats._count.stakeAddress;
    const actualParticipatingAmount = participatingStats._sum.amount ?? 0n;
    const actualTotalAmount = totalStats._sum.amount ?? 0n;

    // By definition, default delegations apply a standing stance, so they are treated as “participating”.
    const defaultParticipatingDelegators = defaultDelegators;
    const defaultTotalDelegators = defaultDelegators;
    const defaultParticipatingAmount = defaultAmount;
    const defaultTotalAmount = defaultAmount;

    const participatingDelegators =
      actualParticipatingDelegators + defaultParticipatingDelegators;
    const totalDelegators = actualTotalDelegators + defaultTotalDelegators;
    const participatingAmount = actualParticipatingAmount + defaultParticipatingAmount;
    const totalAmount = actualTotalAmount + defaultTotalAmount;

    const participationRatePct =
      totalDelegators > 0
        ? Number(((participatingDelegators * 10000) / totalDelegators) / 100)
        : null;

    const totalDelegatorsBig = BigInt(totalDelegators);
    const totalAmountBig = totalAmount;

    const actualParticipationRatePct =
      actualTotalDelegators > 0
        ? Number(
            ((actualParticipatingDelegators * 10000) / actualTotalDelegators) / 100
          )
        : null;

    const alwaysAbstainDelegatorsBig = BigInt(alwaysAbstainDelegators);
    const alwaysNoConfidenceDelegatorsBig = BigInt(alwaysNoConfidenceDelegators);

    const alwaysAbstainBucketParticipationRatePct =
      alwaysAbstainDelegators > 0 ? 100 : null;
    const alwaysNoConfidenceBucketParticipationRatePct =
      alwaysNoConfidenceDelegators > 0 ? 100 : null;

    const response: GetStakeParticipationResponse = {
      proposalId: proposalId ?? null,
      stats: {
        participatingDelegators,
        totalDelegators,
        participationRatePct,
        participatingAmount: participatingAmount.toString(),
        totalAmount: totalAmount.toString(),
        breakdown: {
          actual: {
            participatingDelegators: actualParticipatingDelegators,
            totalDelegators: actualTotalDelegators,
            participationRatePct: actualParticipationRatePct,
            participatingAmount: actualParticipatingAmount.toString(),
            totalAmount: actualTotalAmount.toString(),
            delegatorSharePct: pctOrNull(BigInt(actualTotalDelegators), totalDelegatorsBig),
            amountSharePct: pctOrNull(actualTotalAmount, totalAmountBig),
          },
          alwaysAbstain: {
            participatingDelegators: alwaysAbstainDelegators,
            totalDelegators: alwaysAbstainDelegators,
            participationRatePct: alwaysAbstainBucketParticipationRatePct,
            participatingAmount: alwaysAbstainAmount.toString(),
            totalAmount: alwaysAbstainAmount.toString(),
            delegatorSharePct: pctOrNull(alwaysAbstainDelegatorsBig, totalDelegatorsBig),
            amountSharePct: pctOrNull(alwaysAbstainAmount, totalAmountBig),
          },
          alwaysNoConfidence: {
            participatingDelegators: alwaysNoConfidenceDelegators,
            totalDelegators: alwaysNoConfidenceDelegators,
            participationRatePct: alwaysNoConfidenceBucketParticipationRatePct,
            participatingAmount: alwaysNoConfidenceAmount.toString(),
            totalAmount: alwaysNoConfidenceAmount.toString(),
            delegatorSharePct: pctOrNull(alwaysNoConfidenceDelegatorsBig, totalDelegatorsBig),
            amountSharePct: pctOrNull(alwaysNoConfidenceAmount, totalAmountBig),
          },
        },
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching stake participation", error);
    res.status(500).json({
      error: "Failed to fetch stake participation",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
