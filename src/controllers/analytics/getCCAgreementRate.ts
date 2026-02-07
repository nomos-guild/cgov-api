import { Request, Response } from "express";
import { VoterType, VoteType } from "@prisma/client";
import { prisma } from "../../services";
import {
  GetCCAgreementRateResponse,
  ProposalCCAgreement,
} from "../../responses/analytics.response";

/**
 * GET /analytics/cc-agreement-rate
 * Returns CC vote agreement rate per proposal
 *
 * Agreement rate = percentage of (latest) CC member votes on the proposal
 * that match the proposal's majority vote (among votes cast).
 *
 * Query params:
 * - page: Page number (optional; when omitted along with pageSize, returns all proposals)
 * - pageSize: Items per page (optional; max: 100)
 * - status: Filter by proposal status (optional, comma-separated)
 */
export const getCCAgreementRate = async (req: Request, res: Response) => {
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
        vote: { not: null },
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
    const proposalVotes = new Map<string, Map<string, VoteType>>();
    const seenVotes = new Set<string>();

    for (const vote of ccVotes) {
      const key = `${vote.ccId}-${vote.proposalId}`;
      if (!seenVotes.has(key) && vote.vote) {
        seenVotes.add(key);
        if (!proposalVotes.has(vote.proposalId)) {
          proposalVotes.set(vote.proposalId, new Map());
        }
        proposalVotes.get(vote.proposalId)!.set(vote.ccId!, vote.vote);
      }
    }

    // Calculate agreement rate for each proposal
    const proposals: ProposalCCAgreement[] = dbProposals.map((p) => {
      const voteMap = proposalVotes.get(p.proposalId) ?? new Map();
      const votes = Array.from(voteMap.values());

      if (votes.length === 0) {
        return {
          proposalId: p.proposalId,
          title: p.title,
          majorityVote: null,
          matchingVotes: 0,
          totalVotes: 0,
          agreementRatePct: 0,
        };
      }

      // Count votes by type
      const voteCounts: Record<string, number> = {
        [VoteType.YES]: 0,
        [VoteType.NO]: 0,
        [VoteType.ABSTAIN]: 0,
      };

      for (const vote of votes) {
        voteCounts[vote] = (voteCounts[vote] ?? 0) + 1;
      }

      // Find majority
      let majorityVote: VoteType | null = null;
      let maxCount = 0;
      for (const [vote, count] of Object.entries(voteCounts)) {
        if (count > maxCount) {
          maxCount = count;
          majorityVote = vote as VoteType;
        }
      }

      const matchingVotes = maxCount;
      const totalVotes = votes.length;
      const agreementRatePct =
        totalVotes > 0
          ? Math.round((matchingVotes / totalVotes) * 10000) / 100
          : 0;

      return {
        proposalId: p.proposalId,
        title: p.title,
        majorityVote,
        matchingVotes,
        totalVotes,
        agreementRatePct,
      };
    });

    // Calculate aggregate agreement rate
    const totalMatching = proposals.reduce((acc, p) => acc + p.matchingVotes, 0);
    const totalVotes = proposals.reduce((acc, p) => acc + p.totalVotes, 0);
    const aggregateAgreementRatePct =
      totalVotes > 0
        ? Math.round((totalMatching / totalVotes) * 10000) / 100
        : 0;

    const response: GetCCAgreementRateResponse = {
      proposals,
      aggregateAgreementRatePct,
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
    console.error("Error fetching CC agreement rate", error);
    res.status(500).json({
      error: "Failed to fetch CC agreement rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
