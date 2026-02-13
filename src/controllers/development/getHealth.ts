import { Request, Response } from "express";
import { prisma } from "../../services/prisma";
import { cacheGet, cacheSet } from "../../services/cache";
import type { DevelopmentHealthResponse } from "../../responses";
import { RANGE_DAYS } from "../../constants/development";

const TTL = 60 * 60 * 1000; // 1 hour

async function computeRangeMetrics(from: Date, to: Date) {
  const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  const monthsInRange = Math.max(days / 30, 1);

  const [
    activeRepoCount,
    prHistorical, prRecent,
    issueHistorical, issueRecent,
    devStats,
    commitStats,
    issueResolution,
    releaseStats,
    growthStats,
    forkDelta,
  ] = await Promise.all([
    prisma.githubRepository.count({ where: { isActive: true, lastActivityAt: { gte: from, lt: to } } }),

    prisma.$queryRaw<[{ opened: bigint; merged: bigint; closed: bigint; avg_merge: number | null }]>`
      SELECT
        COALESCE(SUM(pr_opened), 0) AS opened,
        COALESCE(SUM(pr_merged), 0) AS merged,
        COALESCE(SUM(pr_closed), 0) AS closed,
        AVG(avg_pr_merge_hours) AS avg_merge
      FROM activity_historical
      WHERE date >= ${from} AND date < ${to}
    `,
    prisma.$queryRaw<[{ opened: bigint; merged: bigint; closed: bigint }]>`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'pr_opened') AS opened,
        COUNT(*) FILTER (WHERE event_type = 'pr_merged') AS merged,
        COUNT(*) FILTER (WHERE event_type = 'pr_closed') AS closed
      FROM activity_recent
      WHERE event_date >= ${from} AND event_date < ${to}
    `,

    prisma.$queryRaw<[{ opened: bigint; closed: bigint }]>`
      SELECT
        COALESCE(SUM(issues_opened), 0) AS opened,
        COALESCE(SUM(issues_closed), 0) AS closed
      FROM activity_historical
      WHERE date >= ${from} AND date < ${to}
    `,
    prisma.$queryRaw<[{ opened: bigint; closed: bigint }]>`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'issue_opened') AS opened,
        COUNT(*) FILTER (WHERE event_type = 'issue_closed') AS closed
      FROM activity_recent
      WHERE event_date >= ${from} AND event_date < ${to}
    `,

    prisma.$queryRaw<[{ new_devs: bigint; returning_devs: bigint }]>`
      SELECT
        COUNT(*) FILTER (WHERE first_seen_at >= ${from} AND first_seen_at < ${to}) AS new_devs,
        COUNT(*) FILTER (WHERE first_seen_at < ${from} AND last_seen_at >= ${from} AND last_seen_at < ${to}) AS returning_devs
      FROM github_developer
    `,

    prisma.$queryRaw<[{ total_commits: bigint; active_devs: bigint }]>`
      SELECT
        (SELECT COALESCE(SUM(commit_count), 0) FROM activity_historical WHERE date >= ${from} AND date < ${to})
        + (SELECT COUNT(*) FROM activity_recent WHERE event_date >= ${from} AND event_date < ${to} AND event_type = 'commit')
        AS total_commits,
        (SELECT COUNT(*) FROM github_developer WHERE last_seen_at >= ${from} AND last_seen_at < ${to}) AS active_devs
    `,

    prisma.$queryRaw<[{ weighted_avg: number | null }]>`
      SELECT
        CASE
          WHEN SUM(issues_closed) > 0 THEN
            SUM(avg_issue_resolution_hours * issues_closed) / SUM(issues_closed)
          ELSE NULL
        END AS weighted_avg
      FROM activity_historical
      WHERE date >= ${from} AND date < ${to}
        AND avg_issue_resolution_hours IS NOT NULL
    `,

    prisma.$queryRaw<[{ total_releases: bigint }]>`
      SELECT COALESCE(SUM(releases_published), 0) AS total_releases
      FROM activity_historical
      WHERE date >= ${from} AND date < ${to}
    `,

    prisma.$queryRaw<[{ new_repos: bigint; total_repos: bigint }]>`
      SELECT
        COUNT(*) FILTER (WHERE repo_created_at >= ${from} AND repo_created_at < ${to}) AS new_repos,
        COUNT(*) AS total_repos
      FROM github_repository
      WHERE is_active = true
    `,

    prisma.$queryRaw<[{ fork_delta: bigint; latest_forks: bigint }]>`
      SELECT
        COALESCE(SUM(s2.forks) - SUM(s1.forks), 0) AS fork_delta,
        COALESCE(SUM(s2.forks), 0) AS latest_forks
      FROM (
        SELECT DISTINCT ON (repo_id) repo_id, forks
        FROM repo_daily_snapshot
        WHERE date >= ${from} AND date < ${to}
        ORDER BY repo_id, date ASC
      ) s1
      JOIN (
        SELECT DISTINCT ON (repo_id) repo_id, forks
        FROM repo_daily_snapshot
        WHERE date >= ${from} AND date < ${to}
        ORDER BY repo_id, date DESC
      ) s2 ON s1.repo_id = s2.repo_id
    `,
  ]);

  const totalRepoCount = await prisma.githubRepository.count({ where: { isActive: true } });

  const prH = prHistorical[0];
  const prR = prRecent[0];
  const issH = issueHistorical[0];
  const issR = issueRecent[0];
  const dev = devStats[0];
  const totalPROpened = Number(prH.opened) + Number(prR.opened);
  const totalPRMerged = Number(prH.merged) + Number(prR.merged);
  const totalPRClosed = Number(prH.closed) + Number(prR.closed);
  const totalPRs = totalPROpened + totalPRMerged + totalPRClosed;
  const totalIssueOpened = Number(issH.opened) + Number(issR.opened);
  const totalIssueClosed = Number(issH.closed) + Number(issR.closed);
  const totalIssues = totalIssueOpened + totalIssueClosed;
  const newDevs = Number(dev.new_devs);
  const returningDevs = Number(dev.returning_devs);
  const activeDevCount = Number(commitStats[0].active_devs);
  const totalCommits = Number(commitStats[0].total_commits);

  return {
    activeRepos: activeRepoCount,
    dormantRepos: totalRepoCount - activeRepoCount,
    maintenanceRate: totalRepoCount > 0 ? activeRepoCount / totalRepoCount : 0,
    avgMergeTimeHours: prH.avg_merge ?? null,
    prCloseRate: totalPRs > 0 ? (totalPRMerged + totalPRClosed) / totalPRs : 0,
    issueCloseRate: totalIssues > 0 ? totalIssueClosed / totalIssues : 0,
    newContributors: newDevs,
    returningContributors: returningDevs,
    retentionRate: newDevs + returningDevs > 0 ? returningDevs / (newDevs + returningDevs) : null,
    codeVelocity: activeDevCount > 0 ? totalCommits / activeDevCount / monthsInRange : null,
    avgIssueResolutionHours: issueResolution[0].weighted_avg ?? null,
    releaseCadence: Number(releaseStats[0].total_releases),
    ecosystemGrowthRate: Number(growthStats[0].total_repos) > 0
      ? Number(growthStats[0].new_repos) / Number(growthStats[0].total_repos)
      : null,
    forkActivityRate: Number(forkDelta[0].latest_forks) > 0
      ? Number(forkDelta[0].fork_delta) / Number(forkDelta[0].latest_forks)
      : null,
  };
}

export const getHealth = async (req: Request, res: Response) => {
  const range = (req.query.range as string) || "90d";
  const compare = req.query.compare === "previous";

  if (!RANGE_DAYS[range]) {
    return res.status(400).json({ error: "Invalid range", message: `Valid: ${Object.keys(RANGE_DAYS).join(", ")}` });
  }

  const cacheKey = `dev:health:${range}:${compare}`;
  const cached = cacheGet<DevelopmentHealthResponse>(cacheKey);
  if (cached) return res.json(cached);

  try {
    const days = RANGE_DAYS[range];
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const [
      rangeMetrics,
      ghostingStats,
      abandonmentStats,
      starDistribution,
    ] = await Promise.all([
      computeRangeMetrics(from, now),

      prisma.$queryRaw<[{ ghosted: bigint; eligible: bigint }]>`
        SELECT
          COUNT(*) FILTER (WHERE last_seen_at < ${sixMonthsAgo}) AS ghosted,
          COUNT(*) AS eligible
        FROM github_developer
        WHERE first_seen_at < ${oneYearAgo}
      `,

      prisma.$queryRaw<[{ abandoned: bigint; total: bigint }]>`
        SELECT
          COUNT(*) FILTER (WHERE last_activity_at < ${oneYearAgo}) AS abandoned,
          COUNT(*) AS total
        FROM github_repository
        WHERE is_archived = false
      `,

      prisma.$queryRaw<[{ top_share: number | null }]>`
        WITH ranked AS (
          SELECT stars,
                 SUM(stars) OVER () AS total_stars,
                 COUNT(*) OVER () AS total_count,
                 ROW_NUMBER() OVER (ORDER BY stars DESC) AS rn
          FROM github_repository
          WHERE is_active = true AND stars > 0
        )
        SELECT
          CASE WHEN MAX(total_stars) > 0
            THEN SUM(CASE WHEN rn <= CEIL(total_count * 0.1) THEN stars ELSE 0 END)::float / MAX(total_stars)
            ELSE NULL
          END AS top_share
        FROM ranked
      `,
    ]);

    const response: DevelopmentHealthResponse = {
      range,
      ...rangeMetrics,
      ghostingRate: Number(ghostingStats[0].eligible) > 0
        ? Number(ghostingStats[0].ghosted) / Number(ghostingStats[0].eligible)
        : null,
      abandonmentRate: Number(abandonmentStats[0].total) > 0
        ? Number(abandonmentStats[0].abandoned) / Number(abandonmentStats[0].total)
        : null,
      starConcentration: starDistribution[0].top_share ?? null,
    };

    if (compare) {
      const prevFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
      const prev = await computeRangeMetrics(prevFrom, from);
      response.previous = {
        maintenanceRate: prev.maintenanceRate,
        avgMergeTimeHours: prev.avgMergeTimeHours,
        prCloseRate: prev.prCloseRate,
        issueCloseRate: prev.issueCloseRate,
        retentionRate: prev.retentionRate,
        codeVelocity: prev.codeVelocity,
        avgIssueResolutionHours: prev.avgIssueResolutionHours,
        releaseCadence: prev.releaseCadence,
        ecosystemGrowthRate: prev.ecosystemGrowthRate,
        forkActivityRate: prev.forkActivityRate,
      };
    }

    cacheSet(cacheKey, response, TTL);
    res.json(response);
  } catch (error) {
    console.error("Error fetching health metrics", error);
    res.status(500).json({
      error: "Failed to fetch health metrics",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
