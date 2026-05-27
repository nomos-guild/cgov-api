import { Request, Response } from "express";
import { snapshotService } from "../../services/snapshot.service";
import { sendCachedSnapshot } from "./sendCachedSnapshot";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";
import { parseIntegerQueryOpt } from "../../utils/query-params";

/**
 * GET /snapshot/manifest
 */
export const getSnapshotManifest = async (req: Request, res: Response) => {
  try {
    const epochStartR = parseIntegerQueryOpt(req.query.epochStart, "epochStart", { min: 0 });
    if (!epochStartR.ok) return res.status(epochStartR.status).json(epochStartR);
    const epochEndR = parseIntegerQueryOpt(req.query.epochEnd, "epochEnd", { min: 0 });
    if (!epochEndR.ok) return res.status(epochEndR.status).json(epochEndR);

    const cached = await snapshotService.getManifest({
      epochStart: epochStartR.value,
      epochEnd: epochEndR.value,
    });
    sendCachedSnapshot(req, res, cached);
  } catch (error) {
    console.error("Error fetching snapshot manifest", formatAxiosLikeError(error));
    res.status(500).json({
      error: "Failed to fetch snapshot manifest",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
