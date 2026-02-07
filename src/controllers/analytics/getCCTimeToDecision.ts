import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import {
  GetCCTimeToDecisionResponse,
  ProposalCCTimeToDecision,
} from "../../responses/analytics.response";

/**
 * Calculates percentile from sorted array
 */
function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

/**
 * GET /analytics/cc-time-to-decision
 * Returns time-to-decision metrics for Constitutional Committee
 *
 * Measures time from proposal submission to first and last CC vote.
 * Submission time uses the epoch start timestamp when available, otherwise falls back to proposal createdAt.
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - status: Filter by proposal status (optional, comma-separated)
 */
export const getCCTimeToDecision = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(req.query.pageSize as string) || 20)
    );
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
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          proposalId: true,
          title: true,
          submissionEpoch: true,
          createdAt: true,
        },
      }),
    ]);

    const proposalIds = dbProposals.map((p) => p.proposalId);

    // Get first CC vote per proposal (earliest votedAt)
    const ccVotes = await prisma.onchainVote.findMany({
      where: {
        proposalId: { in: proposalIds },
        voterType: VoterType.CC,
        votedAt: { not: null },
      },
      select: {
        proposalId: true,
        votedAt: true,
      },
      orderBy: { votedAt: "asc" },
    });

    // Get first/last CC vote per proposal
    const firstCcVoteMap = new Map<string, Date>();
    const lastCcVoteMap = new Map<string, Date>();
    for (const vote of ccVotes) {
      if (!vote.votedAt) continue;

      if (!firstCcVoteMap.has(vote.proposalId)) {
        firstCcVoteMap.set(vote.proposalId, vote.votedAt);
      }
      lastCcVoteMap.set(vote.proposalId, vote.votedAt);
    }

    // Get epoch timestamps for submission time
    const submissionEpochs = new Set<number>();
    for (const p of dbProposals) {
      if (p.submissionEpoch !== null) {
        submissionEpochs.add(p.submissionEpoch);
      }
    }

    const epochTimestamps = await prisma.epochTotals.findMany({
      where: { epoch: { in: Array.from(submissionEpochs) } },
      select: { epoch: true, startTime: true },
    });

    const epochTimeMap = new Map<number, Date>();
    for (const et of epochTimestamps) {
      if (et.startTime) {
        epochTimeMap.set(et.epoch, et.startTime);
      }
    }

    // Calculate time to decision for each proposal
    const proposals: ProposalCCTimeToDecision[] = dbProposals.map((p) => {
      const firstCcVoteAt = firstCcVoteMap.get(p.proposalId);
      const lastCcVoteAt = lastCcVoteMap.get(p.proposalId);

      // Use epoch start time if available, otherwise proposal createdAt
      let submissionTime: Date | null = null;
      if (p.submissionEpoch !== null) {
        submissionTime = epochTimeMap.get(p.submissionEpoch) ?? null;
      }
      if (!submissionTime && p.createdAt) {
        submissionTime = p.createdAt;
      }

      let hoursToFirstVote: number | null = null;
      let daysToFirstVote: number | null = null;
      let hoursToLastVote: number | null = null;
      let daysToLastVote: number | null = null;

      if (firstCcVoteAt && submissionTime) {
        const diffMs = firstCcVoteAt.getTime() - submissionTime.getTime();
        hoursToFirstVote = Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10;
        daysToFirstVote = Math.round((diffMs / (1000 * 60 * 60 * 24)) * 10) / 10;
      }

      if (lastCcVoteAt && submissionTime) {
        const diffMs = lastCcVoteAt.getTime() - submissionTime.getTime();
        hoursToLastVote = Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10;
        daysToLastVote = Math.round((diffMs / (1000 * 60 * 60 * 24)) * 10) / 10;
      }

      return {
        proposalId: p.proposalId,
        title: p.title,
        submissionEpoch: p.submissionEpoch,
        firstCcVoteAt: firstCcVoteAt?.toISOString() ?? null,
        lastCcVoteAt: lastCcVoteAt?.toISOString() ?? null,
        hoursToFirstVote,
        daysToFirstVote,
        hoursToLastVote,
        daysToLastVote,
      };
    });

    // Calculate stats from all proposals with CC votes
    const allProposalsWithCcVotes = await prisma.proposal.findMany({
      where: whereClause,
      select: {
        proposalId: true,
        submissionEpoch: true,
        createdAt: true,
      },
    });

    const allCcVotes = await prisma.onchainVote.findMany({
      where: {
        proposalId: { in: allProposalsWithCcVotes.map((p) => p.proposalId) },
        voterType: VoterType.CC,
        votedAt: { not: null },
      },
      select: {
        proposalId: true,
        votedAt: true,
      },
      orderBy: { votedAt: "asc" },
    });

    const allFirstCcVoteMap = new Map<string, Date>();
    const allLastCcVoteMap = new Map<string, Date>();
    for (const vote of allCcVotes) {
      if (!vote.votedAt) continue;

      if (!allFirstCcVoteMap.has(vote.proposalId)) {
        allFirstCcVoteMap.set(vote.proposalId, vote.votedAt);
      }
      allLastCcVoteMap.set(vote.proposalId, vote.votedAt);
    }

    // Get all submission epochs
    const allSubmissionEpochs = new Set<number>();
    for (const p of allProposalsWithCcVotes) {
      if (p.submissionEpoch !== null) {
        allSubmissionEpochs.add(p.submissionEpoch);
      }
    }

    const allEpochTimestamps = await prisma.epochTotals.findMany({
      where: { epoch: { in: Array.from(allSubmissionEpochs) } },
      select: { epoch: true, startTime: true },
    });

    const allEpochTimeMap = new Map<number, Date>();
    for (const et of allEpochTimestamps) {
      if (et.startTime) {
        allEpochTimeMap.set(et.epoch, et.startTime);
      }
    }

    const hourDeltas: number[] = [];
    const dayDeltas: number[] = [];
    const hourDeltasLast: number[] = [];
    const dayDeltasLast: number[] = [];

    for (const p of allProposalsWithCcVotes) {
      const firstCcVoteAt = allFirstCcVoteMap.get(p.proposalId);
      const lastCcVoteAt = allLastCcVoteMap.get(p.proposalId);
      let submissionTime: Date | null = null;
      if (p.submissionEpoch !== null) {
        submissionTime = allEpochTimeMap.get(p.submissionEpoch) ?? null;
      }
      if (!submissionTime && p.createdAt) {
        submissionTime = p.createdAt;
      }

      if (firstCcVoteAt && submissionTime) {
        const diffMs = firstCcVoteAt.getTime() - submissionTime.getTime();
        hourDeltas.push(diffMs / (1000 * 60 * 60));
        dayDeltas.push(diffMs / (1000 * 60 * 60 * 24));
      }

      if (lastCcVoteAt && submissionTime) {
        const diffMs = lastCcVoteAt.getTime() - submissionTime.getTime();
        hourDeltasLast.push(diffMs / (1000 * 60 * 60));
        dayDeltasLast.push(diffMs / (1000 * 60 * 60 * 24));
      }
    }

    hourDeltas.sort((a, b) => a - b);
    dayDeltas.sort((a, b) => a - b);
    hourDeltasLast.sort((a, b) => a - b);
    dayDeltasLast.sort((a, b) => a - b);

    const response: GetCCTimeToDecisionResponse = {
      proposals,
      stats: {
        medianHoursToVote:
          percentile(hourDeltas, 50) !== null
            ? Math.round(percentile(hourDeltas, 50)! * 10) / 10
            : null,
        medianDaysToVote:
          percentile(dayDeltas, 50) !== null
            ? Math.round(percentile(dayDeltas, 50)! * 10) / 10
            : null,
        p90HoursToVote:
          percentile(hourDeltas, 90) !== null
            ? Math.round(percentile(hourDeltas, 90)! * 10) / 10
            : null,
        p90DaysToVote:
          percentile(dayDeltas, 90) !== null
            ? Math.round(percentile(dayDeltas, 90)! * 10) / 10
            : null,

        medianHoursToLastVote:
          percentile(hourDeltasLast, 50) !== null
            ? Math.round(percentile(hourDeltasLast, 50)! * 10) / 10
            : null,
        medianDaysToLastVote:
          percentile(dayDeltasLast, 50) !== null
            ? Math.round(percentile(dayDeltasLast, 50)! * 10) / 10
            : null,
        p90HoursToLastVote:
          percentile(hourDeltasLast, 90) !== null
            ? Math.round(percentile(hourDeltasLast, 90)! * 10) / 10
            : null,
        p90DaysToLastVote:
          percentile(dayDeltasLast, 90) !== null
            ? Math.round(percentile(dayDeltasLast, 90)! * 10) / 10
            : null,
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
    console.error("Error fetching CC time to decision", error);
    res.status(500).json({
      error: "Failed to fetch CC time to decision",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
