import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetDRepLifecycleRateResponse,
  EpochLifecycleEvents,
} from "../../responses/analytics.response";

/**
 * GET /analytics/drep-lifecycle-rate
 * Returns DRep lifecycle event rates (registrations, deregistrations, updates)
 *
 * Query params:
 * - epochStart: Start epoch (optional)
 * - epochEnd: End epoch (optional)
 * - limit: Max number of epochs to return (default: 50). If no query params are provided,
 *   the endpoint returns all available epoch buckets.
 */
export const getDRepLifecycleRate = async (req: Request, res: Response) => {
  try {
    const parseOptionalInt = (value: unknown): number | null => {
      if (value == null) return null;
      const n = parseInt(String(value), 10);
      return Number.isFinite(n) ? n : null;
    };

    const epochStartRaw = req.query.epochStart;
    const epochEndRaw = req.query.epochEnd;
    const limitRaw = req.query.limit;

    const epochStart = parseOptionalInt(epochStartRaw);
    const epochEnd = parseOptionalInt(epochEndRaw);

    const noParamsProvided =
      epochStartRaw === undefined &&
      epochEndRaw === undefined &&
      limitRaw === undefined;

    const limit = noParamsProvided
      ? null
      : Math.min(500, Math.max(1, parseOptionalInt(limitRaw) ?? 50));

    // Build where clause
    const whereClause: any = {};
    if (epochStart !== null) {
      whereClause.epochNo = { ...whereClause.epochNo, gte: epochStart };
    }
    if (epochEnd !== null) {
      whereClause.epochNo = { ...whereClause.epochNo, lte: epochEnd };
    }

    // Get lifecycle events grouped by epoch and action
    const events = await prisma.drepLifecycleEvent.groupBy({
      by: ["epochNo", "action"],
      where: whereClause,
      _count: { id: true },
    });

    // Build epoch map
    const epochMap = new Map<number, { registrations: number; deregistrations: number; updates: number }>();

    for (const e of events) {
      if (!epochMap.has(e.epochNo)) {
        epochMap.set(e.epochNo, { registrations: 0, deregistrations: 0, updates: 0 });
      }
      const epochData = epochMap.get(e.epochNo)!;
      if (e.action === "registration") {
        epochData.registrations = e._count.id;
      } else if (e.action === "deregistration") {
        epochData.deregistrations = e._count.id;
      } else if (e.action === "update") {
        epochData.updates = e._count.id;
      }
    }

    // Convert to sorted array
    const sortedEpochs = Array.from(epochMap.entries())
      .sort((a, b) => a[0] - b[0])
      .slice(limit == null ? 0 : -limit);

    const epochs: EpochLifecycleEvents[] = sortedEpochs.map(([epoch, data]) => ({
      epoch,
      ...data,
    }));

    // Calculate totals
    const totals = {
      registrations: 0,
      deregistrations: 0,
      updates: 0,
    };
    for (const e of epochs) {
      totals.registrations += e.registrations;
      totals.deregistrations += e.deregistrations;
      totals.updates += e.updates;
    }

    const response: GetDRepLifecycleRateResponse = {
      epochs,
      totals,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching DRep lifecycle rate", error);
    res.status(500).json({
      error: "Failed to fetch DRep lifecycle rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
