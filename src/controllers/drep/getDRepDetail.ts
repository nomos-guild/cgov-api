import { Request, Response } from "express";
import { VoterType, VoteType } from "@prisma/client";
import { prisma } from "../../services";
import { GetDRepDetailResponse, VoteBreakdown } from "../../responses";

/**
 * Converts lovelace (BigInt) to ADA string with 6 decimal places
 */
function lovelaceToAda(lovelace: bigint): string {
  const ada = Number(lovelace) / 1_000_000;
  return ada.toFixed(6);
}

/**
 * GET /drep/:drepId
 * Get detailed information about a specific DRep including vote breakdown
 */
export const getDRepDetail = async (req: Request, res: Response) => {
  try {
    const drepId = req.params.drepId as string;

    if (!drepId) {
      return res.status(400).json({
        error: "Missing drepId",
        message: "A drepId path parameter is required",
      });
    }

    // Fetch DRep details
    const drep = await prisma.drep.findUnique({
      where: { drepId },
      select: {
        drepId: true,
        name: true,
        iconUrl: true,
        paymentAddr: true,
        votingPower: true,
        delegatorCount: true,
        bio: true,
        motivations: true,
        objectives: true,
        qualifications: true,
        references: true,
      },
    });

    if (!drep) {
      return res.status(404).json({
        error: "DRep not found",
        message: `No DRep found with id ${drepId}`,
      });
    }

    // Get vote statistics for this DRep in parallel
    const [voteBreakdownResult, rationalesCount, totalProposals] = await Promise.all([
      // Vote breakdown by type
      prisma.onchainVote.groupBy({
        by: ["vote"],
        where: {
          drepId,
          voterType: VoterType.DREP,
        },
        _count: { id: true },
      }),

      // Count of votes with rationale
      prisma.onchainVote.count({
        where: {
          drepId,
          voterType: VoterType.DREP,
          rationale: { not: null },
        },
      }),

      // Total number of proposals (for participation calculation)
      prisma.proposal.count(),
    ]);

    // Build vote breakdown
    const voteBreakdown: VoteBreakdown = {
      yes: 0,
      no: 0,
      abstain: 0,
    };

    let totalVotesCast = 0;
    for (const item of voteBreakdownResult) {
      const count = item._count.id;
      totalVotesCast += count;

      if (item.vote === VoteType.YES) {
        voteBreakdown.yes = count;
      } else if (item.vote === VoteType.NO) {
        voteBreakdown.no = count;
      } else if (item.vote === VoteType.ABSTAIN) {
        voteBreakdown.abstain = count;
      }
    }

    // Calculate participation percentage
    // Count unique proposals this DRep has voted on
    const uniqueProposalsVoted = await prisma.onchainVote.groupBy({
      by: ["proposalId"],
      where: {
        drepId,
        voterType: VoterType.DREP,
      },
    });

    const participationPercent =
      totalProposals > 0
        ? Math.round((uniqueProposalsVoted.length / totalProposals) * 100 * 100) / 100
        : 0;

    const response: GetDRepDetailResponse = {
      drepId: drep.drepId,
      name: drep.name,
      iconUrl: drep.iconUrl,
      paymentAddr: drep.paymentAddr,
      votingPower: drep.votingPower.toString(),
      votingPowerAda: lovelaceToAda(drep.votingPower),
      totalVotesCast,
      voteBreakdown,
      rationalesProvided: rationalesCount,
      proposalParticipationPercent: participationPercent,
      delegatorCount: drep.delegatorCount,
      bio: drep.bio ?? null,
      motivations: drep.motivations ?? null,
      objectives: drep.objectives ?? null,
      qualifications: drep.qualifications ?? null,
      references: drep.references ?? null,
    };

    return res.json(response);
  } catch (error) {
    console.error("Error fetching DRep detail", error);
    return res.status(500).json({
      error: "Failed to fetch DRep details",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
