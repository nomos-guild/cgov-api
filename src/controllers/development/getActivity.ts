import { Request, Response } from "express";
import { prisma } from "../../services/prisma";
import { cacheGet, cacheSet } from "../../services/cache";
import type { ActivityDataPoint, DevelopmentActivityResponse } from "../../responses";
import { RANGE_DAYS } from "../../constants/development";

const TTL = 10 * 60 * 1000; // 10 min

export const getActivity = async (req: Request, res: Response) => {
  const range = (req.query.range as string) || "30d";
  const compare = req.query.compare === "previous";

  if (!RANGE_DAYS[range]) {
    return res.status(400).json({ error: "Invalid range", message: `Valid: ${Object.keys(RANGE_DAYS).join(", ")}` });
  }

  const cacheKey = `dev:activity:${range}:${compare}`;
  const cached = cacheGet<DevelopmentActivityResponse>(cacheKey);
  if (cached) return res.json(cached);

  try {
    const days = RANGE_DAYS[range];
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const data = await getTimeSeries(from, now);
    const response: DevelopmentActivityResponse = { range, data };

    if (compare) {
      const prevFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
      response.previous = await getTimeSeries(prevFrom, from);
    }

    cacheSet(cacheKey, response, TTL);
    res.json(response);
  } catch (error) {
    console.error("Error fetching activity", error);
    res.status(500).json({
      error: "Failed to fetch activity",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

async function getTimeSeries(from: Date, to: Date): Promise<ActivityDataPoint[]> {
  // Historical data (aggregated daily)
  const historical = await prisma.activityHistorical.groupBy({
    by: ["date"],
    where: { date: { gte: from, lt: to } },
    _sum: {
      commitCount: true,
      prOpened: true,
      prMerged: true,
      issuesOpened: true,
      issuesClosed: true,
    },
    orderBy: { date: "asc" },
  });

  // Recent data (aggregate on the fly)
  const recent = await prisma.$queryRaw<Array<{
    date: Date;
    commits: bigint;
    pr_opened: bigint;
    pr_merged: bigint;
    issues_opened: bigint;
    issues_closed: bigint;
  }>>`
    SELECT
      DATE(event_date) AS date,
      COUNT(*) FILTER (WHERE event_type = 'commit') AS commits,
      COUNT(*) FILTER (WHERE event_type = 'pr_opened') AS pr_opened,
      COUNT(*) FILTER (WHERE event_type = 'pr_merged') AS pr_merged,
      COUNT(*) FILTER (WHERE event_type = 'issue_opened') AS issues_opened,
      COUNT(*) FILTER (WHERE event_type = 'issue_closed') AS issues_closed
    FROM activity_recent
    WHERE event_date >= ${from} AND event_date < ${to}
    GROUP BY DATE(event_date)
    ORDER BY date ASC
  `;

  // Merge into a single map keyed by date string
  const map = new Map<string, ActivityDataPoint>();

  for (const h of historical) {
    const key = h.date.toISOString().slice(0, 10);
    map.set(key, {
      date: key,
      commits: h._sum.commitCount ?? 0,
      prOpened: h._sum.prOpened ?? 0,
      prMerged: h._sum.prMerged ?? 0,
      issuesOpened: h._sum.issuesOpened ?? 0,
      issuesClosed: h._sum.issuesClosed ?? 0,
    });
  }

  for (const r of recent) {
    const key = r.date.toISOString().slice(0, 10);
    const existing = map.get(key);
    if (existing) {
      existing.commits += Number(r.commits);
      existing.prOpened += Number(r.pr_opened);
      existing.prMerged += Number(r.pr_merged);
      existing.issuesOpened += Number(r.issues_opened);
      existing.issuesClosed += Number(r.issues_closed);
    } else {
      map.set(key, {
        date: key,
        commits: Number(r.commits),
        prOpened: Number(r.pr_opened),
        prMerged: Number(r.pr_merged),
        issuesOpened: Number(r.issues_opened),
        issuesClosed: Number(r.issues_closed),
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}
