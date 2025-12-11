import { Request, Response } from "express";
import { ingestVoteByTxHash } from "../../services/ingestion/vote.service";

/**
 * POST /data/vote/:tx_hash
 *
 * Ingests a single vote into the database.
 * Fetches vote data from Koios API and creates/updates OnchainVote record.
 *
 * Note: Currently not fully implemented as Koios API endpoint for
 * fetching a vote by tx_hash needs to be confirmed.
 *
 * @param req - Express request with params: tx_hash
 * @param res - Express response
 */
export const postIngestVote = async (req: Request, res: Response) => {
  try {
    const { tx_hash } = req.params;

    if (!tx_hash) {
      return res.status(400).json({
        error: "Missing tx_hash parameter",
      });
    }

    console.log(`[Ingest Vote] Starting ingestion for: ${tx_hash}`);

    const result = await ingestVoteByTxHash(tx_hash);

    console.log(`[Ingest Vote] ✓ Successfully ingested ${tx_hash}`);

    res.json({
      success: true,
      tx_hash,
      result,
    });
  } catch (error) {
    console.error("[Ingest Vote] Error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    res.status(500).json({
      error: "Failed to ingest vote",
      message: errorMessage,
      tx_hash: req.params.tx_hash,
    });
  }
};