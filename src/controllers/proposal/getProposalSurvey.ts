import type { Request, Response } from "express";
import { proposalSurvey } from "../../services/cip179/survey.service";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

export const getProposalSurvey = async (req: Request, res: Response) => {
  try {
    const proposalId = req.params.proposal_id as string;
    const survey = await proposalSurvey(proposalId);
    if (!survey) return res.status(404).json({ error: "Proposal not found" });
    return res.json(survey);
  } catch (error) {
    console.error("Error fetching proposal survey", formatAxiosLikeError(error));
    return res.status(500).json({ error: "Failed to fetch proposal survey" });
  }
};
