import { Request, Response } from "express";
import { prisma } from "../../services";
import { GetDRepHistoryResponse, DRepHistoryDataPoint } from "../../responses";

/**
 * Converts lovelace (BigInt) to ADA string with 6 decimal places
 */
function lovelaceToAda(lovelace: bigint): string {
  const ada = Number(lovelace) / 1_000_000;
  return ada.toFixed(6);
}

/**
 * GET /dreps/:drepId/history
 * Returns per-epoch time series of delegator count and voting power for a DRep.
 * Used by the frontend to render line charts on DRep profile pages.
 */
export const getDRepHistory = async (req: Request, res: Response) => {
  try {
    const drepId = req.params.drepId as string;

    if (!drepId) {
      return res.status(400).json({
        error: "Missing drepId",
        message: "A drepId path parameter is required",
      });
    }

    // Verify DRep exists
    const drep = await prisma.drep.findUnique({
      where: { drepId },
      select: { drepId: true },
    });

    if (!drep) {
      return res.status(404).json({
        error: "DRep not found",
        message: `No DRep found with id ${drepId}`,
      });
    }

    // Fetch all epoch snapshots for this DRep, ordered by epoch
    const snapshots = await prisma.drepEpochSnapshot.findMany({
      where: { drepId },
      orderBy: { epoch: "asc" },
      select: {
        epoch: true,
        delegatorCount: true,
        votingPower: true,
      },
    });

    // Batch-fetch epoch start dates from EpochTotals for all relevant epochs
    const epochNumbers = snapshots.map((s) => s.epoch);
    const epochTotals = epochNumbers.length > 0
      ? await prisma.epochTotals.findMany({
          where: { epoch: { in: epochNumbers } },
          select: { epoch: true, startTime: true },
        })
      : [];

    const epochDateMap = new Map<number, string | null>();
    for (const et of epochTotals) {
      epochDateMap.set(
        et.epoch,
        et.startTime ? et.startTime.toISOString() : null
      );
    }

    const history: DRepHistoryDataPoint[] = snapshots.map((s) => ({
      epoch: s.epoch,
      date: epochDateMap.get(s.epoch) ?? null,
      delegatorCount: s.delegatorCount,
      votingPower: s.votingPower.toString(),
      votingPowerAda: lovelaceToAda(s.votingPower),
    }));

    const response: GetDRepHistoryResponse = {
      drepId,
      history,
    };

    return res.json(response);
  } catch (error) {
    console.error("Error fetching DRep history", error);
    return res.status(500).json({
      error: "Failed to fetch DRep history",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
