import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetActionVolumeResponse,
  EpochActionVolume,
} from "../../responses/analytics.response";

function extractAuthorNames(metadata: string | null): string[] {
  if (!metadata) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") return [];

  const authors = (parsed as any).authors;
  if (!Array.isArray(authors)) return [];

  const names = authors
    .map((a) => (a && typeof a === "object" ? (a as any).name : undefined))
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.replace(/\s+/g, " ").trim())
    .filter((n) => n.length > 0);

  // Avoid double-counting if metadata repeats the same author.
  return Array.from(new Set(names));
}

/**
 * GET /analytics/action-volume
 * Returns governance action volume by epoch and type.
 * Also includes overall totals by type, status, and author (from proposal metadata).
 *
 * Query params:
 * - epochStart: Start epoch (optional)
 * - epochEnd: End epoch (optional)
 * - limit: Max number of epochs to return (default: 50)
 */
export const getActionVolume = async (req: Request, res: Response) => {
  try {
    const epochStart = req.query.epochStart
      ? parseInt(req.query.epochStart as string)
      : null;
    const epochEnd = req.query.epochEnd
      ? parseInt(req.query.epochEnd as string)
      : null;
    const limit = Math.min(
      500,
      Math.max(1, parseInt(req.query.limit as string) || 50)
    );

    // Build where clause
    const whereClause: any = {};
    if (epochStart !== null) {
      whereClause.submissionEpoch = { ...whereClause.submissionEpoch, gte: epochStart };
    }
    if (epochEnd !== null) {
      whereClause.submissionEpoch = { ...whereClause.submissionEpoch, lte: epochEnd };
    }

    // Get proposals grouped by epoch and type
    const proposals = await prisma.proposal.findMany({
      where: whereClause,
      select: {
        submissionEpoch: true,
        governanceActionType: true,
        status: true,
        metadata: true,
      },
    });

    // Build epoch volume map
    const epochMap = new Map<number, Record<string, number>>();
    const totalByType: Record<string, number> = {};
    const totalByStatus: Record<string, number> = {};
    const totalByAuthor: Record<string, number> = {};

    for (const p of proposals) {
      const epoch = p.submissionEpoch ?? -1;
      const type = p.governanceActionType ?? "UNKNOWN";
      const status = p.status;

      // Epoch breakdown
      if (!epochMap.has(epoch)) {
        epochMap.set(epoch, {});
      }
      const epochData = epochMap.get(epoch)!;
      epochData[type] = (epochData[type] ?? 0) + 1;

      // Type totals
      totalByType[type] = (totalByType[type] ?? 0) + 1;

      // Status totals
      totalByStatus[status] = (totalByStatus[status] ?? 0) + 1;

      // Author totals (from metadata JSON)
      const authorNames = extractAuthorNames(p.metadata ?? null);
      for (const name of authorNames) {
        totalByAuthor[name] = (totalByAuthor[name] ?? 0) + 1;
      }
    }

    // Convert to sorted array
    const sortedEpochs = Array.from(epochMap.entries())
      .filter(([epoch]) => epoch >= 0)
      .sort((a, b) => a[0] - b[0])
      .slice(-limit);

    const epochs: EpochActionVolume[] = sortedEpochs.map(([epoch, byType]) => {
      const total = Object.values(byType).reduce((a, b) => a + b, 0);
      return {
        epoch,
        total,
        byType,
      };
    });

    const response: GetActionVolumeResponse = {
      epochs,
      totalProposals: proposals.length,
      byType: totalByType,
      byStatus: totalByStatus,
      byAuthor: totalByAuthor,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching action volume", error);
    res.status(500).json({
      error: "Failed to fetch action volume",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
