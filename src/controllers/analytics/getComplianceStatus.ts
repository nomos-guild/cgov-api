import { Request, Response } from "express";
import { VoterType, VoteType } from "@prisma/client";
import { prisma } from "../../services";
import {
  GetComplianceStatusResponse,
  ProposalComplianceStatus,
} from "../../responses/analytics.response";

/**
 * Determines constitutional status based on CC voting
 * CC approval requires >= 67% yes votes among eligible members (excluding abstentions)
 */
function determineConstitutionalStatus(
  yesVotes: number,
  noVotes: number,
  abstainVotes: number,
  eligibleMembers: number
): { ccApproved: boolean | null; constitutionalStatus: string } {
  // Minimum valid committee size
  const MIN_COMMITTEE_SIZE = 7;

  if (eligibleMembers < MIN_COMMITTEE_SIZE) {
    return { ccApproved: null, constitutionalStatus: "Committee Too Small" };
  }

  const totalVoted = yesVotes + noVotes + abstainVotes;
  if (totalVoted === 0) {
    return { ccApproved: null, constitutionalStatus: "Pending" };
  }

  // Denominator excludes abstentions
  const denominator = eligibleMembers - abstainVotes;
  if (denominator <= 0) {
    return { ccApproved: null, constitutionalStatus: "Pending" };
  }

  // 67% threshold
  const yesPct = (yesVotes / denominator) * 100;
  if (yesPct >= 67) {
    return { ccApproved: true, constitutionalStatus: "Constitutional" };
  } else if (yesVotes + noVotes > 0) {
    return { ccApproved: false, constitutionalStatus: "Unconstitutional" };
  }

  return { ccApproved: null, constitutionalStatus: "Pending" };
}

/**
 * GET /analytics/compliance-status
 * Returns constitutional compliance status per proposal
 *
 * Query params:
 * - page: Page number (optional; if omitted with pageSize, returns all proposals)
 * - pageSize: Items per page (optional, max: 100; if omitted with page, returns all proposals)
 * - status: Filter by proposal status (optional, comma-separated)
 */
export const getComplianceStatus = async (req: Request, res: Response) => {
  try {
    const pageQuery = req.query.page as string | undefined;
    const pageSizeQuery = req.query.pageSize as string | undefined;
    const shouldPaginate = pageQuery !== undefined || pageSizeQuery !== undefined;

    const page = shouldPaginate
      ? Math.max(1, parseInt(pageQuery || "1"))
      : 1;
    const pageSize = shouldPaginate
      ? Math.min(100, Math.max(1, parseInt(pageSizeQuery || "20")))
      : 0;
    const statusFilter = (req.query.status as string)?.split(",").filter(Boolean);

    // Build where clause
    const whereClause: any = {};
    if (statusFilter && statusFilter.length > 0) {
      whereClause.status = { in: statusFilter };
    }

    // Get committee state for eligible members count
    const committeeState = await prisma.committeeState.findUnique({
      where: { id: "current" },
    });
    const eligibleMembers = committeeState?.eligibleMembers ?? 7;

    // Get total count and proposals
    const [totalItems, dbProposals] = await Promise.all([
      prisma.proposal.count({ where: whereClause }),
      prisma.proposal.findMany({
        where: whereClause,
        orderBy: { submissionEpoch: "desc" },
        ...(shouldPaginate
          ? {
              skip: (page - 1) * pageSize,
              take: pageSize,
            }
          : {}),
        select: {
          proposalId: true,
          title: true,
          status: true,
        },
      }),
    ]);

    const proposalIds = dbProposals.map((p) => p.proposalId);

    // Get CC votes for these proposals
    // Use latest vote per CC member per proposal
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
      Map<string, VoteType | null>
    >();

    for (const vote of ccVotes) {
      if (!proposalVotes.has(vote.proposalId)) {
        proposalVotes.set(vote.proposalId, new Map());
      }
      const ccVoteMap = proposalVotes.get(vote.proposalId)!;
      // Only set if not already set (first = latest due to orderBy)
      if (!ccVoteMap.has(vote.ccId!)) {
        ccVoteMap.set(vote.ccId!, vote.vote);
      }
    }

    // Calculate compliance status for each proposal
    const proposals: ProposalComplianceStatus[] = dbProposals.map((p) => {
      const ccVoteMap = proposalVotes.get(p.proposalId) ?? new Map();

      let ccYesVotes = 0;
      let ccNoVotes = 0;
      let ccAbstainVotes = 0;

      for (const vote of ccVoteMap.values()) {
        if (vote === VoteType.YES) ccYesVotes++;
        else if (vote === VoteType.NO) ccNoVotes++;
        else if (vote === VoteType.ABSTAIN) ccAbstainVotes++;
      }

      const totalVoted = ccYesVotes + ccNoVotes + ccAbstainVotes;
      const ccNotVoted = eligibleMembers - totalVoted;

      const { ccApproved, constitutionalStatus } = determineConstitutionalStatus(
        ccYesVotes,
        ccNoVotes,
        ccAbstainVotes,
        eligibleMembers
      );

      return {
        proposalId: p.proposalId,
        title: p.title,
        status: p.status,
        ccApproved,
        constitutionalStatus,
        ccYesVotes,
        ccNoVotes,
        ccAbstainVotes,
        ccNotVoted: Math.max(0, ccNotVoted),
        eligibleMembers,
      };
    });

    const overview: GetComplianceStatusResponse["overview"] = {
      eligibleMembers,
      totalProposals: totalItems,
      ccApprovedCounts: {
        approved: 0,
        rejected: 0,
        pending: 0,
      },
      constitutionalStatusCounts: {
        constitutional: 0,
        unconstitutional: 0,
        pending: 0,
        committeeTooSmall: 0,
      },
    };

    for (const proposal of proposals) {
      if (proposal.ccApproved === true) overview.ccApprovedCounts.approved++;
      else if (proposal.ccApproved === false) overview.ccApprovedCounts.rejected++;
      else overview.ccApprovedCounts.pending++;

      if (proposal.constitutionalStatus === "Constitutional") {
        overview.constitutionalStatusCounts.constitutional++;
      } else if (proposal.constitutionalStatus === "Unconstitutional") {
        overview.constitutionalStatusCounts.unconstitutional++;
      } else if (proposal.constitutionalStatus === "Committee Too Small") {
        overview.constitutionalStatusCounts.committeeTooSmall++;
      } else {
        overview.constitutionalStatusCounts.pending++;
      }
    }

    const effectivePageSize = shouldPaginate ? pageSize : totalItems;
    const response: GetComplianceStatusResponse = {
      overview,
      proposals,
      pagination: {
        page: shouldPaginate ? page : 1,
        pageSize: effectivePageSize,
        totalItems,
        totalPages: effectivePageSize > 0 ? Math.ceil(totalItems / effectivePageSize) : 0,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching compliance status", error);
    res.status(500).json({
      error: "Failed to fetch compliance status",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
