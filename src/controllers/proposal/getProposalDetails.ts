import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../services";
import {
  mapProposalToGovernanceActionDetail,
  ProposalWithVotes,
  proposalWithVotesSelect,
} from "../../libs/proposalMapper";
import { GetProposalInfoResponse } from "../../responses";

const buildProposalLookup = (
  identifier: string
): Prisma.ProposalWhereInput | null => {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return null;
  }

  const filters: Prisma.ProposalWhereInput[] = [];
  const numericId = Number(trimmed);

  if (!Number.isNaN(numericId)) {
    filters.push({ id: numericId });
  }

  if (trimmed.includes(":")) {
    const [hashCandidate, certCandidate] = trimmed.split(":");
    if (hashCandidate && certCandidate) {
      filters.push({ txHash: hashCandidate, certIndex: certCandidate });
    } else if (hashCandidate) {
      filters.push({ txHash: hashCandidate });
    }
  } else {
    filters.push({ txHash: trimmed });
  }

  if (!filters.length) {
    return null;
  }

  return filters.length === 1 ? filters[0] : { OR: filters };
};

export const getProposalDetails = async (req: Request, res: Response) => {
  try {
    const proposalId = req.params.proposal_id;

    if (!proposalId) {
      return res.status(400).json({
        error: "Missing proposal_id",
        message: "A proposal_id path parameter is required",
      });
    }

    const lookup = buildProposalLookup(proposalId);

    if (!lookup) {
      return res.status(400).json({
        error: "Invalid proposal identifier",
        message: "Provide a numeric id or txHash (optionally with :certIndex)",
      });
    }

    const proposal = await prisma.proposal.findFirst({
      where: lookup,
      select: proposalWithVotesSelect,
    });

    if (!proposal) {
      return res.status(404).json({
        error: "Proposal not found",
        message: `No proposal found for id ${proposalId}`,
      });
    }

    const response: GetProposalInfoResponse =
      mapProposalToGovernanceActionDetail(proposal as ProposalWithVotes);

    return res.json(response);
  } catch (error) {
    console.error("Error fetching proposal details", error);
    return res.status(500).json({
      error: "Failed to fetch proposal details",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
