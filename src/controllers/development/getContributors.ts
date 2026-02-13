import { Request, Response } from "express";
import { prisma } from "../../services/prisma";
import { cacheGet, cacheSet } from "../../services/cache";
import type { DevelopmentContributorsResponse } from "../../responses";
import { RANGE_DAYS } from "../../constants/development";

const TTL = 30 * 60 * 1000; // 30 min

export const getContributors = async (req: Request, res: Response) => {
  const range = (req.query.range as string) || "90d";
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10) || 50, 200);

  if (!RANGE_DAYS[range]) {
    return res.status(400).json({ error: "Invalid range", message: `Valid: ${Object.keys(RANGE_DAYS).join(", ")}` });
  }

  const cacheKey = `dev:contributors:${range}:${limit}`;
  const cached = cacheGet<DevelopmentContributorsResponse>(cacheKey);
  if (cached) return res.json(cached);

  try {
    const since = new Date(Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000);

    const contributors = await prisma.githubDeveloper.findMany({
      where: { lastSeenAt: { gte: since } },
      orderBy: { totalCommits: "desc" },
      take: limit,
    });

    const total = await prisma.githubDeveloper.count({
      where: { lastSeenAt: { gte: since } },
    });

    const response: DevelopmentContributorsResponse = {
      contributors: contributors.map((c) => ({
        login: c.id,
        avatarUrl: c.avatarUrl,
        totalCommits: c.totalCommits,
        totalPRs: c.totalPRs,
        repoCount: c.repoCount,
        orgCount: c.orgCount,
        firstSeenAt: c.firstSeenAt.toISOString(),
        lastSeenAt: c.lastSeenAt.toISOString(),
        isActive: c.isActive,
      })),
      total,
      range,
    };

    cacheSet(cacheKey, response, TTL);
    res.json(response);
  } catch (error) {
    console.error("Error fetching contributors", error);
    res.status(500).json({
      error: "Failed to fetch contributors",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
