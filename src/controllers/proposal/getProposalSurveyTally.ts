import { Request, Response } from "express";
import { prisma } from "../../services";
import { GetProposalSurveyTallyResponse } from "../../responses";
import { syncProposalDetailsOnRead } from "../../services/syncOnRead";
import { buildProposalLookup } from "./getProposalDetails";
import {
  buildSurveyTally,
  emptySurveyTally,
  normalizeSurveyDetails,
  parseGovernanceSurveyLink,
  validateLinkedSurvey,
  type SurveyDetails,
  type SurveyTallyVote,
} from "../../libs/surveyMetadata";
import {
  applyProvisionalWeights,
  applyEndEpochWeights,
  collectPendingFinalizationWarnings,
  enrichSurveyTallyVotes,
  getCurrentEpoch,
} from "../../services/proposalSurveyTally.service";

export const getProposalSurveyTally = async (req: Request, res: Response) => {
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
        onchainVotes: {
          select: {
            txHash: true,
            voterType: true,
            votingPower: true,
            responseEpoch: true,
            votedAt: true,
            drepId: true,
            spoId: true,
            ccId: true,
            surveyResponse: true,
            surveyResponseSurveyTxId: true,
            surveyResponseResponderRole: true,
          },
        },
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
    const surveyPayload = proposal.linkedSurveyTxId
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
      : null;

    if (
      !surveyPayload?.linked ||
      !surveyPayload.linkValidation.valid ||
      !surveyPayload.surveyDetailsValidation.valid ||
      !surveyPayload.surveyDetails ||
      !surveyPayload.surveyTxId
    ) {
      const tally = emptySurveyTally();
      tally.surveyTxId = proposal.linkedSurveyTxId;
      tally.errors = [
        ...new Set(
          [
            ...(surveyPayload?.linkValidation.errors ?? []),
            ...(surveyPayload?.surveyDetailsValidation.errors ?? []),
            ...tally.errors,
          ].filter(Boolean)
        ),
      ];
      return res.json(tally);
    }

    const tallyVotes: SurveyTallyVote[] = proposal.onchainVotes
      .filter(
        (vote) =>
          vote.surveyResponse &&
          vote.surveyResponseSurveyTxId === surveyPayload.surveyTxId
      )
      .flatMap((vote) => {
        const voterId = vote.drepId ?? vote.spoId ?? vote.ccId;
        if (!voterId) {
          return [];
        }

        return [
          {
            txHash: vote.txHash,
            voterType: vote.voterType,
            voterId,
            votingPower: vote.votingPower,
            responseEpoch: vote.responseEpoch,
            votedAt: vote.votedAt,
            surveyResponse: vote.surveyResponse,
            surveyResponseSurveyTxId: vote.surveyResponseSurveyTxId,
            surveyResponseResponderRole: vote.surveyResponseResponderRole,
          },
        ];
      });

    const roleWeighting =
      surveyPayload.linkValidation.linkedRoleWeighting ??
      surveyPayload.surveyDetails.roleWeighting;
    const currentEpoch = await getCurrentEpoch();
    const fallbackGovActionIx = parseGovActionIx(proposal.certIndex);
    if (!surveyPayload.linkValidation.linkedActionId && fallbackGovActionIx === null) {
      const tally = emptySurveyTally();
      tally.surveyTxId = proposal.linkedSurveyTxId;
      tally.errors = [
        ...new Set([
          ...tally.errors,
          "Invalid proposal certIndex; expected a non-negative integer.",
        ]),
      ];
      return res.json(tally);
    }
    const linkedActionId = surveyPayload.linkValidation.linkedActionId ?? {
      txId: proposal.txHash,
      govActionIx: fallbackGovActionIx as number,
    };

    const enrichedVotes = await enrichSurveyTallyVotes(tallyVotes, linkedActionId);
    const provisionalVotes = await applyProvisionalWeights(
      enrichedVotes,
      roleWeighting,
      currentEpoch
    );

    const endEpoch = surveyPayload.surveyDetails.endEpoch;

    let tally: GetProposalSurveyTallyResponse;

    if (currentEpoch < endEpoch) {
      tally = buildSurveyTally(
        surveyPayload.surveyTxId,
        surveyPayload.surveyDetails,
        roleWeighting,
        provisionalVotes,
        {
          phase: "provisional",
          asOfEpoch: currentEpoch,
          finalizationEpoch: endEpoch,
          warnings: [],
          enforceLinkedVoteEvidence: false,
        }
      );
    } else {
      const finalizedVotes = await applyEndEpochWeights(
        enrichedVotes,
        roleWeighting,
        endEpoch
      );
      const pendingWarnings = collectPendingFinalizationWarnings(finalizedVotes);

      if (pendingWarnings.length > 0) {
        tally = buildSurveyTally(
          surveyPayload.surveyTxId,
          surveyPayload.surveyDetails,
          roleWeighting,
          provisionalVotes,
          {
            phase: "finalization_pending",
            asOfEpoch: currentEpoch,
            finalizationEpoch: endEpoch,
            warnings: pendingWarnings,
            enforceLinkedVoteEvidence: false,
          }
        );
      } else {
        tally = buildSurveyTally(
          surveyPayload.surveyTxId,
          surveyPayload.surveyDetails,
          roleWeighting,
          finalizedVotes,
          {
            phase: "finalized",
            asOfEpoch: currentEpoch,
            finalizationEpoch: endEpoch,
            warnings: [],
            enforceLinkedVoteEvidence: true,
          }
        );
      }
    }

    return res.json(tally);
  } catch (error) {
    console.error("Error fetching proposal survey tally", error);
    return res.status(500).json({
      error: "Failed to fetch proposal survey tally",
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

function parseGovActionIx(certIndex: string): number | null {
  const parsed = Number(certIndex);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
