import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import { GetStakeParticipationResponse } from "../../responses/analytics.response";

/**
 * GET /analytics/stake-participation
 * Returns active stake address participation stats
 *
 * Query params:
 * - proposalId: Filter by specific proposal (optional)
 */
export const getStakeParticipation = async (req: Request, res: Response) => {
  try {
    const proposalId = req.query.proposalId as string | undefined;

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
    const [participatingStats, totalStats] = await Promise.all([
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
    ]);

    const participatingDelegators = participatingStats._count.stakeAddress;
    const totalDelegators = totalStats._count.stakeAddress;
    const participatingAmount = participatingStats._sum.amount ?? 0n;
    const totalAmount = totalStats._sum.amount ?? 0n;

    const participationRatePct =
      totalDelegators > 0
        ? Number(((participatingDelegators * 10000) / totalDelegators) / 100)
        : null;

    const response: GetStakeParticipationResponse = {
      proposalId: proposalId ?? null,
      stats: {
        participatingDelegators,
        totalDelegators,
        participationRatePct,
        participatingAmount: participatingAmount.toString(),
        totalAmount: totalAmount.toString(),
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
