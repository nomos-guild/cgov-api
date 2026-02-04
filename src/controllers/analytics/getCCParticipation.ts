import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import {
  GetCCParticipationResponse,
  CCMemberParticipation,
} from "../../responses/analytics.response";

/**
 * GET /analytics/cc-participation
 * Returns CC member participation rate
 *
 * Query params:
 * - status: Filter by proposal status (optional, comma-separated)
 */
export const getCCParticipation = async (req: Request, res: Response) => {
  try {
    const statusFilter = (req.query.status as string)?.split(",").filter(Boolean);

    // Build proposal where clause
    const proposalWhere: any = {};
    if (statusFilter && statusFilter.length > 0) {
      proposalWhere.status = { in: statusFilter };
    }

    // Get committee state for eligible members count
    const committeeState = await prisma.committeeState.findUnique({
      where: { id: "current" },
    });
    const eligibleMembers = committeeState?.eligibleMembers ?? 7;

    // Get total proposals in scope
    const totalProposals = await prisma.proposal.count({
      where: proposalWhere,
    });

    // Get all CC members
    const ccMembers = await prisma.cC.findMany({
      select: { ccId: true, memberName: true },
    });

    // Get proposal IDs in scope
    const proposals = await prisma.proposal.findMany({
      where: proposalWhere,
      select: { proposalId: true },
    });
    const proposalIds = proposals.map((p) => p.proposalId);

    // Get CC votes for proposals in scope
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
        votedAt: true,
        createdAt: true,
      },
      orderBy: [{ votedAt: "desc" }, { createdAt: "desc" }],
    });

    // Count distinct proposals voted per CC member (latest vote only)
    const ccProposalVotes = new Map<string, Set<string>>();
    const seenVotes = new Set<string>(); // ccId-proposalId combinations

    for (const vote of ccVotes) {
      const key = `${vote.ccId}-${vote.proposalId}`;
      if (!seenVotes.has(key)) {
        seenVotes.add(key);
        if (!ccProposalVotes.has(vote.ccId!)) {
          ccProposalVotes.set(vote.ccId!, new Set());
        }
        ccProposalVotes.get(vote.ccId!)!.add(vote.proposalId);
      }
    }

    // Build member participation list
    const members: CCMemberParticipation[] = ccMembers.map((cc) => {
      const proposalsVoted = ccProposalVotes.get(cc.ccId)?.size ?? 0;
      return {
        ccId: cc.ccId,
        memberName: cc.memberName,
        proposalsVoted,
        totalProposals,
        participationRatePct:
          totalProposals > 0
            ? Math.round((proposalsVoted / totalProposals) * 10000) / 100
            : 0,
      };
    });

    // Sort by participation rate descending
    members.sort((a, b) => b.participationRatePct - a.participationRatePct);

    // Calculate aggregate participation
    // = total CC member-proposal votes / (eligible members * total proposals)
    const totalMemberVotes = members.reduce((acc, m) => acc + m.proposalsVoted, 0);
    const maxPossibleVotes = eligibleMembers * totalProposals;
    const aggregateParticipationPct =
      maxPossibleVotes > 0
        ? Math.round((totalMemberVotes / maxPossibleVotes) * 10000) / 100
        : 0;

    const response: GetCCParticipationResponse = {
      members,
      aggregateParticipationPct,
      eligibleMembers,
      totalProposals,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching CC participation", error);
    res.status(500).json({
      error: "Failed to fetch CC participation",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
