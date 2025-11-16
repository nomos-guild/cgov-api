import { Request, Response } from "express";
import { ingestProposal } from "../../services/ingestion/proposal.service";

/**
 * POST /data/proposal/:proposal_hash
 *
 * Ingests a single proposal and all its associated votes into the database.
 * Fetches data from Koios API and creates/updates records in Proposal,
 * OnchainVote, and voter tables (Drep, SPO, CC).
 *
 * @param req - Express request with params: proposal_hash (tx hash)
 * @param res - Express response
 */
export const postIngestProposal = async (req: Request, res: Response) => {
  try {
    const { proposal_hash } = req.params;

    if (!proposal_hash) {
      return res.status(400).json({
        error: "Missing proposal_hash parameter",
      });
    }

    console.log(`[Ingest Proposal] Starting ingestion for: ${proposal_hash}`);

    const result = await ingestProposal(proposal_hash);

    console.log(
      `[Ingest Proposal] ✓ Successfully ingested ${proposal_hash}:`,
      result.stats
    );

    res.json(result);
  } catch (error) {
    console.error("[Ingest Proposal] Error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Determine appropriate status code
    let statusCode = 500;
    if (errorMessage.includes("not found")) {
      statusCode = 404;
    } else if (errorMessage.includes("invalid")) {
      statusCode = 400;
    }

    res.status(statusCode).json({
      error: "Failed to ingest proposal",
      message: errorMessage,
      proposal_hash: req.params.proposal_hash,
    });
  }
};