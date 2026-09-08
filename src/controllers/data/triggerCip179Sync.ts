import type { Request, Response } from "express";
import { syncCip179Metadata } from "../../services/cip179/sync.service";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

export const postTriggerCip179Sync = async (_req: Request, res: Response) => {
  try {
    const result = await syncCip179Metadata();
    return res.status(result.skipped ? 202 : 200).json({ success: true, ...result });
  } catch (error) {
    console.error("[CIP-179 Sync] Failed:", formatAxiosLikeError(error));
    return res.status(500).json({ success: false, error: "CIP-179 sync failed" });
  }
};
