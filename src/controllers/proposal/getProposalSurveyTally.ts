import type { Request, Response } from "express";
import { proposalSurveyTally } from "../../services/cip179/survey.service";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

export const getProposalSurveyTally = async (req: Request, res: Response) => {
  try {
    const proposalId = req.params.proposal_id as string;
    const tally = await proposalSurveyTally(proposalId);
    if (!tally) return res.status(404).json({ error: "Proposal not found" });
    return res.json(tally);
  } catch (error) {
    console.error("Error fetching proposal survey tally", formatAxiosLikeError(error));
    return res.status(500).json({ error: "Failed to fetch proposal survey tally" });
  }
};
