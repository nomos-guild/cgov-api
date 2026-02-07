import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetContentionRateResponse,
  ProposalContention,
} from "../../responses/analytics.response";
import {
  computeDrepLedgerBuckets,
  computeSpoLedgerBuckets,
} from "../../libs/ledgerVoteMath";
import { getVotingThreshold } from "../../libs/proposalMapper";

/**
 * Determines if a proposal is contentious based on vote split
 * A proposal is contentious if the yes/no split is close (e.g., 45-55%)
 */
function calculateContention(
  yesPct: number | null,
  noPct: number | null
): { isContentious: boolean; contentionScore: number | null } {
  if (yesPct === null || noPct === null) {
    return { isContentious: false, contentionScore: null };
  }

  // Contention score based on how close the vote is
  // Max contention = 50/50 split = 100 score
  // No contention = 100/0 or 0/100 = 0 score
  const diff = Math.abs(yesPct - noPct);
  const contentionScore = Math.round((100 - diff) * 100) / 100;

  // Contentious if the difference is less than 20% (i.e., 40-60 split or closer)
  const isContentious = diff < 20;

  return { isContentious, contentionScore };
}

/**
 * GET /analytics/contention-rate
 * Returns governance action contention rate
 *
 * Query params:
 * - page: Page number (optional; if omitted along with pageSize, returns all proposals)
 * - pageSize: Items per page (optional; max: 100)
 * - status: Filter by proposal status (optional, comma-separated)
 * - governanceActionType: Filter by action type (optional, comma-separated)
 * - epochStart: Filter proposals by submission epoch >= epochStart
 * - epochEnd: Filter proposals by submission epoch <= epochEnd
 * - contentiousOnly: If "true", only return contentious proposals
 */
export const getContentionRate = async (req: Request, res: Response) => {
  try {
    const hasPaginationParams =
      req.query.page !== undefined || req.query.pageSize !== undefined;

    const page = hasPaginationParams
      ? Math.max(1, parseInt(req.query.page as string) || 1)
      : 1;
    const pageSize = hasPaginationParams
      ? Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20))
      : null;
    const statusFilter = (req.query.status as string)?.split(",").filter(Boolean);
    const typeFilter = (req.query.governanceActionType as string)
      ?.split(",")
      .filter(Boolean);
    const epochStart = req.query.epochStart
      ? parseInt(req.query.epochStart as string)
      : null;
    const epochEnd = req.query.epochEnd
      ? parseInt(req.query.epochEnd as string)
      : null;
    const contentiousOnly = req.query.contentiousOnly === "true";

    // Build where clause
    const whereClause: any = {};
    if (statusFilter && statusFilter.length > 0) {
      whereClause.status = { in: statusFilter };
    }
    if (typeFilter && typeFilter.length > 0) {
      whereClause.governanceActionType = { in: typeFilter };
    }
    if (epochStart !== null) {
      whereClause.submissionEpoch = { ...whereClause.submissionEpoch, gte: epochStart };
    }
    if (epochEnd !== null) {
      whereClause.submissionEpoch = { ...whereClause.submissionEpoch, lte: epochEnd };
    }

    // Get all proposals for contention analysis
    const allProposals = await prisma.proposal.findMany({
      where: whereClause,
      orderBy: { submissionEpoch: "desc" },
      select: {
        proposalId: true,
        title: true,
        governanceActionType: true,
        submissionEpoch: true,
        drepActiveYesVotePower: true,
        drepActiveNoVotePower: true,
        drepActiveAbstainVotePower: true,
        drepAlwaysAbstainVotePower: true,
        drepAlwaysNoConfidencePower: true,
        drepInactiveVotePower: true,
        drepTotalVotePower: true,
        spoActiveYesVotePower: true,
        spoActiveNoVotePower: true,
        spoActiveAbstainVotePower: true,
        spoAlwaysAbstainVotePower: true,
        spoAlwaysNoConfidencePower: true,
        spoNoVotePower: true,
        spoTotalVotePower: true,
      },
    });

    // Calculate contention for each proposal
    let allContentions: ProposalContention[] = allProposals.map((p) => {
      const drepBuckets = computeDrepLedgerBuckets(p);
      const spoBuckets = computeSpoLedgerBuckets(p);

      // Use ledger outcome percentages (yes/no) so contention reflects ratification math
      const drepRatificationYesPct = drepBuckets.yesOutcomePct;
      const drepRatificationNoPct = drepBuckets.noOutcomePct;
      const spoRatificationYesPct = spoBuckets.yesOutcomePct;
      const spoRatificationNoPct = spoBuckets.noOutcomePct;

      // Backward compat: simple active/total percentages
      const drepTotal = p.drepTotalVotePower ?? 0n;
      const spoTotal = p.spoTotalVotePower ?? 0n;
      const drepYesPct =
        drepTotal > 0n
          ? Number(((p.drepActiveYesVotePower ?? 0n) * 10000n) / drepTotal) / 100
          : null;
      const drepNoPct =
        drepTotal > 0n
          ? Number(((p.drepActiveNoVotePower ?? 0n) * 10000n) / drepTotal) / 100
          : null;
      const spoYesPct =
        spoTotal > 0n
          ? Number(((p.spoActiveYesVotePower ?? 0n) * 10000n) / spoTotal) / 100
          : null;
      const spoNoPct =
        spoTotal > 0n
          ? Number(((p.spoActiveNoVotePower ?? 0n) * 10000n) / spoTotal) / 100
          : null;

      // Use DRep contention as primary, fallback to SPO (ratification math)
      let contention = calculateContention(
        drepRatificationYesPct,
        drepRatificationNoPct
      );
      if (contention.contentionScore === null) {
        contention = calculateContention(
          spoRatificationYesPct,
          spoRatificationNoPct
        );
      }

      const thresholds = getVotingThreshold(p.governanceActionType);
      const drepThreshold = thresholds.drepThreshold ?? null;
      const spoThreshold = thresholds.spoThreshold ?? null;

      const drepDistanceFromThreshold =
        drepRatificationYesPct !== null && drepThreshold !== null
          ? Number((drepRatificationYesPct - drepThreshold * 100).toFixed(2))
          : null;
      const spoDistanceFromThreshold =
        spoRatificationYesPct !== null && spoThreshold !== null
          ? Number((spoRatificationYesPct - spoThreshold * 100).toFixed(2))
          : null;

      return {
        proposalId: p.proposalId,
        title: p.title,
        governanceActionType: p.governanceActionType,
        submissionEpoch: p.submissionEpoch,
        drepYesPct,
        drepNoPct,
        spoYesPct,
        spoNoPct,
        isContentious: contention.isContentious,
        contentionScore: contention.contentionScore,
        drepRatificationYesPct,
        drepRatificationNoPct,
        spoRatificationYesPct,
        spoRatificationNoPct,
        drepThreshold,
        spoThreshold,
        drepDistanceFromThreshold,
        spoDistanceFromThreshold,
      };
    });

    // Count contentious proposals
    const contentiousCount = allContentions.filter((p) => p.isContentious).length;
    const totalProposals = allContentions.length;
    const contentionRatePct =
      totalProposals > 0
        ? Math.round((contentiousCount / totalProposals) * 10000) / 100
        : 0;

    // Filter to contentious only if requested
    if (contentiousOnly) {
      allContentions = allContentions.filter((p) => p.isContentious);
    }

    const totalItems = allContentions.length;
    const paginatedProposals =
      hasPaginationParams && pageSize !== null
        ? allContentions.slice((page - 1) * pageSize, page * pageSize)
        : allContentions;

    const effectivePageSize = hasPaginationParams && pageSize !== null
      ? pageSize
      : totalItems;

    const response: GetContentionRateResponse = {
      proposals: paginatedProposals,
      contentionRatePct,
      contentiousCount,
      totalProposals,
      pagination: {
        page,
        pageSize: effectivePageSize,
        totalItems,
        totalPages:
          effectivePageSize > 0 ? Math.ceil(totalItems / effectivePageSize) : 0,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching contention rate", error);
    res.status(500).json({
      error: "Failed to fetch contention rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
