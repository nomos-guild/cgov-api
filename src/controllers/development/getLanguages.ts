import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../services/prisma";
import { cacheGet, cacheSet } from "../../services/cache";
import type { DevelopmentLanguagesResponse, LanguageBreakdown } from "../../responses";

const TTL = 60 * 60 * 1000; // 1 hour

async function queryLanguages(since?: Date): Promise<LanguageBreakdown[]> {
  const dateFilter = since
    ? Prisma.sql`AND h.date >= ${since}`
    : Prisma.empty;

  const languages = await prisma.$queryRaw<Array<{
    language: string;
    repo_count: bigint;
    total_stars: bigint;
    total_commits: bigint;
  }>>(
    Prisma.sql`SELECT
      COALESCE(r.language, 'Unknown') AS language,
      COUNT(*) AS repo_count,
      SUM(r.stars) AS total_stars,
      COALESCE(SUM(h.commits), 0) AS total_commits
    FROM github_repository r
    LEFT JOIN (
      SELECT repo_id, SUM(commit_count) AS commits
      FROM activity_historical
      WHERE 1=1 ${dateFilter}
      GROUP BY repo_id
    ) h ON h.repo_id = r.id
    WHERE r.is_active = true
    GROUP BY COALESCE(r.language, 'Unknown')
    ORDER BY repo_count DESC`
  );

  return languages.map((l) => ({
    language: l.language,
    repoCount: Number(l.repo_count),
    totalStars: Number(l.total_stars),
    totalCommits: Number(l.total_commits),
  }));
}

export const getLanguages = async (req: Request, res: Response) => {
  const compare = req.query.compare as string | undefined;
  const cacheKey = `dev:languages${compare ? ":compare" : ""}`;
  const cached = cacheGet<DevelopmentLanguagesResponse>(cacheKey);
  if (cached) return res.json(cached);

  try {
    const languages = await queryLanguages();

    const response: DevelopmentLanguagesResponse = { languages };

    if (compare === "previous") {
      const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const twoYearsAgo = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);

      const previousLanguages = await prisma.$queryRaw<Array<{
        language: string;
        repo_count: bigint;
        total_stars: bigint;
        total_commits: bigint;
      }>>(
        Prisma.sql`SELECT
          COALESCE(r.language, 'Unknown') AS language,
          COUNT(*) AS repo_count,
          SUM(r.stars) AS total_stars,
          COALESCE(SUM(h.commits), 0) AS total_commits
        FROM github_repository r
        LEFT JOIN (
          SELECT repo_id, SUM(commit_count) AS commits
          FROM activity_historical
          WHERE date >= ${twoYearsAgo}
            AND date < ${oneYearAgo}
          GROUP BY repo_id
        ) h ON h.repo_id = r.id
        WHERE r.is_active = true
          AND r.repo_created_at < ${oneYearAgo}
        GROUP BY COALESCE(r.language, 'Unknown')
        ORDER BY repo_count DESC`
      );

      response.previous = previousLanguages.map((l) => ({
        language: l.language,
        repoCount: Number(l.repo_count),
        totalStars: Number(l.total_stars),
        totalCommits: Number(l.total_commits),
      }));
    }

    cacheSet(cacheKey, response, TTL);
    res.json(response);
  } catch (error) {
    console.error("Error fetching languages", error);
    res.status(500).json({
      error: "Failed to fetch languages",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
