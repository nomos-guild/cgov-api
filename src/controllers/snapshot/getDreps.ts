import { Request, Response } from "express";
import { snapshotService } from "../../services/snapshot.service";
import { sendCachedSnapshot } from "./sendCachedSnapshot";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";
import { parseIntegerQueryOpt } from "../../utils/query-params";

/**
 * GET /snapshot/dreps
 */
export const getSnapshotDreps = async (req: Request, res: Response) => {
  try {
    const topNR = parseIntegerQueryOpt(req.query.topN, "topN", { min: 1, max: 10_000 });
    if (!topNR.ok) return res.status(topNR.status).json(topNR);
    const includeHistory = req.query.includeHistory === "true";
    const cached = await snapshotService.getDreps({ topN: topNR.value, includeHistory });
    sendCachedSnapshot(req, res, cached);
  } catch (error) {
    console.error("Error fetching snapshot dreps", formatAxiosLikeError(error));
    res.status(500).json({
      error: "Failed to fetch snapshot dreps",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
