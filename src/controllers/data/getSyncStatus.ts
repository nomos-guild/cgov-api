import { Request, Response } from "express";
import { prisma } from "../../services/prisma";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

/**
 * GET /data/sync-status
 *
 * Returns latest sync_status rows for operational visibility.
 * Optional query:
 *   - jobName: filter to a specific job
 */
export const getSyncStatus = async (req: Request, res: Response) => {
  try {
    const jobName = typeof req.query.jobName === "string"
      ? req.query.jobName.trim()
      : "";

    const rows = await prisma.syncStatus.findMany({
      where: jobName ? { jobName } : undefined,
      orderBy: [{ updatedAt: "desc" }],
      take: jobName ? 1 : 200,
      select: {
        jobName: true,
        displayName: true,
        isRunning: true,
        startedAt: true,
        completedAt: true,
        lastResult: true,
        errorMessage: true,
        itemsProcessed: true,
        lockedBy: true,
        expiresAt: true,
        updatedAt: true,
      },
    });

    res.json({
      success: true,
      count: rows.length,
      filters: {
        jobName: jobName || null,
      },
      data: rows,
    });
  } catch (error) {
    console.error("[Sync Status] Failed to fetch sync status:", formatAxiosLikeError(error));
    res.status(500).json({
      success: false,
      error: "Failed to fetch sync status",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
