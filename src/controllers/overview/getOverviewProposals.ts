import { Request, Response } from "express";
import { prisma } from "../../services";
import { GetProposalListReponse } from "../../responses";
import {
  mapProposalToGovernanceAction,
  ProposalWithVotes,
  proposalWithVotesSelect,
} from "../../libs/proposalMapper";
import { syncProposalsOverviewOnRead } from "../../services/syncOnRead";

export const getOverviewProposals = async (_req: Request, res: Response) => {
  try {
    // Trigger background sync for new proposals (non-blocking).
    // The sync runs in the background while we return data from the database.
    // New proposals will be available on the next request after sync completes.
    syncProposalsOverviewOnRead();

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
