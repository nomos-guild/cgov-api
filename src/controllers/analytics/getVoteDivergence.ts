import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetVoteDivergenceResponse,
  ProposalVoteDivergence,
} from "../../responses/analytics.response";
import {
  computeDrepLedgerBuckets,
  computeSpoLedgerBuckets,
} from "../../libs/ledgerVoteMath";

/**
 * GET /analytics/vote-divergence
 * Returns SPO-DRep vote divergence per proposal
 *
 * Divergence score measures how different DRep and SPO voting patterns are
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - status: Filter by proposal status (optional, comma-separated)
 * - epochStart: Filter proposals by submission epoch >= epochStart
 * - epochEnd: Filter proposals by submission epoch <= epochEnd
 */
export const getVoteDivergence = async (req: Request, res: Response) => {
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
      }),
    ]);

    // Calculate divergence for each proposal
    const proposals: ProposalVoteDivergence[] = dbProposals.map((p) => {
      const drepBuckets = computeDrepLedgerBuckets(p);
      const spoBuckets = computeSpoLedgerBuckets(p);

      // Use ledger-consistent distributions for divergence.
      // DRep denominator excludes inactive; SPO denominator follows ledger era.
      const drepYesPct = drepBuckets.yesDistPct;
      const drepNoPct = drepBuckets.noDistPct;
      const drepAbstainPct = drepBuckets.abstainDistPct;

      const spoYesPct = spoBuckets.yesDistPct;
      const spoNoPct = spoBuckets.noDistPct;
      const spoAbstainPct = spoBuckets.abstainDistPct;

      // Calculate divergence score as sum of absolute differences
      // Max divergence = 200 (all vote one way vs all vote opposite)
      // Normalized to 0-100
      let divergenceScore: number | null = null;
      if (
        drepYesPct !== null &&
        drepNoPct !== null &&
        drepAbstainPct !== null &&
        spoYesPct !== null &&
        spoNoPct !== null &&
        spoAbstainPct !== null
      ) {
        const totalDiff =
          Math.abs(drepYesPct - spoYesPct) +
          Math.abs(drepNoPct - spoNoPct) +
          Math.abs(drepAbstainPct - spoAbstainPct);
        // Normalize: max possible diff is 200 (e.g., 100-0 + 100-0 + 0-0 = 200)
        divergenceScore = Math.round((totalDiff / 2) * 100) / 100;
      }

      return {
        proposalId: p.proposalId,
        title: p.title,
        drepYesPct,
        drepNoPct,
        drepAbstainPct,
        spoYesPct,
        spoNoPct,
        spoAbstainPct,
        divergenceScore,
      };
    });

    // Calculate average divergence
    const validDivergences = proposals
      .map((p) => p.divergenceScore)
      .filter((d): d is number => d !== null);
    const averageDivergence =
      validDivergences.length > 0
        ? Math.round(
            (validDivergences.reduce((a, b) => a + b, 0) / validDivergences.length) *
              100
          ) / 100
        : null;

    const response: GetVoteDivergenceResponse = {
      proposals,
      averageDivergence,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching vote divergence", error);
    res.status(500).json({
      error: "Failed to fetch vote divergence",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
