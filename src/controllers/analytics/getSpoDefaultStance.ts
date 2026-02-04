import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetSpoDefaultStanceResponse,
  ProposalDefaultStance,
} from "../../responses/analytics.response";

/**
 * GET /analytics/spo-default-stance
 * Returns SPO default stance adoption rates (always abstain / always no confidence)
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - status: Filter by proposal status (optional, comma-separated)
 * - epochStart: Filter proposals by submission epoch >= epochStart
 * - epochEnd: Filter proposals by submission epoch <= epochEnd
 */
export const getSpoDefaultStance = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(req.query.pageSize as string) || 20)
    );
    const statusFilter = (req.query.status as string)?.split(",").filter(Boolean);
    const epochStart = req.query.epochStart
      ? parseInt(req.query.epochStart as string)
      : null;
    const epochEnd = req.query.epochEnd
      ? parseInt(req.query.epochEnd as string)
      : null;

    // Build where clause
    const whereClause: any = {};
    if (statusFilter && statusFilter.length > 0) {
      whereClause.status = { in: statusFilter };
    }
    if (epochStart !== null) {
      whereClause.submissionEpoch = { ...whereClause.submissionEpoch, gte: epochStart };
    }
    if (epochEnd !== null) {
      whereClause.submissionEpoch = { ...whereClause.submissionEpoch, lte: epochEnd };
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
          spoAlwaysAbstainVotePower: true,
          spoAlwaysNoConfidencePower: true,
          spoTotalVotePower: true,
        },
      }),
    ]);

    // Calculate default stance adoption for each proposal
    const proposals: ProposalDefaultStance[] = dbProposals.map((p) => {
      const spoTotal = p.spoTotalVotePower ?? 0n;
      const alwaysAbstain = p.spoAlwaysAbstainVotePower ?? 0n;
      const alwaysNoConfidence = p.spoAlwaysNoConfidencePower ?? 0n;

      const alwaysAbstainPct =
        spoTotal > 0n
          ? Number((alwaysAbstain * 10000n) / spoTotal) / 100
          : null;

      const alwaysNoConfidencePct =
        spoTotal > 0n
          ? Number((alwaysNoConfidence * 10000n) / spoTotal) / 100
          : null;

      return {
        proposalId: p.proposalId,
        title: p.title,
        spoAlwaysAbstainVotePower: alwaysAbstain.toString(),
        spoAlwaysNoConfidencePower: alwaysNoConfidence.toString(),
        spoTotalVotePower: spoTotal.toString(),
        alwaysAbstainPct,
        alwaysNoConfidencePct,
      };
    });

    const response: GetSpoDefaultStanceResponse = {
      proposals,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching SPO default stance", error);
    res.status(500).json({
      error: "Failed to fetch SPO default stance",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
