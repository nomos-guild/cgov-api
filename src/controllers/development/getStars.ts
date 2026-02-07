import { Request, Response } from "express";
import { prisma } from "../../services/prisma";
import { cacheGet, cacheSet } from "../../services/cache";
import type { DevelopmentStarsResponse } from "../../responses";
import { RANGE_DAYS } from "../../constants/development";

const TTL = 60 * 60 * 1000; // 1 hour

export const getStars = async (req: Request, res: Response) => {
  const range = (req.query.range as string) || "90d";

  if (!RANGE_DAYS[range]) {
    return res.status(400).json({ error: "Invalid range", message: `Valid: ${Object.keys(RANGE_DAYS).join(", ")}` });
  }

  const cacheKey = `dev:stars:${range}`;
  const cached = cacheGet<DevelopmentStarsResponse>(cacheKey);
  if (cached) return res.json(cached);

  try {
    const since = new Date(Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000);

    const [snapshots, topRepos] = await Promise.all([
      prisma.$queryRaw<Array<{
        date: Date;
        total_stars: bigint;
        total_forks: bigint;
      }>>`
        SELECT
          date,
          SUM(stars) AS total_stars,
          SUM(forks) AS total_forks
        FROM repo_daily_snapshot
        WHERE date >= ${since}
        GROUP BY date
        ORDER BY date ASC
      `,
      prisma.$queryRaw<Array<{
        id: string;
        name: string;
        stars: number;
        total_stars: bigint;
      }>>`
        SELECT
          id, name, stars,
          SUM(stars) OVER () AS total_stars
        FROM github_repository
        WHERE is_active = true AND stars > 0
        ORDER BY stars DESC
        LIMIT 5
      `,
    ]);

    const totalStars = topRepos.length > 0 ? Number(topRepos[0].total_stars) : 0;

    const response: DevelopmentStarsResponse = {
      range,
      data: snapshots.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        totalStars: Number(s.total_stars),
        totalForks: Number(s.total_forks),
      })),
      topReposByStars: topRepos.map((r) => ({
        id: r.id,
        name: r.name,
        stars: r.stars,
        share: totalStars > 0 ? r.stars / totalStars : 0,
      })),
    };

    cacheSet(cacheKey, response, TTL);
    res.json(response);
  } catch (error) {
    console.error("Error fetching star trends", error);
    res.status(500).json({
      error: "Failed to fetch star trends",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
