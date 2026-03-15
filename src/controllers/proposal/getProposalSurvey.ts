import { Request, Response } from "express";
import { prisma } from "../../services";
import { GetProposalSurveyResponse } from "../../responses";
import { syncProposalDetailsOnRead } from "../../services/syncOnRead";
import { buildProposalLookup } from "./getProposalDetails";
import {
  emptySurveyPayload,
  normalizeSurveyDetails,
  parseGovernanceSurveyLink,
  validateLinkedSurvey,
  type SurveyDetails,
} from "../../libs/surveyMetadata";

export const getProposalSurvey = async (req: Request, res: Response) => {
  try {
    const proposalId = req.params.proposal_id as string;

    if (!proposalId) {
      return res.status(400).json({
        error: "Missing proposal_id",
        message: "A proposal_id path parameter is required",
      });
    }

    syncProposalDetailsOnRead(proposalId);

    const lookup = buildProposalLookup(proposalId);
    if (!lookup) {
      return res.status(400).json({
        error: "Invalid proposal identifier",
        message: "Provide a numeric id or txHash (optionally with :certIndex)",
      });
    }

    const proposal = await prisma.proposal.findFirst({
      where: lookup,
      select: {
        proposalId: true,
        txHash: true,
        certIndex: true,
        governanceActionType: true,
        expirationEpoch: true,
        metadata: true,
        linkedSurveyTxId: true,
        surveyDetails: true,
      },
    });

    if (!proposal) {
      return res.status(404).json({
        error: "Proposal not found",
        message: `No proposal found for id ${proposalId}`,
      });
    }

    const surveyDetails = parseStoredSurveyDetails(proposal.surveyDetails);
    const surveyLink = parseGovernanceSurveyLink(proposal.metadata);
    const payload: GetProposalSurveyResponse = proposal.linkedSurveyTxId
      ? validateLinkedSurvey({
          specVersion: surveyLink.specVersion,
          kind: surveyLink.kind,
          surveyTxId: proposal.linkedSurveyTxId,
          surveyDetails,
          governanceType: proposal.governanceActionType,
          proposalTxHash: proposal.txHash,
          certIndex: proposal.certIndex,
          expirationEpoch: proposal.expirationEpoch,
        })
      : emptySurveyPayload();

    return res.json(payload);
  } catch (error) {
    console.error("Error fetching proposal survey", error);
    return res.status(500).json({
      error: "Failed to fetch proposal survey",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

function parseStoredSurveyDetails(
  surveyDetails: string | null
): SurveyDetails | null {
  if (!surveyDetails) {
    return null;
  }

  try {
    return normalizeSurveyDetails(JSON.parse(surveyDetails)) as SurveyDetails | null;
  } catch {
    return null;
  }
}
