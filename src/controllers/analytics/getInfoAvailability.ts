import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetInfoAvailabilityResponse,
  ProposalInfoCompleteness,
  VoteInfoCompleteness,
} from "../../responses/analytics.response";

/**
 * GET /analytics/info-availability
 * Returns governance information availability metrics
 *
 * Measures completeness of proposal and vote metadata
 *
 * Query params:
 * - page: Page number (optional). If omitted (and pageSize omitted), returns all proposals.
 * - pageSize: Items per page (optional, max: 100). If omitted (and page omitted), returns all proposals.
 * - status: Filter by proposal status (optional, comma-separated)
 */
export const getInfoAvailability = async (req: Request, res: Response) => {
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

    // Build where clause
    const whereClause: any = {};
    if (statusFilter && statusFilter.length > 0) {
      whereClause.status = { in: statusFilter };
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
        description: true,
        rationale: true,
        metadata: true,
      },
    });

    const totalItems = paginationRequested
      ? await prisma.proposal.count({ where: whereClause })
      : dbProposals.length;

    // Calculate info completeness for each proposal
    const proposals: ProposalInfoCompleteness[] = dbProposals.map((p) => {
      const hasTitle = p.title !== null && p.title.trim() !== "";
      const hasDescription = p.description !== null && p.description.trim() !== "";
      const hasRationale = p.rationale !== null && p.rationale.trim() !== "";
      const hasMetadata = p.metadata !== null && p.metadata.trim() !== "";

      // Calculate completeness score (each field worth 25%)
      const fields = [hasTitle, hasDescription, hasRationale, hasMetadata];
      const filledCount = fields.filter(Boolean).length;
      const completenessScore = Math.round((filledCount / 4) * 100);

      return {
        proposalId: p.proposalId,
        title: p.title,
        hasTitle,
        hasDescription,
        hasRationale,
        hasMetadata,
        completenessScore,
      };
    });

    // Calculate aggregate proposal completeness
    const totalCompleteness = proposals.reduce(
      (acc, p) => acc + p.completenessScore,
      0
    );
    const aggregateProposalCompletenessPct =
      proposals.length > 0
        ? Math.round((totalCompleteness / proposals.length) * 100) / 100
        : 0;

    // Get vote info completeness
    // "Has info" = has anchorUrl or has rationale (non-empty)
    const [votesWithInfo, totalVotes] = await Promise.all([
      prisma.onchainVote.count({
        where: {
          OR: [
            { AND: [{ anchorUrl: { not: null } }, { anchorUrl: { not: "" } }] },
            { AND: [{ rationale: { not: null } }, { rationale: { not: "" } }] },
          ],
        },
      }),
      prisma.onchainVote.count(),
    ]);

    const voteInfoRatePct =
      totalVotes > 0
        ? Math.round((votesWithInfo / totalVotes) * 10000) / 100
        : 0;

    const votes: VoteInfoCompleteness = {
      votesWithInfo,
      totalVotes,
      infoRatePct: voteInfoRatePct,
    };

    const response: GetInfoAvailabilityResponse = {
      proposals,
      votes,
      aggregateProposalCompletenessPct,
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
    console.error("Error fetching info availability", error);
    res.status(500).json({
      error: "Failed to fetch info availability",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
