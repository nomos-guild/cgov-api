import { Request, Response } from "express";
import { VoterType, VoteType } from "@prisma/client";
import { prisma } from "../../services";
import {
  GetDRepCorrelationResponse,
  DRepPairCorrelation,
} from "../../responses/analytics.response";

/**
 * Calculates agreement and correlation between two vote vectors
 */
function calculateCorrelation(
  votes1: Map<string, VoteType>,
  votes2: Map<string, VoteType>
): { sharedProposals: number; agreementPct: number; correlation: number | null } {
  // Find shared proposals
  const sharedProposals: string[] = [];
  for (const proposalId of votes1.keys()) {
    if (votes2.has(proposalId)) {
      sharedProposals.push(proposalId);
    }
  }

  if (sharedProposals.length === 0) {
    return { sharedProposals: 0, agreementPct: 0, correlation: null };
  }

  // Calculate agreement (same vote)
  let agreements = 0;
  for (const pid of sharedProposals) {
    if (votes1.get(pid) === votes2.get(pid)) {
      agreements++;
    }
  }
  const agreementPct = Math.round((agreements / sharedProposals.length) * 10000) / 100;

  // Calculate Pearson correlation
  // Map votes to numeric values: YES=1, NO=-1, ABSTAIN=0
  const voteToNum = (v: VoteType): number => {
    if (v === VoteType.YES) return 1;
    if (v === VoteType.NO) return -1;
    return 0;
  };

  const x: number[] = [];
  const y: number[] = [];
  for (const pid of sharedProposals) {
    x.push(voteToNum(votes1.get(pid)!));
    y.push(voteToNum(votes2.get(pid)!));
  }

  const n = x.length;
  if (n < 2) {
    return { sharedProposals: n, agreementPct, correlation: null };
  }

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  const correlation = denom > 0 ? numerator / denom : null;

  return {
    sharedProposals: n,
    agreementPct,
    correlation: correlation !== null ? Math.round(correlation * 10000) / 10000 : null,
  };
}

/**
 * GET /analytics/drep-correlation
 * Returns DRep voting correlation analysis
 *
 * Query params:
 * - drepId1: First DRep ID (optional, for specific pair)
 * - drepId2: Second DRep ID (optional, for specific pair)
 * - topN: Number of top correlated/divergent pairs to return (default: 10)
 * - minSharedProposals: Minimum shared proposals for inclusion (default: 3)
 */
export const getDRepCorrelation = async (req: Request, res: Response) => {
  try {
    const drepId1 = req.query.drepId1 as string | undefined;
    const drepId2 = req.query.drepId2 as string | undefined;
    const topN = Math.min(50, Math.max(1, parseInt(req.query.topN as string) || 10));
    const minSharedProposals = Math.max(1, parseInt(req.query.minSharedProposals as string) || 3);

    // If specific pair requested
    if (drepId1 && drepId2) {
      const [drep1, drep2] = await Promise.all([
        prisma.drep.findUnique({ where: { drepId: drepId1 }, select: { drepId: true, name: true } }),
        prisma.drep.findUnique({ where: { drepId: drepId2 }, select: { drepId: true, name: true } }),
      ]);

      if (!drep1 || !drep2) {
        return res.status(404).json({
          error: "DRep not found",
          message: "One or both DRep IDs not found",
        });
      }

      // Get votes for both DReps
      const [votes1, votes2] = await Promise.all([
        prisma.onchainVote.findMany({
          where: { drepId: drepId1, voterType: VoterType.DREP, vote: { not: null } },
          select: { proposalId: true, vote: true },
        }),
        prisma.onchainVote.findMany({
          where: { drepId: drepId2, voterType: VoterType.DREP, vote: { not: null } },
          select: { proposalId: true, vote: true },
        }),
      ]);

      const map1 = new Map<string, VoteType>();
      const map2 = new Map<string, VoteType>();
      for (const v of votes1) {
        if (v.vote) map1.set(v.proposalId, v.vote);
      }
      for (const v of votes2) {
        if (v.vote) map2.set(v.proposalId, v.vote);
      }

      const result = calculateCorrelation(map1, map2);

      const pairCorrelation: DRepPairCorrelation = {
        drepId1: drep1.drepId,
        drepId2: drep2.drepId,
        drepName1: drep1.name,
        drepName2: drep2.name,
        ...result,
      };

      return res.json({
        topCorrelated: [],
        topDivergent: [],
        pairCorrelation,
      });
    }

    // Get all DReps with votes
    const drepsWithVotes = await prisma.drep.findMany({
      where: {
        OR: [{ doNotList: false }, { doNotList: null }],
        onchainVotes: { some: { voterType: VoterType.DREP } },
      },
      select: { drepId: true, name: true },
    });

    if (drepsWithVotes.length < 2) {
      return res.json({
        topCorrelated: [],
        topDivergent: [],
      });
    }

    // Get all DRep votes
    const allVotes = await prisma.onchainVote.findMany({
      where: {
        voterType: VoterType.DREP,
        drepId: { in: drepsWithVotes.map((d) => d.drepId) },
        vote: { not: null },
      },
      select: { drepId: true, proposalId: true, vote: true },
    });

    // Build vote maps per DRep
    const voteMaps = new Map<string, Map<string, VoteType>>();
    for (const v of allVotes) {
      if (!v.drepId || !v.vote) continue;
      if (!voteMaps.has(v.drepId)) {
        voteMaps.set(v.drepId, new Map());
      }
      voteMaps.get(v.drepId)!.set(v.proposalId, v.vote);
    }

    // Create DRep name map
    const nameMap = new Map<string, string | null>();
    for (const d of drepsWithVotes) {
      nameMap.set(d.drepId, d.name);
    }

    // Calculate correlations for all pairs
    const drepIds = Array.from(voteMaps.keys());
    const correlations: DRepPairCorrelation[] = [];

    for (let i = 0; i < drepIds.length; i++) {
      for (let j = i + 1; j < drepIds.length; j++) {
        const id1 = drepIds[i];
        const id2 = drepIds[j];
        const result = calculateCorrelation(voteMaps.get(id1)!, voteMaps.get(id2)!);

        if (result.sharedProposals >= minSharedProposals) {
          correlations.push({
            drepId1: id1,
            drepId2: id2,
            drepName1: nameMap.get(id1) ?? null,
            drepName2: nameMap.get(id2) ?? null,
            ...result,
          });
        }
      }
    }

    // Sort and get top correlated (highest agreement/correlation)
    const topCorrelated = [...correlations]
      .filter((c) => c.correlation !== null)
      .sort((a, b) => (b.correlation ?? 0) - (a.correlation ?? 0))
      .slice(0, topN);

    // Sort and get top divergent (lowest agreement/correlation)
    const topDivergent = [...correlations]
      .filter((c) => c.correlation !== null)
      .sort((a, b) => (a.correlation ?? 0) - (b.correlation ?? 0))
      .slice(0, topN);

    const response: GetDRepCorrelationResponse = {
      topCorrelated,
      topDivergent,
    };

    res.json(response);
  } catch (error) {
    console.error("Error calculating DRep correlation", error);
    res.status(500).json({
      error: "Failed to calculate DRep correlation",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
