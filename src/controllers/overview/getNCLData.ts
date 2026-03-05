import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../services";

/** Epoch boundary: epoch 612 starts on Feb 8 2026 ~21:44 UTC */
const NCL_2026_START_EPOCH = 612;

/** Known NCL limits in lovelace */
const NCL_LIMITS: Record<number, string> = {
  2025: "350000000000000",
  2026: "350000000000000",
};

/**
 * NCL Data Response for a single year
 */
export interface NCLYearData {
  year: number;
  currentValue: string; // In lovelace (string for BigInt serialization)
  targetValue: string; // In lovelace (string for BigInt serialization)
  epoch: number;
  updatedAt: string;
}

/**
 * Sum enacted treasury withdrawal amounts from proposal metadata JSON.
 * Reads metadata.body.onChain.withdrawals[].withdrawalAmount.
 */
async function calcNCLCurrentFromDB(fromEpoch: number, toEpoch?: number): Promise<bigint> {
  const toEpochClause =
    typeof toEpoch === "number"
      ? Prisma.sql`AND p.enacted_epoch < ${toEpoch}`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<Array<{ total: bigint | null }>>`
    SELECT COALESCE(SUM((w->>'withdrawalAmount')::bigint), 0) AS total
    FROM proposal p
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(p.metadata::jsonb->'body'->'onChain'->'withdrawals', '[]'::jsonb)
    ) w
    WHERE p.governance_action_type = 'TREASURY_WITHDRAWALS'
      AND p.status = 'ENACTED'
      AND p.enacted_epoch >= ${fromEpoch}
      ${toEpochClause}
  `;

  return rows[0]?.total ?? BigInt(0);
}

/**
 * Get NCL data for all years
 * GET /overview/ncl
 */
export const getNCLData = async (_req: Request, res: Response) => {
  try {
    const nclRecords = await prisma.nCL.findMany({
      orderBy: { year: "desc" },
    });

    const response: NCLYearData[] = nclRecords.map((record) => ({
      year: record.year,
      currentValue: record.current.toString(),
      targetValue: record.limit.toString(),
      epoch: record.epoch,
      updatedAt: record.updatedAt.toISOString(),
    }));

    const ncl2026 = response.find((record) => record.year === 2026);
    const current2026 = await calcNCLCurrentFromDB(NCL_2026_START_EPOCH);

    if (ncl2026) {
      if (ncl2026.targetValue === "0" && NCL_LIMITS[2026]) {
        ncl2026.targetValue = NCL_LIMITS[2026];
      }
      ncl2026.currentValue = current2026.toString();
    } else {
      response.push({
        year: 2026,
        currentValue: current2026.toString(),
        targetValue: NCL_LIMITS[2026],
        epoch: 0,
        updatedAt: new Date().toISOString(),
      });

      response.sort((a, b) => b.year - a.year);
    }

    res.json(response);
  } catch (error) {
    console.error("Error fetching NCL data", error);
    res.status(500).json({
      error: "Failed to fetch NCL data",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/**
 * Get NCL data for a specific year
 * GET /overview/ncl/:year
 */
export const getNCLDataByYear = async (req: Request, res: Response) => {
  try {
    const year = parseInt(req.params.year as string, 10);

    if (isNaN(year)) {
      res.status(400).json({
        error: "Invalid year parameter",
        message: "Year must be a valid number",
      });
      return;
    }

    const nclRecord = await prisma.nCL.findUnique({
      where: { year },
    });

    if (!nclRecord) {
      res.status(404).json({
        error: "NCL data not found",
        message: `No NCL data found for year ${year}`,
      });
      return;
    }

    const response: NCLYearData = {
      year: nclRecord.year,
      currentValue: nclRecord.current.toString(),
      targetValue: nclRecord.limit.toString(),
      epoch: nclRecord.epoch,
      updatedAt: nclRecord.updatedAt.toISOString(),
    };

    if (year === 2026) {
      if (response.targetValue === "0" && NCL_LIMITS[2026]) {
        response.targetValue = NCL_LIMITS[2026];
      }

      const current2026 = await calcNCLCurrentFromDB(NCL_2026_START_EPOCH);
      response.currentValue = current2026.toString();
    }

    res.json(response);
  } catch (error) {
    console.error("Error fetching NCL data by year", error);
    res.status(500).json({
      error: "Failed to fetch NCL data",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
