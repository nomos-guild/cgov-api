import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetDelegationRateResponse,
  EpochDelegationRate,
} from "../../responses/analytics.response";

/**
 * GET /analytics/delegation-rate
 * Returns delegation rate (% ada) per epoch
 *
 * Query params:
 * - epochStart: Start epoch (optional)
 * - epochEnd: End epoch (optional)
 * - limit: Max number of epochs to return (default: 100)
 */
export const getDelegationRate = async (req: Request, res: Response) => {
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
        delegatedDrepPower: true,
        totalPoolVotePower: true,
        circulation: true,
        startTime: true,
        endTime: true,
      },
    });

    // Calculate delegation rate for each epoch
    const epochs: EpochDelegationRate[] = epochTotals.map((e) => {
      const delegatedDrepPower = e.delegatedDrepPower ?? 0n;
      const totalPoolVotePower = e.totalPoolVotePower ?? 0n;
      const circulation = e.circulation ?? 0n;

      const delegationRatePct =
        circulation > 0n
          ? Number((delegatedDrepPower * 10000n) / circulation) / 100
          : null;

      const spoDelegationRatePct =
        circulation > 0n
          ? Number((totalPoolVotePower * 10000n) / circulation) / 100
          : null;

      return {
        epoch: e.epoch,
        delegatedDrepPower: e.delegatedDrepPower?.toString() ?? null,
        totalPoolVotePower: e.totalPoolVotePower?.toString() ?? null,
        circulation: e.circulation?.toString() ?? null,
        delegationRatePct,
        spoDelegationRatePct,
        startTime: e.startTime?.toISOString() ?? null,
        endTime: e.endTime?.toISOString() ?? null,
      };
    });

    // Reverse to chronological order
    epochs.reverse();

    const response: GetDelegationRateResponse = {
      epochs,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching delegation rate", error);
    res.status(500).json({
      error: "Failed to fetch delegation rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
