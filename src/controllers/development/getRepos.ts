import { Request, Response } from "express";
import { prisma } from "../../services/prisma";
import { cacheGet, cacheSet } from "../../services/cache";
import type { DevelopmentReposResponse, RepoSummary } from "../../responses";
import { RANGE_DAYS } from "../../constants/development";

const TTL = 10 * 60 * 1000; // 10 min

const ORDER_CLAUSES = {
  stars: "r.stars DESC",
  recent: "r.last_activity_at DESC NULLS LAST",
  commits: "recent_commits DESC",
  trending: "star_gain DESC, r.stars DESC",
} as const;

export const getRepos = async (req: Request, res: Response) => {
  const sort = (req.query.sort as string) || "recent";
  const range = (req.query.range as string) || "30d";
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10) || 50, 200);

  if (!ORDER_CLAUSES[sort]) {
    return res.status(400).json({ error: "Invalid sort", message: "Valid: commits, stars, recent, trending" });
  }
  if (!RANGE_DAYS[range]) {
    return res.status(400).json({ error: "Invalid range", message: `Valid: ${Object.keys(RANGE_DAYS).join(", ")}` });
  }

  const cacheKey = `dev:repos:${sort}:${range}:${limit}`;
  const cached = cacheGet<DevelopmentReposResponse>(cacheKey);
  if (cached) return res.json(cached);

  try {
    const days = RANGE_DAYS[range];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // ORDER BY cannot be parameterized in Prisma. The `sort` value is validated
    // against ORDER_CLAUSES whitelist above — only pre-defined SQL fragments are used.
    const repos = await prisma.$queryRawUnsafe<Array<{
      id: string;
      owner: string;
      name: string;
      description: string | null;
      language: string | null;
      stars: number;
      forks: number;
      last_activity_at: Date | null;
      sync_tier: string;
      recent_commits: bigint;
      recent_prs: bigint;
      star_gain: number;
    }>>(
      `SELECT
        r.id, r.owner, r.name, r.description, r.language,
        r.stars, r.forks, r.last_activity_at, r.sync_tier,
        COALESCE(a.recent_commits, 0) AS recent_commits,
        COALESCE(a.recent_prs, 0) AS recent_prs,
        COALESCE(sg.star_gain, 0) AS star_gain
      FROM github_repository r
      LEFT JOIN (
        SELECT
          repo_id,
          COUNT(*) FILTER (WHERE event_type = 'commit') AS recent_commits,
          COUNT(*) FILTER (WHERE event_type IN ('pr_opened', 'pr_merged')) AS recent_prs
        FROM activity_recent
        WHERE event_date >= $2
        GROUP BY repo_id
      ) a ON a.repo_id = r.id
      LEFT JOIN (
        SELECT s2.repo_id, (s2.stars - s1.stars) AS star_gain
        FROM (
          SELECT DISTINCT ON (repo_id) repo_id, stars
          FROM repo_daily_snapshot WHERE date >= $2
          ORDER BY repo_id, date ASC
        ) s1
        JOIN (
          SELECT DISTINCT ON (repo_id) repo_id, stars
          FROM repo_daily_snapshot WHERE date >= $2
          ORDER BY repo_id, date DESC
        ) s2 ON s1.repo_id = s2.repo_id
      ) sg ON sg.repo_id = r.id
      WHERE r.is_active = true
      ORDER BY ${ORDER_CLAUSES[sort]}
      LIMIT $1`,
      limit,
      from
    );

    const result: RepoSummary[] = repos.map((r) => ({
      id: r.id,
      owner: r.owner,
      name: r.name,
      description: r.description,
      language: r.language,
      stars: r.stars,
      forks: r.forks,
      recentCommits: Number(r.recent_commits),
      recentPRs: Number(r.recent_prs),
      lastActivityAt: r.last_activity_at?.toISOString() ?? null,
      syncTier: r.sync_tier,
      starGain: r.star_gain,
    }));

    const total = await prisma.githubRepository.count({ where: { isActive: true } });
    const response: DevelopmentReposResponse = { repos: result, total };

    cacheSet(cacheKey, response, TTL);
    res.json(response);
  } catch (error) {
    console.error("Error fetching repos", error);
    res.status(500).json({
      error: "Failed to fetch repos",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
