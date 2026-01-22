import { Request, Response } from "express";
import { prisma } from "../../services";

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
    const rawYear = req.params.year;
    const yearParam = Array.isArray(rawYear) ? rawYear[0] : rawYear;
    const year = parseInt(yearParam ?? "", 10);

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

    res.json(response);
  } catch (error) {
    console.error("Error fetching NCL data by year", error);
    res.status(500).json({
      error: "Failed to fetch NCL data",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
