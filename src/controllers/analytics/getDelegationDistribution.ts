import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetDelegationDistributionResponse,
  DelegationBand,
} from "../../responses/analytics.response";

// 1 ADA = 1,000,000 lovelace
const ADA = 1_000_000n;

// Default delegation bands in ADA
const DEFAULT_BANDS = [
  { label: "0-1k ADA", min: 0n, max: 1_000n * ADA },
  { label: "1k-10k ADA", min: 1_000n * ADA, max: 10_000n * ADA },
  { label: "10k-100k ADA", min: 10_000n * ADA, max: 100_000n * ADA },
  { label: "100k-1M ADA", min: 100_000n * ADA, max: 1_000_000n * ADA },
  { label: "1M+ ADA", min: 1_000_000n * ADA, max: BigInt(Number.MAX_SAFE_INTEGER) * ADA },
];

/**
 * Converts lovelace to ADA string
 */
function lovelaceToAda(lovelace: bigint): string {
  const ada = Number(lovelace) / 1_000_000;
  return ada.toFixed(6);
}

/**
 * GET /analytics/delegation-distribution
 * Returns delegation distribution by wallet size bands
 *
 * Query params:
 * - drepId: Filter by specific DRep (optional)
 */
export const getDelegationDistribution = async (req: Request, res: Response) => {
  try {
    const drepId = req.query.drepId as string | undefined;

    // Build where clause
    const whereClause: any = {
      amount: { not: null },
      drepId: { not: null },
    };
    if (drepId) {
      whereClause.drepId = drepId;
    }

    // Get all delegations
    const delegations = await prisma.stakeDelegationState.findMany({
      where: whereClause,
      select: {
        stakeAddress: true,
        amount: true,
      },
    });

    // Initialize band stats
    const bandStats = DEFAULT_BANDS.map((band) => ({
      band: band.label,
      minLovelace: band.min,
      maxLovelace: band.max,
      stakeAddressCount: 0,
      totalAmount: 0n,
    }));

    let totalStakeAddresses = 0;
    let totalAmount = 0n;

    // Categorize each delegation into bands
    for (const d of delegations) {
      const amount = d.amount ?? 0n;
      totalStakeAddresses++;
      totalAmount += amount;

      for (const bandStat of bandStats) {
        if (amount >= bandStat.minLovelace && amount < bandStat.maxLovelace) {
          bandStat.stakeAddressCount++;
          bandStat.totalAmount += amount;
          break;
        }
      }
    }

    // Calculate percentages and format response
    const bands: DelegationBand[] = bandStats.map((bs) => ({
      band: bs.band,
      minLovelace: bs.minLovelace.toString(),
      maxLovelace: bs.maxLovelace.toString(),
      stakeAddressCount: bs.stakeAddressCount,
      totalAmountLovelace: bs.totalAmount.toString(),
      totalAmountAda: lovelaceToAda(bs.totalAmount),
      stakeAddressSharePct:
        totalStakeAddresses > 0
          ? Number(((bs.stakeAddressCount * 10000) / totalStakeAddresses) / 100)
          : 0,
      amountSharePct:
        totalAmount > 0n
          ? Number((bs.totalAmount * 10000n) / totalAmount) / 100
          : 0,
    }));

    const response: GetDelegationDistributionResponse = {
      bands,
      totalStakeAddresses,
      totalAmountLovelace: totalAmount.toString(),
      totalAmountAda: lovelaceToAda(totalAmount),
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching delegation distribution", error);
    res.status(500).json({
      error: "Failed to fetch delegation distribution",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
