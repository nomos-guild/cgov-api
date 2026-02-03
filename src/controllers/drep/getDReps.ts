import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import { GetDRepsResponse, DRepSummary } from "../../responses";

/**
 * Converts lovelace (BigInt) to ADA string with 6 decimal places
 */
function lovelaceToAda(lovelace: bigint): string {
  const ada = Number(lovelace) / 1_000_000;
  return ada.toFixed(6);
}

/**
 * GET /dreps
 * List all DReps with pagination and sorting
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - sortBy: Field to sort by (votingPower, name, totalVotes) (default: votingPower)
 * - sortOrder: Sort direction (asc, desc) (default: desc)
 * - search: Search by name or drepId (optional)
 */
export const getDReps = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const sortBy = (req.query.sortBy as string) || "votingPower";
    const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";
    const search = (req.query.search as string) || "";

    // Build where clause
    const whereClause: any = {
      // Exclude DReps marked as "do not list"
      OR: [{ doNotList: false }, { doNotList: null }],
    };

    // Add search filter if provided
    if (search) {
      whereClause.AND = [
        {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { drepId: { contains: search, mode: "insensitive" } },
          ],
        },
      ];
    }

    // Get total count for pagination
    const totalItems = await prisma.drep.count({ where: whereClause });

    // Build order by clause
    let orderBy: any;
    if (sortBy === "name") {
      orderBy = { name: sortOrder };
    } else if (sortBy === "votingPower") {
      orderBy = { votingPower: sortOrder };
    } else {
      // Default to voting power
      orderBy = { votingPower: sortOrder };
    }

    // Fetch DReps with pagination
    const dreps = await prisma.drep.findMany({
      where: whereClause,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        drepId: true,
        name: true,
        iconUrl: true,
        votingPower: true,
      },
    });

    // Get vote counts for each DRep
    const drepIds = dreps.map((d) => d.drepId);
    const voteCounts = await prisma.onchainVote.groupBy({
      by: ["drepId"],
      where: {
        drepId: { in: drepIds },
        voterType: VoterType.DREP,
      },
      _count: { id: true },
    });

    // Create a map of drepId -> vote count
    const voteCountMap = new Map<string, number>();
    for (const vc of voteCounts) {
      if (vc.drepId) {
        voteCountMap.set(vc.drepId, vc._count.id);
      }
    }

    // Map to response format
    const drepSummaries: DRepSummary[] = dreps.map((drep) => ({
      drepId: drep.drepId,
      name: drep.name,
      iconUrl: drep.iconUrl,
      votingPower: drep.votingPower.toString(),
      votingPowerAda: lovelaceToAda(drep.votingPower),
      totalVotesCast: voteCountMap.get(drep.drepId) || 0,
    }));

    // If sorting by totalVotes, we need to sort in memory after getting counts
    if (sortBy === "totalVotes") {
      drepSummaries.sort((a, b) => {
        const diff = a.totalVotesCast - b.totalVotesCast;
        return sortOrder === "asc" ? diff : -diff;
      });
    }

    const response: GetDRepsResponse = {
      dreps: drepSummaries,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching DReps list", error);
    res.status(500).json({
      error: "Failed to fetch DReps",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
