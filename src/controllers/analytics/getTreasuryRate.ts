import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetTreasuryRateResponse,
  EpochTreasuryRate,
} from "../../responses/analytics.response";

/**
 * GET /analytics/treasury-rate
 * Returns treasury balance rate per epoch
 *
 * Query params:
 * - epochStart: Start epoch (optional)
 * - epochEnd: End epoch (optional)
 * - limit: Max number of epochs to return (default: 100)
 */
export const getTreasuryRate = async (req: Request, res: Response) => {
  try {
    const epochStart = req.query.epochStart
      ? parseInt(req.query.epochStart as string)
      : null;
    const epochEnd = req.query.epochEnd
      ? parseInt(req.query.epochEnd as string)
      : null;
    const limit = Math.min(
      1000,
      Math.max(1, parseInt(req.query.limit as string) || 100)
    );

    // Build where clause
    const whereClause: any = {};
    if (epochStart !== null) {
      whereClause.epoch = { ...whereClause.epoch, gte: epochStart };
    }
    if (epochEnd !== null) {
      whereClause.epoch = { ...whereClause.epoch, lte: epochEnd };
    }

    // Get epoch totals
    const epochTotals = await prisma.epochTotals.findMany({
      where: whereClause,
      orderBy: { epoch: "desc" },
      take: limit,
      select: {
        epoch: true,
        treasury: true,
        circulation: true,
        startTime: true,
        endTime: true,
      },
    });

    // Calculate treasury rate for each epoch
    const epochs: EpochTreasuryRate[] = epochTotals.map((e) => {
      const treasury = e.treasury ?? 0n;
      const circulation = e.circulation ?? 0n;

      const treasuryRatePct =
        circulation > 0n
          ? Number((treasury * 10000n) / circulation) / 100
          : null;

      return {
        epoch: e.epoch,
        treasury: e.treasury?.toString() ?? null,
        circulation: e.circulation?.toString() ?? null,
        treasuryRatePct,
        startTime: e.startTime?.toISOString() ?? null,
        endTime: e.endTime?.toISOString() ?? null,
      };
    });

    // Reverse to chronological order
    epochs.reverse();

    const response: GetTreasuryRateResponse = {
      epochs,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching treasury rate", error);
    res.status(500).json({
      error: "Failed to fetch treasury rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
