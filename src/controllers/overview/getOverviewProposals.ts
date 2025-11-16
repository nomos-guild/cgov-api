import { Request, Response } from "express";
import { prisma } from "../../services";
import { GetProposalListReponse } from "../../responses";
import {
  mapProposalToGovernanceAction,
  ProposalWithVotes,
  proposalWithVotesSelect,
} from "../../libs/proposalMapper";

export const getOverviewProposals = async (_req: Request, res: Response) => {
  try {
    const proposals = await prisma.proposal.findMany({
      select: proposalWithVotesSelect,
      orderBy: [
        { submissionEpoch: "desc" },
        { createdAt: "desc" },
      ],
    });

    const response: GetProposalListReponse = proposals.map(
      (proposal) =>
        mapProposalToGovernanceAction(proposal as ProposalWithVotes)
    );

    res.json(response);
  } catch (error) {
    console.error("Error fetching overview proposals", error);
    res.status(500).json({
      error: "Failed to fetch proposals overview",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
