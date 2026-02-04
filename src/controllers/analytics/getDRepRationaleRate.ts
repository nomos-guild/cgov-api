import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import {
  GetDRepRationaleRateResponse,
  DRepRationaleSummary,
} from "../../responses/analytics.response";

/**
 * GET /analytics/drep-rationale-rate
 * Returns DRep rationale rate (votes with rationale / total votes)
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - sortBy: Sort by "rationaleRate" | "totalVotes" | "name" (default: rationaleRate)
 * - sortOrder: Sort direction (asc, desc) (default: desc)
 */
export const getDRepRationaleRate = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(req.query.pageSize as string) || 20)
    );
    const sortBy = (req.query.sortBy as string) || "rationaleRate";
    const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";

    // Get all active DReps
    const dreps = await prisma.drep.findMany({
      where: {
        OR: [{ doNotList: false }, { doNotList: null }],
      },
      select: { drepId: true, name: true },
    });

    const drepIds = dreps.map((d) => d.drepId);

    // Get total votes per DRep
    const totalVoteCounts = await prisma.onchainVote.groupBy({
      by: ["drepId"],
      where: {
        voterType: VoterType.DREP,
        drepId: { in: drepIds },
      },
      _count: { id: true },
    });

    // Get votes with rationale per DRep
    // "Has rationale" = anchorUrl is not null/empty OR rationale is not null/empty
    const votesWithRationale = await prisma.onchainVote.findMany({
      where: {
        voterType: VoterType.DREP,
        drepId: { in: drepIds },
        OR: [
          { AND: [{ anchorUrl: { not: null } }, { anchorUrl: { not: "" } }] },
          { AND: [{ rationale: { not: null } }, { rationale: { not: "" } }] },
        ],
      },
      select: { drepId: true },
    });

    // Count by drepId
    const rationaleCountMap = new Map<string, number>();
    for (const v of votesWithRationale) {
      if (v.drepId) {
        rationaleCountMap.set(v.drepId, (rationaleCountMap.get(v.drepId) ?? 0) + 1);
      }
    }

    // Create vote count maps
    const totalCountMap = new Map<string, number>();
    for (const vc of totalVoteCounts) {
      if (vc.drepId) {
        totalCountMap.set(vc.drepId, vc._count.id);
      }
    }

    // Build summaries
    let drepSummaries: DRepRationaleSummary[] = dreps.map((drep) => {
      const totalVotes = totalCountMap.get(drep.drepId) || 0;
      const votesWithRationaleCount = rationaleCountMap.get(drep.drepId) || 0;
      return {
        drepId: drep.drepId,
        name: drep.name,
        votesWithRationale: votesWithRationaleCount,
        totalVotes,
        rationaleRatePct:
          totalVotes > 0
            ? Math.round((votesWithRationaleCount / totalVotes) * 10000) / 100
            : 0,
      };
    });

    // Sort
    drepSummaries.sort((a, b) => {
      let diff: number;
      if (sortBy === "name") {
        diff = (a.name || "").localeCompare(b.name || "");
      } else if (sortBy === "totalVotes") {
        diff = a.totalVotes - b.totalVotes;
      } else {
        diff = a.rationaleRatePct - b.rationaleRatePct;
      }
      return sortOrder === "asc" ? diff : -diff;
    });

    // Calculate aggregate rationale rate
    const totalAllVotes = drepSummaries.reduce((acc, d) => acc + d.totalVotes, 0);
    const totalWithRationale = drepSummaries.reduce(
      (acc, d) => acc + d.votesWithRationale,
      0
    );
    const aggregateRationaleRatePct =
      totalAllVotes > 0
        ? Math.round((totalWithRationale / totalAllVotes) * 10000) / 100
        : 0;

    // Paginate
    const totalItems = drepSummaries.length;
    const paginatedDreps = drepSummaries.slice(
      (page - 1) * pageSize,
      page * pageSize
    );

    const response: GetDRepRationaleRateResponse = {
      dreps: paginatedDreps,
      aggregateRationaleRatePct,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching DRep rationale rate", error);
    res.status(500).json({
      error: "Failed to fetch DRep rationale rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
