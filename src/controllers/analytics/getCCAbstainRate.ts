import { Request, Response } from "express";
import { VoterType, VoteType } from "@prisma/client";
import { prisma } from "../../services";
import {
  GetCCAbstainRateResponse,
  ProposalCCAbstainRate,
} from "../../responses/analytics.response";

/**
 * GET /analytics/cc-abstain-rate
 * Returns CC abstain rate per proposal
 *
 * Query params:
 * - page: Page number (optional; when omitted along with pageSize, returns all proposals)
 * - pageSize: Items per page (optional; max: 100)
 * - status: Filter by proposal status (optional, comma-separated)
 */
export const getCCAbstainRate = async (req: Request, res: Response) => {
  try {
    const pageParam = req.query.page as string | undefined;
    const pageSizeParam = req.query.pageSize as string | undefined;
    const shouldPaginate = Boolean(pageParam || pageSizeParam);

    const page = shouldPaginate
      ? Math.max(1, parseInt(pageParam ?? "1") || 1)
      : 1;
    const pageSize = shouldPaginate
      ? Math.min(100, Math.max(1, parseInt(pageSizeParam ?? "20") || 20))
      : undefined;
    const statusFilter = (req.query.status as string)?.split(",").filter(Boolean);

    // Build where clause
    const whereClause: any = {};
    if (statusFilter && statusFilter.length > 0) {
      whereClause.status = { in: statusFilter };
    }

    // Get total count and proposals
    const [totalItems, dbProposals] = await Promise.all([
      prisma.proposal.count({ where: whereClause }),
      prisma.proposal.findMany({
        where: whereClause,
        orderBy: { submissionEpoch: "desc" },
        ...(shouldPaginate
          ? {
              skip: (page - 1) * (pageSize as number),
              take: pageSize as number,
            }
          : {}),
        select: {
          proposalId: true,
          title: true,
        },
      }),
    ]);

    const proposalIds = dbProposals.map((p) => p.proposalId);

    // Get CC votes for these proposals (latest vote per CC member)
    const ccVotes = await prisma.onchainVote.findMany({
      where: {
        proposalId: { in: proposalIds },
        voterType: VoterType.CC,
        ccId: { not: null },
      },
      select: {
        proposalId: true,
        ccId: true,
        vote: true,
        votedAt: true,
        createdAt: true,
      },
      orderBy: [{ votedAt: "desc" }, { createdAt: "desc" }],
    });

    // Group votes by proposal, keeping only latest vote per CC member
    const proposalVotes = new Map<
      string,
      { abstain: number; total: number }
    >();

    const seenVotes = new Set<string>();
    for (const vote of ccVotes) {
      const key = `${vote.ccId}-${vote.proposalId}`;
      if (!seenVotes.has(key)) {
        seenVotes.add(key);
        if (!proposalVotes.has(vote.proposalId)) {
          proposalVotes.set(vote.proposalId, { abstain: 0, total: 0 });
        }
        const stats = proposalVotes.get(vote.proposalId)!;
        stats.total++;
        if (vote.vote === VoteType.ABSTAIN) {
          stats.abstain++;
        }
      }
    }

    // Calculate abstain rate for each proposal
    const proposals: ProposalCCAbstainRate[] = dbProposals.map((p) => {
      const stats = proposalVotes.get(p.proposalId) ?? { abstain: 0, total: 0 };
      return {
        proposalId: p.proposalId,
        title: p.title,
        abstainVotes: stats.abstain,
        totalVotes: stats.total,
        abstainRatePct:
          stats.total > 0
            ? Math.round((stats.abstain / stats.total) * 10000) / 100
            : 0,
      };
    });

    // Calculate aggregate abstain rate
    const totalAbstain = proposals.reduce((acc, p) => acc + p.abstainVotes, 0);
    const totalVotes = proposals.reduce((acc, p) => acc + p.totalVotes, 0);
    const aggregateAbstainRatePct =
      totalVotes > 0
        ? Math.round((totalAbstain / totalVotes) * 10000) / 100
        : 0;

    const response: GetCCAbstainRateResponse = {
      proposals,
      aggregateAbstainRatePct,
      pagination: {
        page,
        pageSize: shouldPaginate ? (pageSize as number) : totalItems,
        totalItems,
        totalPages: shouldPaginate
          ? Math.ceil(totalItems / (pageSize as number))
          : totalItems > 0
            ? 1
            : 0,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching CC abstain rate", error);
    res.status(500).json({
      error: "Failed to fetch CC abstain rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
