import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetInactiveAdaResponse,
  ProposalInactiveAda,
} from "../../responses/analytics.response";

/**
 * GET /analytics/inactive-ada
 * Returns inactive delegated ADA stats
 *
 * Query params:
 * - view: "proposals" (default: "proposals")
 * - proposalId: Filter by specific proposal (optional)
 * - epochStart: Start epoch (optional)
 * - epochEnd: End epoch (optional)
 * - limit: Max items to return (default: 50 when any query params are provided; unlimited when no query params)
 */
export const getInactiveAda = async (req: Request, res: Response) => {
  try {
    // NOTE: We no longer return epoch-wide special-DRep aggregates from this endpoint.
    // Keep `view` for backward compatibility, but only `proposals` is supported.
    const view = (req.query.view as string) || "proposals";

    const hasAnyQueryParams = Object.keys(req.query ?? {}).length > 0;

    const proposalId = req.query.proposalId as string | undefined;
    const epochStart = req.query.epochStart
      ? parseInt(req.query.epochStart as string)
      : null;
    const epochEnd = req.query.epochEnd
      ? parseInt(req.query.epochEnd as string)
      : null;

    // If no query params are passed (bare /analytics/inactive-ada), return all proposals.
    // Otherwise default to a bounded limit for safety.
    const limit = hasAnyQueryParams
      ? Math.min(500, Math.max(1, parseInt(req.query.limit as string) || 50))
      : undefined;

    const response: GetInactiveAdaResponse = {};

    // Per-proposal inactive data
    if (view === "proposals" || view === "both" || view === "epochs") {
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
        ...(limit !== undefined ? { take: limit } : {}),
        select: {
          proposalId: true,
          title: true,
          submissionEpoch: true,
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
          submissionEpoch: p.submissionEpoch ?? null,
          drepInactiveVotePower: p.drepInactiveVotePower?.toString() ?? null,
          drepTotalVotePower: p.drepTotalVotePower?.toString() ?? null,
          inactivePct,
          drepAlwaysAbstainVotePower: p.drepAlwaysAbstainVotePower?.toString() ?? null,
          drepAlwaysNoConfidencePower: p.drepAlwaysNoConfidencePower?.toString() ?? null,
        };
      });
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
