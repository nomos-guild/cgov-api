import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import {
  GetDRepActivityRateResponse,
  DRepActivitySummary,
} from "../../responses/analytics.response";

/**
 * GET /analytics/drep-activity-rate
 * Returns DRep activity rate (proposals voted / proposals in scope)
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - epochStart: Filter proposals by submission epoch >= epochStart
 * - epochEnd: Filter proposals by submission epoch <= epochEnd
 * - status: Filter proposals by status (comma-separated, default: all)
 * - sortBy: Sort by "activityRate" | "proposalsVoted" | "name" (default: activityRate)
 * - sortOrder: Sort direction (asc, desc) (default: desc)
 */
export const getDRepActivityRate = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(req.query.pageSize as string) || 20)
    );
    const epochStart = req.query.epochStart
      ? parseInt(req.query.epochStart as string)
      : null;
    const epochEnd = req.query.epochEnd
      ? parseInt(req.query.epochEnd as string)
      : null;
    const statusFilter = (req.query.status as string)?.split(",").filter(Boolean);
    const sortBy = (req.query.sortBy as string) || "activityRate";
    const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";

    // Build proposal filter
    const proposalWhere: any = {};
    if (epochStart !== null) {
      proposalWhere.submissionEpoch = { ...proposalWhere.submissionEpoch, gte: epochStart };
    }
    if (epochEnd !== null) {
      proposalWhere.submissionEpoch = { ...proposalWhere.submissionEpoch, lte: epochEnd };
    }
    if (statusFilter && statusFilter.length > 0) {
      proposalWhere.status = { in: statusFilter };
    }

    // Get total proposals in scope
    const totalProposals = await prisma.proposal.count({
      where: proposalWhere,
    });

    // Get proposal IDs in scope
    const proposalsInScope = await prisma.proposal.findMany({
      where: proposalWhere,
      select: { proposalId: true },
    });
    const proposalIds = proposalsInScope.map((p) => p.proposalId);

    // Get all active DReps (not marked as do-not-list)
    const dreps = await prisma.drep.findMany({
      where: {
        OR: [{ doNotList: false }, { doNotList: null }],
      },
      select: { drepId: true, name: true },
    });

    // Count votes per DRep for proposals in scope
    const voteCounts = await prisma.onchainVote.groupBy({
      by: ["drepId"],
      where: {
        voterType: VoterType.DREP,
        drepId: { not: null },
        proposalId: { in: proposalIds },
      },
      _count: { proposalId: true },
    });

    // Create map of drepId -> proposal count
    const voteCountMap = new Map<string, number>();
    for (const vc of voteCounts) {
      if (vc.drepId) {
        voteCountMap.set(vc.drepId, vc._count.proposalId);
      }
    }

    // Build activity summaries
    let drepSummaries: DRepActivitySummary[] = dreps.map((drep) => {
      const proposalsVoted = voteCountMap.get(drep.drepId) || 0;
      return {
        drepId: drep.drepId,
        name: drep.name,
        proposalsVoted,
        totalProposals,
        activityRatePct:
          totalProposals > 0
            ? Math.round((proposalsVoted / totalProposals) * 10000) / 100
            : 0,
      };
    });

    // Sort
    drepSummaries.sort((a, b) => {
      let diff: number;
      if (sortBy === "name") {
        diff = (a.name || "").localeCompare(b.name || "");
      } else if (sortBy === "proposalsVoted") {
        diff = a.proposalsVoted - b.proposalsVoted;
      } else {
        diff = a.activityRatePct - b.activityRatePct;
      }
      return sortOrder === "asc" ? diff : -diff;
    });

    // Calculate aggregate activity rate
    const totalVotes = drepSummaries.reduce((acc, d) => acc + d.proposalsVoted, 0);
    const aggregateActivityRatePct =
      totalProposals > 0 && drepSummaries.length > 0
        ? Math.round(
            (totalVotes / (totalProposals * drepSummaries.length)) * 10000
          ) / 100
        : 0;

    // Paginate
    const totalItems = drepSummaries.length;
    const paginatedDreps = drepSummaries.slice(
      (page - 1) * pageSize,
      page * pageSize
    );

    const response: GetDRepActivityRateResponse = {
      dreps: paginatedDreps,
      aggregateActivityRatePct,
      filter: {
        epochStart,
        epochEnd,
        statuses: statusFilter || [],
      },
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching DRep activity rate", error);
    res.status(500).json({
      error: "Failed to fetch DRep activity rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
