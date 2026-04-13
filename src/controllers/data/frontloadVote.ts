import { Request, Response } from "express";
import { VoteType, VoterType } from "@prisma/client";
import { frontloadVote } from "../../services/ingestion/vote.service";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

const VALID_VOTE_TYPES = ["YES", "NO", "ABSTAIN"] as const;
const VALID_VOTER_TYPES = ["DREP", "SPO", "CC"] as const;

/**
 * POST /data/vote/frontload
 *
 * Immediately stores vote metadata in the database after tx submission,
 * without waiting for cron job sync from Koios. Uses the same deterministic
 * ID format as the cron path so later upserts merge cleanly.
 */
export const postFrontloadVote = async (req: Request, res: Response) => {
  try {
    const {
      txHash,
      proposalId,
      vote,
      voterType,
      voterId,
      anchorUrl,
      anchorHash,
      rationale,
      surveyResponse,
      surveyResponseSurveyTxId,
      surveyResponseResponderRole,
    } = req.body;

    // ── Validate required fields ────────────────────────────────────────
    if (!txHash || typeof txHash !== "string" || txHash.length !== 64) {
      return res.status(400).json({
        error: "Invalid or missing txHash (must be 64 hex chars)",
      });
    }
    if (!proposalId || typeof proposalId !== "string") {
      return res.status(400).json({ error: "Missing proposalId" });
    }
    if (!vote || !VALID_VOTE_TYPES.includes(vote)) {
      return res.status(400).json({
        error: `Invalid vote: must be one of ${VALID_VOTE_TYPES.join(", ")}`,
      });
    }
    if (!voterType || !VALID_VOTER_TYPES.includes(voterType)) {
      return res.status(400).json({
        error: `Invalid voterType: must be one of ${VALID_VOTER_TYPES.join(", ")}`,
      });
    }
    if (!voterId || typeof voterId !== "string") {
      return res.status(400).json({ error: "Missing voterId" });
    }

    console.log(
      `[Frontload Vote] txHash=${txHash} proposal=${proposalId} voter=${voterType}:${voterId} vote=${vote}`
    );

    const result = await frontloadVote({
      txHash,
      proposalId,
      vote: vote as VoteType,
      voterType: voterType as VoterType,
      voterId,
      anchorUrl,
      anchorHash,
      rationale,
      surveyResponse,
      surveyResponseSurveyTxId,
      surveyResponseResponderRole,
    });

    console.log(`[Frontload Vote] Created/updated vote id=${result.id}`);

    res.json({
      success: true,
      id: result.id,
      txHash,
      proposalId,
    });
  } catch (error) {
    console.error("[Frontload Vote] Error:", formatAxiosLikeError(error));

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    const isFkViolation =
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "P2003";

    const isValidationError =
      error instanceof Error && error.message.includes("not found");

    res.status(isFkViolation || isValidationError ? 422 : 500).json({
      error: "Failed to frontload vote",
      message: errorMessage,
    });
  }
};
