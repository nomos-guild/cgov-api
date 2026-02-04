import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetVotingTurnoutResponse,
  ProposalTurnout,
} from "../../responses/analytics.response";

/**
 * GET /analytics/voting-turnout
 * Returns voting turnout (% ada) for DRep and SPO per proposal
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - status: Filter by proposal status (optional, comma-separated)
 * - governanceActionType: Filter by action type (optional, comma-separated)
 * - epochStart: Filter proposals by submission epoch >= epochStart
 * - epochEnd: Filter proposals by submission epoch <= epochEnd
 */
export const getVotingTurnout = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(req.query.pageSize as string) || 20)
    );
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

    // Get total count and proposals
    const [totalItems, proposals] = await Promise.all([
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
          status: true,
          drepActiveYesVotePower: true,
          drepActiveNoVotePower: true,
          drepActiveAbstainVotePower: true,
          drepTotalVotePower: true,
          spoActiveYesVotePower: true,
          spoActiveNoVotePower: true,
          spoActiveAbstainVotePower: true,
          spoTotalVotePower: true,
        },
      }),
    ]);

    // Calculate turnout for each proposal
    const proposalTurnouts: ProposalTurnout[] = proposals.map((p) => {
      const drepActive =
        (p.drepActiveYesVotePower ?? 0n) +
        (p.drepActiveNoVotePower ?? 0n) +
        (p.drepActiveAbstainVotePower ?? 0n);
      const drepTotal = p.drepTotalVotePower ?? 0n;
      const drepTurnoutPct =
        drepTotal > 0n
          ? Number((drepActive * 10000n) / drepTotal) / 100
          : null;

      const spoActive =
        (p.spoActiveYesVotePower ?? 0n) +
        (p.spoActiveNoVotePower ?? 0n) +
        (p.spoActiveAbstainVotePower ?? 0n);
      const spoTotal = p.spoTotalVotePower ?? 0n;
      const spoTurnoutPct =
        spoTotal > 0n
          ? Number((spoActive * 10000n) / spoTotal) / 100
          : null;

      return {
        proposalId: p.proposalId,
        title: p.title,
        governanceActionType: p.governanceActionType,
        submissionEpoch: p.submissionEpoch,
        status: p.status,
        drepTurnoutPct,
        spoTurnoutPct,
        drepActiveYesVotePower: p.drepActiveYesVotePower?.toString() ?? null,
        drepActiveNoVotePower: p.drepActiveNoVotePower?.toString() ?? null,
        drepActiveAbstainVotePower: p.drepActiveAbstainVotePower?.toString() ?? null,
        drepTotalVotePower: p.drepTotalVotePower?.toString() ?? null,
        spoActiveYesVotePower: p.spoActiveYesVotePower?.toString() ?? null,
        spoActiveNoVotePower: p.spoActiveNoVotePower?.toString() ?? null,
        spoActiveAbstainVotePower: p.spoActiveAbstainVotePower?.toString() ?? null,
        spoTotalVotePower: p.spoTotalVotePower?.toString() ?? null,
      };
    });

    // Calculate aggregate turnout (weighted average by total vote power)
    let totalDrepActive = 0n;
    let totalDrepPower = 0n;
    let totalSpoActive = 0n;
    let totalSpoPower = 0n;

    for (const p of proposals) {
      if (p.drepTotalVotePower) {
        totalDrepActive +=
          (p.drepActiveYesVotePower ?? 0n) +
          (p.drepActiveNoVotePower ?? 0n) +
          (p.drepActiveAbstainVotePower ?? 0n);
        totalDrepPower += p.drepTotalVotePower;
      }
      if (p.spoTotalVotePower) {
        totalSpoActive +=
          (p.spoActiveYesVotePower ?? 0n) +
          (p.spoActiveNoVotePower ?? 0n) +
          (p.spoActiveAbstainVotePower ?? 0n);
        totalSpoPower += p.spoTotalVotePower;
      }
    }

    const aggregateDrepTurnoutPct =
      totalDrepPower > 0n
        ? Number((totalDrepActive * 10000n) / totalDrepPower) / 100
        : null;
    const aggregateSpoTurnoutPct =
      totalSpoPower > 0n
        ? Number((totalSpoActive * 10000n) / totalSpoPower) / 100
        : null;

    const response: GetVotingTurnoutResponse = {
      proposals: proposalTurnouts,
      aggregateDrepTurnoutPct,
      aggregateSpoTurnoutPct,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching voting turnout", error);
    res.status(500).json({
      error: "Failed to fetch voting turnout",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
