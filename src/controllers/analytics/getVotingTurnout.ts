import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetVotingTurnoutResponse,
  ProposalTurnout,
} from "../../responses/analytics.response";
import { toNumber } from "../../libs/proposalMapper";

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
          // DRep fields
          drepActiveYesVotePower: true,
          drepActiveNoVotePower: true,
          drepActiveAbstainVotePower: true,
          drepTotalVotePower: true,
          drepAlwaysAbstainVotePower: true,
          drepAlwaysNoConfidencePower: true,
          drepInactiveVotePower: true,
          // SPO fields
          spoActiveYesVotePower: true,
          spoActiveNoVotePower: true,
          spoActiveAbstainVotePower: true,
          spoTotalVotePower: true,
          spoAlwaysAbstainVotePower: true,
          spoAlwaysNoConfidencePower: true,
          spoNoVotePower: true,
        },
      }),
    ]);

    // Calculate turnout for each proposal
    const proposalTurnouts: ProposalTurnout[] = proposals.map((p) => {
      // DRep calculations
      const drepActiveVotes = toNumber(p.drepActiveYesVotePower) +
        toNumber(p.drepActiveNoVotePower) +
        toNumber(p.drepActiveAbstainVotePower);
      const drepAlwaysAbstain = toNumber(p.drepAlwaysAbstainVotePower);
      const drepAlwaysNoConfidence = toNumber(p.drepAlwaysNoConfidencePower);
      const drepInactive = toNumber(p.drepInactiveVotePower);
      const drepTotal = toNumber(p.drepTotalVotePower);

      // Default stance = alwaysAbstain + alwaysNoConfidence
      const drepDefaultStance = drepAlwaysAbstain + drepAlwaysNoConfidence;

      // Not voted = total - active - defaultStance - inactive
      const drepNotVoted = drepTotal - drepActiveVotes - drepDefaultStance - drepInactive;

      // Turnout (active only) - backward compatible
      const drepTurnoutPct = drepTotal > 0
        ? Number(((drepActiveVotes / drepTotal) * 100).toFixed(2))
        : null;

      // Participating = active + default stance (not inactive, not notVoted)
      const drepParticipating = drepActiveVotes + drepDefaultStance;
      const drepParticipatingPct = drepTotal > 0
        ? Number(((drepParticipating / drepTotal) * 100).toFixed(2))
        : null;

      // SPO calculations
      const spoActiveVotes = toNumber(p.spoActiveYesVotePower) +
        toNumber(p.spoActiveNoVotePower) +
        toNumber(p.spoActiveAbstainVotePower);
      const spoAlwaysAbstain = toNumber(p.spoAlwaysAbstainVotePower);
      const spoAlwaysNoConfidence = toNumber(p.spoAlwaysNoConfidencePower);
      const spoTotal = toNumber(p.spoTotalVotePower);
      const spoKoiosNoVote = toNumber(p.spoNoVotePower);

      // Default stance = alwaysAbstain + alwaysNoConfidence
      const spoDefaultStance = spoAlwaysAbstain + spoAlwaysNoConfidence;

      // Derive pure notVoted from Koios: pool_no_vote_power - explicit_no - alwaysNoConfidence
      const spoNotVoted = spoKoiosNoVote - toNumber(p.spoActiveNoVotePower) - spoAlwaysNoConfidence;

      // Turnout (active only) - backward compatible
      const spoTurnoutPct = spoTotal > 0
        ? Number(((spoActiveVotes / spoTotal) * 100).toFixed(2))
        : null;

      // Participating = active + default stance
      const spoParticipating = spoActiveVotes + spoDefaultStance;
      const spoParticipatingPct = spoTotal > 0
        ? Number(((spoParticipating / spoTotal) * 100).toFixed(2))
        : null;

      return {
        proposalId: p.proposalId,
        title: p.title,
        governanceActionType: p.governanceActionType,
        submissionEpoch: p.submissionEpoch,
        status: p.status,
        // Backward compatible fields
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
        // NEW: DRep breakdown fields
        drepAlwaysAbstainVotePower: p.drepAlwaysAbstainVotePower?.toString() ?? null,
        drepAlwaysNoConfidencePower: p.drepAlwaysNoConfidencePower?.toString() ?? null,
        drepInactiveVotePower: p.drepInactiveVotePower?.toString() ?? null,
        drepNotVotedPower: Math.max(0, drepNotVoted).toString(),
        drepParticipatingPct,
        // NEW: SPO breakdown fields
        spoAlwaysAbstainVotePower: p.spoAlwaysAbstainVotePower?.toString() ?? null,
        spoAlwaysNoConfidencePower: p.spoAlwaysNoConfidencePower?.toString() ?? null,
        spoNotVotedPower: Math.max(0, spoNotVoted).toString(),
        spoParticipatingPct,
      };
    });

    // Calculate aggregate turnout (weighted average by total vote power)
    let totalDrepActive = 0;
    let totalDrepParticipating = 0;
    let totalDrepPower = 0;
    let totalSpoActive = 0;
    let totalSpoParticipating = 0;
    let totalSpoPower = 0;

    for (const p of proposals) {
      if (p.drepTotalVotePower) {
        const drepActive =
          toNumber(p.drepActiveYesVotePower) +
          toNumber(p.drepActiveNoVotePower) +
          toNumber(p.drepActiveAbstainVotePower);
        const drepDefaultStance =
          toNumber(p.drepAlwaysAbstainVotePower) +
          toNumber(p.drepAlwaysNoConfidencePower);

        totalDrepActive += drepActive;
        totalDrepParticipating += drepActive + drepDefaultStance;
        totalDrepPower += toNumber(p.drepTotalVotePower);
      }
      if (p.spoTotalVotePower) {
        const spoActive =
          toNumber(p.spoActiveYesVotePower) +
          toNumber(p.spoActiveNoVotePower) +
          toNumber(p.spoActiveAbstainVotePower);
        const spoDefaultStance =
          toNumber(p.spoAlwaysAbstainVotePower) +
          toNumber(p.spoAlwaysNoConfidencePower);

        totalSpoActive += spoActive;
        totalSpoParticipating += spoActive + spoDefaultStance;
        totalSpoPower += toNumber(p.spoTotalVotePower);
      }
    }

    const aggregateDrepTurnoutPct =
      totalDrepPower > 0
        ? Number(((totalDrepActive / totalDrepPower) * 100).toFixed(2))
        : null;
    const aggregateDrepParticipatingPct =
      totalDrepPower > 0
        ? Number(((totalDrepParticipating / totalDrepPower) * 100).toFixed(2))
        : null;
    const aggregateSpoTurnoutPct =
      totalSpoPower > 0
        ? Number(((totalSpoActive / totalSpoPower) * 100).toFixed(2))
        : null;
    const aggregateSpoParticipatingPct =
      totalSpoPower > 0
        ? Number(((totalSpoParticipating / totalSpoPower) * 100).toFixed(2))
        : null;

    const response: GetVotingTurnoutResponse = {
      proposals: proposalTurnouts,
      aggregateDrepTurnoutPct,
      aggregateDrepParticipatingPct,
      aggregateSpoTurnoutPct,
      aggregateSpoParticipatingPct,
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
