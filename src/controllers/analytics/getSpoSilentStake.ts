import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetSpoSilentStakeResponse,
  ProposalSilentStake,
} from "../../responses/analytics.response";
import { computeSpoLedgerBuckets } from "../../libs/ledgerVoteMath";

/**
 * GET /analytics/spo-silent-stake
 * Returns SPO silent stake rate (stake that did not vote)
 *
 * Query params:
 * - page: Page number (optional). If omitted (and pageSize omitted), returns all proposals.
 * - pageSize: Items per page (optional, max: 100). If omitted (and page omitted), returns all proposals.
 * - status: Filter by proposal status (optional, comma-separated)
 * - epochStart: Filter proposals by submission epoch >= epochStart
 * - epochEnd: Filter proposals by submission epoch <= epochEnd
 */
export const getSpoSilentStake = async (req: Request, res: Response) => {
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
        governanceActionType: true,
        submissionEpoch: true,
        spoNoVotePower: true,
        spoTotalVotePower: true,
        spoActiveYesVotePower: true,
        spoActiveNoVotePower: true,
        spoActiveAbstainVotePower: true,
        spoAlwaysAbstainVotePower: true,
        spoAlwaysNoConfidencePower: true,
      },
    });

    const totalItems = paginationRequested
      ? await prisma.proposal.count({ where: whereClause })
      : dbProposals.length;

    // Calculate silent stake for each proposal
    const proposals: ProposalSilentStake[] = dbProposals.map((p) => {
      const spoTotal = p.spoTotalVotePower ?? 0n;
      const buckets = computeSpoLedgerBuckets(p);

      const alwaysAbstain = p.spoAlwaysAbstainVotePower ?? 0n;
      const alwaysNoConfidence = p.spoAlwaysNoConfidencePower ?? 0n;
      const defaultStancePower = alwaysAbstain + alwaysNoConfidence;
      const pureNotVotedPower = buckets.notVoted;
      const totalSilentPower = pureNotVotedPower + defaultStancePower;

      const silentPct = spoTotal > 0n ? Number((totalSilentPower * 10000n) / spoTotal) / 100 : null;
      const pureNotVotedPct = spoTotal > 0n ? Number((pureNotVotedPower * 10000n) / spoTotal) / 100 : null;
      const defaultStancePct = spoTotal > 0n ? Number((defaultStancePower * 10000n) / spoTotal) / 100 : null;

      return {
        proposalId: p.proposalId,
        title: p.title,
        governanceActionType: p.governanceActionType,
        submissionEpoch: p.submissionEpoch,
        // Backward compat: "silent stake" (non-explicit voting) = pureNotVoted + default stance
        spoNoVotePower: totalSilentPower.toString(),
        spoTotalVotePower: spoTotal.toString(),
        silentPct,
        pureNotVotedPower: pureNotVotedPower.toString(),
        defaultStancePower: defaultStancePower.toString(),
        alwaysAbstainPower: alwaysAbstain.toString(),
        alwaysNoConfidencePower: alwaysNoConfidence.toString(),
        pureNotVotedPct,
        defaultStancePct,
      };
    });

    // Calculate aggregate silent stake
    let totalSilent = 0n;
    let totalPower = 0n;
    for (const p of dbProposals) {
      const spoTotal = p.spoTotalVotePower ?? 0n;
      if (spoTotal > 0n) {
        const buckets = computeSpoLedgerBuckets(p);
        const alwaysAbstain = p.spoAlwaysAbstainVotePower ?? 0n;
        const alwaysNoConfidence = p.spoAlwaysNoConfidencePower ?? 0n;
        const defaultStancePower = alwaysAbstain + alwaysNoConfidence;
        const pureNotVotedPower = buckets.notVoted;
        const totalSilentPower = pureNotVotedPower + defaultStancePower;

        totalSilent += totalSilentPower;
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
    console.error("Error fetching SPO silent stake", error);
    res.status(500).json({
      error: "Failed to fetch SPO silent stake",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
