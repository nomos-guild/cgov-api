import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import {
  GetEntityConcentrationResponse,
  PoolGroupConcentration,
} from "../../responses/analytics.response";

/**
 * Converts lovelace to ADA string
 */
function lovelaceToAda(lovelace: bigint): string {
  const ada = Number(lovelace) / 1_000_000;
  return ada.toFixed(6);
}

/**
 * GET /analytics/entity-concentration
 * Returns SPO entity voting power concentration
 *
 * Uses PoolGroup to map pools to multi-pool operators/entities
 * and calculates concentration metrics (HHI, top-N share)
 *
 * Query params:
 * - limit: Max number of entities to return (default: all)
 */
export const getEntityConcentration = async (req: Request, res: Response) => {
  try {
    const limitParam = req.query.limit as string | undefined;
    const limit = limitParam
      ? Math.min(500, Math.max(1, parseInt(limitParam)))
      : undefined;

    // Get all pool groups with their pools
    const poolGroups = await prisma.poolGroup.findMany({
      select: {
        poolId: true,
        poolGroup: true,
      },
    });

    // Get all SPO voting powers
    const spos = await prisma.sPO.findMany({
      select: {
        poolId: true,
        votingPower: true,
      },
    });

    // Get vote counts per pool (SPO)
    const poolIds = spos.map((s) => s.poolId);
    const spoVoteCounts = await prisma.onchainVote.groupBy({
      by: ["spoId"],
      where: {
        voterType: VoterType.SPO,
        spoId: { in: poolIds },
      },
      _count: { id: true },
    });

    // Create spoId(poolId) -> voteCount map
    const poolVoteCount = new Map<string, number>();
    for (const vc of spoVoteCounts) {
      if (vc.spoId) {
        poolVoteCount.set(vc.spoId, vc._count.id);
      }
    }

    // Create poolId -> votingPower map
    const poolVotingPower = new Map<string, bigint>();
    for (const spo of spos) {
      poolVotingPower.set(spo.poolId, spo.votingPower);
    }

    const poolIdsInGroup = new Set(poolGroups.map((pg) => pg.poolId));

    // Aggregate voting power by pool group
    const groupPower = new Map<
      string,
      { power: bigint; poolCount: number; totalVotesCast: number }
    >();
    let totalVotingPower = 0n;

    for (const pg of poolGroups) {
      const power = poolVotingPower.get(pg.poolId) ?? 0n;
      const votesCast = poolVoteCount.get(pg.poolId) ?? 0;
      totalVotingPower += power;

      const existing = groupPower.get(pg.poolGroup);
      if (existing) {
        existing.power += power;
        existing.poolCount++;
        existing.totalVotesCast += votesCast;
      } else {
        groupPower.set(pg.poolGroup, { power, poolCount: 1, totalVotesCast: votesCast });
      }
    }

    // Also add pools not in any group as individual entities
    for (const spo of spos) {
      if (!poolIdsInGroup.has(spo.poolId)) {
        // Use poolId as entity identifier for ungrouped pools
        groupPower.set(`pool:${spo.poolId}`, {
          power: spo.votingPower,
          poolCount: 1,
          totalVotesCast: poolVoteCount.get(spo.poolId) ?? 0,
        });
        totalVotingPower += spo.votingPower;
      }
    }

    // Sort by voting power descending
    const sortedGroups = Array.from(groupPower.entries())
      .sort((a, b) => {
        if (a[1].power < b[1].power) return 1;
        if (a[1].power > b[1].power) return -1;
        return 0;
      });

    const limitedGroups = typeof limit === "number" ? sortedGroups.slice(0, limit) : sortedGroups;

    // Calculate metrics
    const entities: PoolGroupConcentration[] = limitedGroups.map(([group, data]) => ({
      poolGroup: group,
      totalVotingPower: data.power.toString(),
      totalVotingPowerAda: lovelaceToAda(data.power),
      totalVotesCast: data.totalVotesCast,
      poolCount: data.poolCount,
      sharePct:
        totalVotingPower > 0n
          ? Number((data.power * 10000n) / totalVotingPower) / 100
          : 0,
    }));

    // Calculate Herfindahl-Hirschman Index (HHI)
    // HHI = sum of (market share %)^2, ranging from 0 to 10000
    let hhi = 0;
    for (const [, data] of groupPower) {
      if (totalVotingPower > 0n) {
        const sharePct = Number((data.power * 10000n) / totalVotingPower) / 100;
        hhi += sharePct * sharePct;
      }
    }
    hhi = Math.round(hhi);

    // Calculate top 5 and top 10 share
    let top5Power = 0n;
    let top10Power = 0n;
    const allSorted = Array.from(groupPower.entries())
      .sort((a, b) => {
        if (a[1].power < b[1].power) return 1;
        if (a[1].power > b[1].power) return -1;
        return 0;
      });

    for (let i = 0; i < Math.min(5, allSorted.length); i++) {
      top5Power += allSorted[i][1].power;
    }
    for (let i = 0; i < Math.min(10, allSorted.length); i++) {
      top10Power += allSorted[i][1].power;
    }

    const top5SharePct =
      totalVotingPower > 0n
        ? Number((top5Power * 10000n) / totalVotingPower) / 100
        : 0;
    const top10SharePct =
      totalVotingPower > 0n
        ? Number((top10Power * 10000n) / totalVotingPower) / 100
        : 0;

    const response: GetEntityConcentrationResponse = {
      entities,
      hhi,
      top5SharePct: Math.round(top5SharePct * 100) / 100,
      top10SharePct: Math.round(top10SharePct * 100) / 100,
      totalVotingPower: totalVotingPower.toString(),
      totalEntities: groupPower.size,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching entity concentration", error);
    res.status(500).json({
      error: "Failed to fetch entity concentration",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
