import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetSpoSilentStakeResponse,
  ProposalSilentStake,
} from "../../responses/analytics.response";

/**
 * GET /analytics/spo-silent-stake
 * Returns SPO silent stake rate (stake that did not vote)
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - status: Filter by proposal status (optional, comma-separated)
 * - epochStart: Filter proposals by submission epoch >= epochStart
 * - epochEnd: Filter proposals by submission epoch <= epochEnd
 */
export const getSpoSilentStake = async (req: Request, res: Response) => {
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
          spoNoVotePower: true,
          spoTotalVotePower: true,
          spoActiveYesVotePower: true,
          spoActiveNoVotePower: true,
          spoActiveAbstainVotePower: true,
        },
      }),
    ]);

    // Calculate silent stake for each proposal
    const proposals: ProposalSilentStake[] = dbProposals.map((p) => {
      const spoTotal = p.spoTotalVotePower ?? 0n;
      let silentPower: bigint;

      // Prefer spoNoVotePower if available, otherwise calculate from active votes
      if (p.spoNoVotePower !== null) {
        silentPower = p.spoNoVotePower;
      } else {
        const activeVoted =
          (p.spoActiveYesVotePower ?? 0n) +
          (p.spoActiveNoVotePower ?? 0n) +
          (p.spoActiveAbstainVotePower ?? 0n);
        silentPower = spoTotal > activeVoted ? spoTotal - activeVoted : 0n;
      }

      const silentPct =
        spoTotal > 0n
          ? Number((silentPower * 10000n) / spoTotal) / 100
          : null;

      return {
        proposalId: p.proposalId,
        title: p.title,
        spoNoVotePower: silentPower.toString(),
        spoTotalVotePower: spoTotal.toString(),
        silentPct,
      };
    });

    // Calculate aggregate silent stake
    let totalSilent = 0n;
    let totalPower = 0n;
    for (const p of dbProposals) {
      const spoTotal = p.spoTotalVotePower ?? 0n;
      if (spoTotal > 0n) {
        let silentPower: bigint;
        if (p.spoNoVotePower !== null) {
          silentPower = p.spoNoVotePower;
        } else {
          const activeVoted =
            (p.spoActiveYesVotePower ?? 0n) +
            (p.spoActiveNoVotePower ?? 0n) +
            (p.spoActiveAbstainVotePower ?? 0n);
          silentPower = spoTotal > activeVoted ? spoTotal - activeVoted : 0n;
        }
        totalSilent += silentPower;
        totalPower += spoTotal;
      }
    }

    const aggregateSilentPct =
      totalPower > 0n
        ? Number((totalSilent * 10000n) / totalPower) / 100
        : null;

    const response: GetSpoSilentStakeResponse = {
      proposals,
      aggregateSilentPct,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching SPO silent stake", error);
    res.status(500).json({
      error: "Failed to fetch SPO silent stake",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
