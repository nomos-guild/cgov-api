import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import { GetDRepStatsResponse } from "../../responses";

/**
 * Converts lovelace (BigInt) to ADA string with 6 decimal places
 */
function lovelaceToAda(lovelace: bigint): string {
  const ada = Number(lovelace) / 1_000_000;
  return ada.toFixed(6);
}

/**
 * GET /dreps/stats
 * Get aggregate DRep statistics
 */
export const getDRepStats = async (_req: Request, res: Response) => {
  try {
    // Run all queries in parallel for better performance
    const [
      totalDReps,
      aggregateResult,
      totalVotesResult,
      activeDRepsResult,
    ] = await Promise.all([
      // Total number of DReps (excluding doNotList)
      prisma.drep.count({
        where: {
          OR: [{ doNotList: false }, { doNotList: null }],
        },
      }),

      // Sum of all voting power and delegator counts
      prisma.drep.aggregate({
        where: {
          OR: [{ doNotList: false }, { doNotList: null }],
        },
        _sum: {
          votingPower: true,
          delegatorCount: true,
        },
      }),

      // Total votes cast by DReps
      prisma.onchainVote.count({
        where: {
          voterType: VoterType.DREP,
        },
      }),

      // Count of DReps who have cast at least one vote (excluding doNotList)
      prisma.onchainVote.groupBy({
        by: ["drepId"],
        where: {
          voterType: VoterType.DREP,
          drepId: { not: null },
          drep: {
            OR: [{ doNotList: false }, { doNotList: null }],
          },
        },
      }),
    ]);

    const totalDelegatedLovelace = aggregateResult._sum.votingPower ?? BigInt(0);
    const totalDelegators = aggregateResult._sum.delegatorCount ?? 0;

    const response: GetDRepStatsResponse = {
      totalDReps,
      totalDelegatedLovelace: totalDelegatedLovelace.toString(),
      totalDelegatedAda: lovelaceToAda(totalDelegatedLovelace),
      totalVotesCast: totalVotesResult,
      activeDReps: activeDRepsResult.length,
      totalDelegators,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching DRep stats", error);
    res.status(500).json({
      error: "Failed to fetch DRep statistics",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
