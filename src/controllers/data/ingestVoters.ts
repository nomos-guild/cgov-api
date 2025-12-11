import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import {
  ingestDrep,
  ingestSpo,
  ingestCc,
} from "../../services/ingestion/voter.service";

const prisma = new PrismaClient();

/**
 * POST /data/drep/:drep_id
 *
 * Ingests a single DRep into the database.
 * Fetches DRep data from Koios API and creates/updates Drep record.
 *
 * @param req - Express request with params: drep_id
 * @param res - Express response
 */
export const postIngestDrep = async (req: Request, res: Response) => {
  try {
    const { drep_id } = req.params;

    if (!drep_id) {
      return res.status(400).json({
        error: "Missing drep_id parameter",
      });
    }

    console.log(`[Ingest DRep] Starting ingestion for: ${drep_id}`);

    const result = await prisma.$transaction(async (tx) => {
      return await ingestDrep(drep_id, tx);
    });

    console.log(`[Ingest DRep] ✓ Successfully ingested ${drep_id}`);

    res.json({
      success: true,
      drep_id,
      created: result.created,
      updated: result.updated,
      voter_id: result.voterId,
    });
  } catch (error) {
    console.error("[Ingest DRep] Error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    res.status(500).json({
      error: "Failed to ingest DRep",
      message: errorMessage,
      drep_id: req.params.drep_id,
    });
  }
};

/**
 * POST /data/spo/:pool_id
 *
 * Ingests a single SPO (Stake Pool Operator) into the database.
 * Fetches pool data from Koios API and creates/updates SPO record.
 *
 * @param req - Express request with params: pool_id
 * @param res - Express response
 */
export const postIngestSpo = async (req: Request, res: Response) => {
  try {
    const { pool_id } = req.params;

    if (!pool_id) {
      return res.status(400).json({
        error: "Missing pool_id parameter",
      });
    }

    console.log(`[Ingest SPO] Starting ingestion for: ${pool_id}`);

    const result = await prisma.$transaction(async (tx) => {
      return await ingestSpo(pool_id, tx);
    });

    console.log(`[Ingest SPO] ✓ Successfully ingested ${pool_id}`);

    res.json({
      success: true,
      pool_id,
      created: result.created,
      updated: result.updated,
      voter_id: result.voterId,
    });
  } catch (error) {
    console.error("[Ingest SPO] Error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    res.status(500).json({
      error: "Failed to ingest SPO",
      message: errorMessage,
      pool_id: req.params.pool_id,
    });
  }
};

/**
 * POST /data/cc/:cc_id
 *
 * Ingests a single Constitutional Committee member into the database.
 * Creates/updates CC record.
 *
 * @param req - Express request with params: cc_id
 * @param res - Express response
 */
export const postIngestCc = async (req: Request, res: Response) => {
  try {
    const { cc_id } = req.params;

    if (!cc_id) {
      return res.status(400).json({
        error: "Missing cc_id parameter",
      });
    }

    console.log(`[Ingest CC] Starting ingestion for: ${cc_id}`);

    const result = await prisma.$transaction(async (tx) => {
      return await ingestCc(cc_id, tx);
    });

    console.log(`[Ingest CC] ✓ Successfully ingested ${cc_id}`);

    res.json({
      success: true,
      cc_id,
      created: result.created,
      updated: result.updated,
      voter_id: result.voterId,
    });
  } catch (error) {
    console.error("[Ingest CC] Error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    res.status(500).json({
      error: "Failed to ingest CC member",
      message: errorMessage,
      cc_id: req.params.cc_id,
    });
  }
};