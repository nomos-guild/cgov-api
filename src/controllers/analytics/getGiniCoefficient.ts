import { Request, Response } from "express";
import { prisma } from "../../services";
import { GetGiniCoefficientResponse } from "../../responses/analytics.response";

/**
 * Calculates the Gini coefficient for a distribution of values.
 * Gini = 1 - 2 * (area under Lorenz curve)
 * = (2 * sum(i * x_i) - (n+1) * sum(x_i)) / (n * sum(x_i))
 *
 * @param values Array of positive values (voting power)
 * @returns Gini coefficient (0-1)
 */
function calculateGini(values: bigint[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return 0;

  // Sort values ascending
  const sorted = [...values].sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });

  const n = sorted.length;

  // Calculate sum and weighted sum
  // Using BigInt for precision with large numbers
  let sum = 0n;
  let weightedSum = 0n;

  for (let i = 0; i < n; i++) {
    sum += sorted[i];
    weightedSum += BigInt(i + 1) * sorted[i];
  }

  if (sum === 0n) return 0;

  // Gini = (2 * weightedSum - (n + 1) * sum) / (n * sum)
  // Use scaled arithmetic to avoid precision loss
  const numerator = 2n * weightedSum - BigInt(n + 1) * sum;
  const denominator = BigInt(n) * sum;

  // Convert to number with precision
  const gini = Number(numerator * 10000n / denominator) / 10000;

  return Math.max(0, Math.min(1, gini));
}

/**
 * Calculates percentile value from sorted array
 */
function percentile(sortedValues: bigint[], p: number): bigint {
  if (sortedValues.length === 0) return 0n;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

/**
 * GET /analytics/gini
 * Returns the Gini coefficient for DRep voting power distribution
 *
 * Query params:
 * - activeOnly: Filter to active DReps only (default: true)
 */
export const getGiniCoefficient = async (req: Request, res: Response) => {
  try {
    const activeOnly = req.query.activeOnly !== "false";

    // Build where clause
    const whereClause: any = {};
    if (activeOnly) {
      whereClause.registered = true;
      whereClause.active = true;
    }
    // Exclude DReps marked as "do not list"
    whereClause.OR = [{ doNotList: false }, { doNotList: null }];

    // Get all DRep voting powers
    const dreps = await prisma.drep.findMany({
      where: whereClause,
      select: { votingPower: true },
    });

    // Filter out zero/null voting powers
    const votingPowers = dreps
      .map((d) => d.votingPower)
      .filter((vp) => vp > 0n);

    if (votingPowers.length === 0) {
      return res.json({
        gini: 0,
        drepCount: 0,
        stats: {
          minVotingPower: "0",
          maxVotingPower: "0",
          medianVotingPower: "0",
          p90VotingPower: "0",
          totalVotingPower: "0",
        },
      });
    }

    // Calculate Gini coefficient
    const gini = calculateGini(votingPowers);

    // Sort for statistics
    const sorted = [...votingPowers].sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });

    const total = sorted.reduce((acc, v) => acc + v, 0n);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = percentile(sorted, 50);
    const p90 = percentile(sorted, 90);

    const response: GetGiniCoefficientResponse = {
      gini: Math.round(gini * 10000) / 10000, // 4 decimal places
      drepCount: votingPowers.length,
      stats: {
        minVotingPower: min.toString(),
        maxVotingPower: max.toString(),
        medianVotingPower: median.toString(),
        p90VotingPower: p90.toString(),
        totalVotingPower: total.toString(),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error calculating Gini coefficient", error);
    res.status(500).json({
      error: "Failed to calculate Gini coefficient",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
