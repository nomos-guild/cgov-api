import { Request, Response } from "express";
import { prisma } from "../../services/prisma";
import { cacheGet, cacheSet } from "../../services/cache";
import type { DevelopmentOverviewResponse } from "../../responses";
import { RANGE_DAYS } from "../../constants/development";

const TTL = 5 * 60 * 1000; // 5 min

export const getOverview = async (req: Request, res: Response) => {
  const range = (req.query.range as string) || "30d";
  const compare = req.query.compare === "previous";

  if (!RANGE_DAYS[range]) {
    return res.status(400).json({ error: "Invalid range", message: `Valid: ${Object.keys(RANGE_DAYS).join(", ")}` });
  }

  const cacheKey = `dev:overview:${range}:${compare}`;
  const cached = cacheGet<DevelopmentOverviewResponse>(cacheKey);
  if (cached) return res.json(cached);

  try {
    const days = RANGE_DAYS[range];
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const prevFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);

    const current = await computePeriodStats(from, now);
    const response: DevelopmentOverviewResponse = {
      ...current,
      period: { from: from.toISOString(), to: now.toISOString() },
    };

    if (compare) {
      response.previous = await computePeriodStats(prevFrom, from);
    }

    cacheSet(cacheKey, response, TTL);
    res.json(response);
  } catch (error) {
    console.error("Error fetching overview", error);
    res.status(500).json({
      error: "Failed to fetch overview",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

async function computePeriodStats(from: Date, to: Date) {
  const [repoStats, recentStats, historicalStats] = await Promise.all([
    prisma.githubRepository.count({ where: { isActive: true, lastActivityAt: { gte: from } } }),
    prisma.$queryRaw<Array<{
      contributors: bigint;
      commits: bigint;
      prs: bigint;
    }>>`
      SELECT
        COUNT(DISTINCT author_login) AS contributors,
        COUNT(*) FILTER (WHERE event_type = 'commit') AS commits,
        COUNT(*) FILTER (WHERE event_type IN ('pr_opened', 'pr_merged')) AS prs
      FROM activity_recent
      WHERE event_date >= ${from} AND event_date < ${to}
    `,
    prisma.$queryRaw<Array<{
      contributors: bigint;
      commits: bigint;
      prs: bigint;
      avg_merge: number | null;
    }>>`
      SELECT
        COALESCE(SUM(unique_contributors), 0) AS contributors,
        COALESCE(SUM(commit_count), 0) AS commits,
        COALESCE(SUM(pr_opened + pr_merged), 0) AS prs,
        AVG(avg_pr_merge_hours) AS avg_merge
      FROM activity_historical
      WHERE date >= ${from} AND date < ${to}
    `,
  ]);

  const r = recentStats[0];
  const h = historicalStats[0];

  return {
    activeRepos: repoStats,
    totalContributors: Number(r.contributors) + Number(h.contributors),
    totalCommits: Number(r.commits) + Number(h.commits),
    totalPRs: Number(r.prs) + Number(h.prs),
    avgMergeTimeHours: h.avg_merge ?? null,
  };
}
