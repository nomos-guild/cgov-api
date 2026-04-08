import { Request, Response } from "express";
import { getIntegrityMetricsSnapshot } from "../../services/ingestion/integrityMetrics";
import { getKoiosLimiterState } from "../../services/koios";

export const getIngestionHealth = async (_req: Request, res: Response) => {
  try {
    res.json({
      integrity: getIntegrityMetricsSnapshot(),
      koios: getKoiosLimiterState(),
    });
  } catch (error) {
    console.error("Error fetching ingestion health metrics", error);
    res.status(500).json({
      error: "Failed to fetch ingestion health metrics",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
