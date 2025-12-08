import { Request, Response } from "express";
import { syncAllProposals } from "../../services/ingestion/proposal.service";

/**
 * POST /data/trigger-sync
 *
 * Manually trigger proposal sync (for testing/admin use)
 */
export const postTriggerSync = async (_req: Request, res: Response) => {
  try {
    console.log("[Manual Sync] Triggered via API endpoint");

    const results = await syncAllProposals();

    console.log("[Manual Sync] ✓ Completed successfully");

    res.json({
      success: true,
      message: "Proposal sync completed",
      results,
    });
  } catch (error) {
    console.error("[Manual Sync] Error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    res.status(500).json({
      success: false,
      error: "Failed to sync proposals",
      message: errorMessage,
    });
  }
};