import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetNewDelegationRateResponse,
  EpochNewDelegationRate,
} from "../../responses/analytics.response";

/**
 * GET /analytics/new-delegation-rate
 * Returns new wallet delegation rate per epoch
 *
 * A "new delegator" is a stake address that first delegated in that epoch.
 *
 * Query params:
 * - epochStart: Start epoch (optional)
 * - epochEnd: End epoch (optional)
 * - limit: Max number of epochs to return (default: 50)
 */
export const getNewDelegationRate = async (req: Request, res: Response) => {
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

    // Build where clause for delegation changes
    const whereClause: any = {
      toDrepId: { not: "" }, // Has a new DRep (not undelegation)
    };
    if (epochStart !== null) {
      whereClause.delegatedEpoch = { ...whereClause.delegatedEpoch, gte: epochStart };
    }
    if (epochEnd !== null) {
      whereClause.delegatedEpoch = { ...whereClause.delegatedEpoch, lte: epochEnd };
    }

    // Find first delegation per stake address using raw SQL for better performance
    // We need to find the earliest epoch for each stake address where toDrepId != ""
    const firstDelegations = await prisma.$queryRaw<
      Array<{ delegated_epoch_no: number; stake_address: string }>
    >`
      SELECT MIN(delegated_epoch_no) as delegated_epoch_no, stake_address
      FROM stake_delegation_change
      WHERE to_drep_id != ''
      ${epochStart !== null ? prisma.$queryRaw`AND delegated_epoch_no >= ${epochStart}` : prisma.$queryRaw``}
      ${epochEnd !== null ? prisma.$queryRaw`AND delegated_epoch_no <= ${epochEnd}` : prisma.$queryRaw``}
      GROUP BY stake_address
    `;

    // Count new delegators per epoch
    const epochCounts = new Map<number, number>();
    for (const fd of firstDelegations) {
      const epoch = fd.delegated_epoch_no;
      if (epoch !== null && epoch !== -1) {
        epochCounts.set(epoch, (epochCounts.get(epoch) ?? 0) + 1);
      }
    }

    // Build epoch array sorted by epoch
    const sortedEpochs = Array.from(epochCounts.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(-limit);

    // Calculate cumulative total for rate calculation
    let cumulativeTotal = 0;
    const epochs: EpochNewDelegationRate[] = sortedEpochs.map(([epoch, newCount]) => {
      cumulativeTotal += newCount;
      return {
        epoch,
        newDelegators: newCount,
        totalDelegators: cumulativeTotal, // Cumulative new delegators up to this epoch
        newDelegationRatePct:
          cumulativeTotal > 0
            ? Number(((newCount * 10000) / cumulativeTotal) / 100)
            : null,
      };
    });

    const response: GetNewDelegationRateResponse = {
      epochs,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching new delegation rate", error);
    res.status(500).json({
      error: "Failed to fetch new delegation rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
