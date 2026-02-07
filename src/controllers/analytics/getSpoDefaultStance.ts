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
 * - page: Page number (optional). If omitted (and pageSize omitted), returns all proposals.
 * - pageSize: Items per page (optional, max: 100). If omitted (and page omitted), returns all proposals.
 * - status: Filter by proposal status (optional, comma-separated)
 * - epochStart: Filter proposals by submission epoch >= epochStart
 * - epochEnd: Filter proposals by submission epoch <= epochEnd
 */
export const getSpoDefaultStance = async (req: Request, res: Response) => {
  try {
    const hasPageParam = req.query.page !== undefined;
    const hasPageSizeParam = req.query.pageSize !== undefined;
    const paginationRequested = hasPageParam || hasPageSizeParam;

    const page = paginationRequested
      ? Math.max(1, parseInt(req.query.page as string) || 1)
      : 1;
    const pageSize = paginationRequested
      ? Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20))
      : undefined;
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

    const dbProposals = await prisma.proposal.findMany({
      where: whereClause,
      orderBy: { submissionEpoch: "desc" },
      ...(paginationRequested
        ? {
            skip: (page - 1) * (pageSize ?? 20),
            take: pageSize ?? 20,
          }
        : {}),
      select: {
        proposalId: true,
        title: true,
        spoAlwaysAbstainVotePower: true,
        spoAlwaysNoConfidencePower: true,
        spoTotalVotePower: true,
      },
    });

    const totalItems = paginationRequested
      ? await prisma.proposal.count({ where: whereClause })
      : dbProposals.length;

    // Calculate default stance adoption for each proposal
    const proposals: ProposalDefaultStance[] = dbProposals.map((p) => {
      const spoTotal = p.spoTotalVotePower ?? 0n;
      const alwaysAbstain = p.spoAlwaysAbstainVotePower ?? 0n;
      const alwaysNoConfidence = p.spoAlwaysNoConfidencePower ?? 0n;
      const combinedDefaultStance = alwaysAbstain + alwaysNoConfidence;

      const alwaysAbstainPct =
        spoTotal > 0n
          ? Number((alwaysAbstain * 10000n) / spoTotal) / 100
          : null;

      const alwaysNoConfidencePct =
        spoTotal > 0n
          ? Number((alwaysNoConfidence * 10000n) / spoTotal) / 100
          : null;

      const combinedDefaultStancePct =
        spoTotal > 0n
          ? Number((combinedDefaultStance * 10000n) / spoTotal) / 100
          : null;

      return {
        proposalId: p.proposalId,
        title: p.title,
        spoAlwaysAbstainVotePower: alwaysAbstain.toString(),
        spoAlwaysNoConfidencePower: alwaysNoConfidence.toString(),
        combinedDefaultStancePower: combinedDefaultStance.toString(),
        spoTotalVotePower: spoTotal.toString(),
        alwaysAbstainPct,
        alwaysNoConfidencePct,
        combinedDefaultStancePct,
      };
    });

    const response: GetSpoDefaultStanceResponse = {
      proposals,
      pagination: {
        page,
        pageSize: paginationRequested ? (pageSize ?? 20) : totalItems,
        totalItems,
        totalPages: paginationRequested
          ? Math.ceil(totalItems / (pageSize ?? 20))
          : totalItems > 0
            ? 1
            : 0,
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
