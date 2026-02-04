import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetInactiveAdaResponse,
  ProposalInactiveAda,
  EpochInactiveAda,
} from "../../responses/analytics.response";

/**
 * GET /analytics/inactive-ada
 * Returns inactive delegated ADA stats
 *
 * Query params:
 * - view: "proposals" | "epochs" | "both" (default: "both")
 * - proposalId: Filter by specific proposal (optional)
 * - epochStart: Start epoch (optional)
 * - epochEnd: End epoch (optional)
 * - limit: Max items to return (default: 50)
 */
export const getInactiveAda = async (req: Request, res: Response) => {
  try {
    const view = (req.query.view as string) || "both";
    const proposalId = req.query.proposalId as string | undefined;
    const epochStart = req.query.epochStart
      ? parseInt(req.query.epochStart as string)
      : null;
    const epochEnd = req.query.epochEnd
      ? parseInt(req.query.epochEnd as string)
      : null;
    const limit = Math.min(
      500,
      Math.max(1, parseInt(req.query.limit as string) || 50)
    );

    const response: GetInactiveAdaResponse = {};

    // Per-proposal inactive data
    if (view === "proposals" || view === "both") {
      const proposalWhere: any = {};
      if (proposalId) {
        proposalWhere.proposalId = proposalId;
      }
      if (epochStart !== null) {
        proposalWhere.submissionEpoch = { ...proposalWhere.submissionEpoch, gte: epochStart };
      }
      if (epochEnd !== null) {
        proposalWhere.submissionEpoch = { ...proposalWhere.submissionEpoch, lte: epochEnd };
      }

      const proposals = await prisma.proposal.findMany({
        where: proposalWhere,
        orderBy: { submissionEpoch: "desc" },
        take: limit,
        select: {
          proposalId: true,
          title: true,
          drepInactiveVotePower: true,
          drepTotalVotePower: true,
          drepAlwaysAbstainVotePower: true,
          drepAlwaysNoConfidencePower: true,
        },
      });

      response.proposals = proposals.map((p): ProposalInactiveAda => {
        const inactive = p.drepInactiveVotePower ?? 0n;
        const total = p.drepTotalVotePower ?? 0n;
        const inactivePct =
          total > 0n ? Number((inactive * 10000n) / total) / 100 : null;

        return {
          proposalId: p.proposalId,
          title: p.title,
          drepInactiveVotePower: p.drepInactiveVotePower?.toString() ?? null,
          drepTotalVotePower: p.drepTotalVotePower?.toString() ?? null,
          inactivePct,
          drepAlwaysAbstainVotePower: p.drepAlwaysAbstainVotePower?.toString() ?? null,
          drepAlwaysNoConfidencePower: p.drepAlwaysNoConfidencePower?.toString() ?? null,
        };
      });
    }

    // Per-epoch special DRep data
    if (view === "epochs" || view === "both") {
      const epochWhere: any = {};
      if (epochStart !== null) {
        epochWhere.epoch = { ...epochWhere.epoch, gte: epochStart };
      }
      if (epochEnd !== null) {
        epochWhere.epoch = { ...epochWhere.epoch, lte: epochEnd };
      }

      const epochTotals = await prisma.epochTotals.findMany({
        where: epochWhere,
        orderBy: { epoch: "desc" },
        take: limit,
        select: {
          epoch: true,
          drepAlwaysAbstainVotingPower: true,
          drepAlwaysNoConfidenceVotingPower: true,
          drepAlwaysAbstainDelegatorCount: true,
          drepAlwaysNoConfidenceDelegatorCount: true,
        },
      });

      response.epochs = epochTotals.map((e): EpochInactiveAda => ({
        epoch: e.epoch,
        drepAlwaysAbstainVotingPower: e.drepAlwaysAbstainVotingPower?.toString() ?? null,
        drepAlwaysNoConfidenceVotingPower: e.drepAlwaysNoConfidenceVotingPower?.toString() ?? null,
        drepAlwaysAbstainDelegatorCount: e.drepAlwaysAbstainDelegatorCount,
        drepAlwaysNoConfidenceDelegatorCount: e.drepAlwaysNoConfidenceDelegatorCount,
      }));

      // Reverse to chronological order
      response.epochs.reverse();
    }

    res.json(response);
  } catch (error) {
    console.error("Error fetching inactive ada", error);
    res.status(500).json({
      error: "Failed to fetch inactive ada",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
