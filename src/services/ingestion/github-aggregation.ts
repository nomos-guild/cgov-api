import { prisma } from "../prisma";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AggregationResult {
  daysRolledUp: number;
  rowsDeleted: number;
  developersUpdated: number;
}

export interface NetworkGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  generatedAt: string;
  rangeDays: number;
}

interface GraphNode {
  id: string;
  type: "org" | "repo" | "developer";
  label: string;
  size: number; // activity-weighted
  meta?: Record<string, unknown>;
}

interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

// ─── In-Memory Graph Cache ───────────────────────────────────────────────────

const graphCache = new Map<number, { data: NetworkGraphData; expiresAt: number }>();
const GRAPH_TTL_MS = 30 * 60 * 1000; // 30 min

export function getCachedGraph(rangeDays: number): NetworkGraphData | null {
  const entry = graphCache.get(rangeDays);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data;
}

// ─── Daily Aggregation ───────────────────────────────────────────────────────

export async function aggregateRecentToHistorical(): Promise<AggregationResult> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Fetch old events to roll up
  const oldEvents = await prisma.activityRecent.findMany({
    where: { eventDate: { lt: cutoff } },
    select: {
      repoId: true,
      eventType: true,
      eventDate: true,
      authorLogin: true,
      additions: true,
      deletions: true,
    },
  });

  if (oldEvents.length === 0) {
    return { daysRolledUp: 0, rowsDeleted: 0, developersUpdated: 0 };
  }

  // Group by (repoId, date)
  const buckets = new Map<
    string,
    {
      repoId: string;
      date: Date;
      commitCount: number;
      prOpened: number;
      prMerged: number;
      prClosed: number;
      issuesOpened: number;
      issuesClosed: number;
      additions: number;
      deletions: number;
      contributors: Set<string>;
    }
  >();

  for (const e of oldEvents) {
    const dateStr = e.eventDate.toISOString().slice(0, 10);
    const key = `${e.repoId}:${dateStr}`;

    let b = buckets.get(key);
    if (!b) {
      b = {
        repoId: e.repoId,
        date: new Date(dateStr),
        commitCount: 0,
        prOpened: 0,
        prMerged: 0,
        prClosed: 0,
        issuesOpened: 0,
        issuesClosed: 0,
        additions: 0,
        deletions: 0,
        contributors: new Set(),
      };
      buckets.set(key, b);
    }

    if (e.authorLogin) b.contributors.add(e.authorLogin);

    switch (e.eventType) {
      case "commit":
        b.commitCount++;
        b.additions += e.additions ?? 0;
        b.deletions += e.deletions ?? 0;
        break;
      case "pr_opened":
        b.prOpened++;
        break;
      case "pr_merged":
        b.prMerged++;
        break;
      case "pr_closed":
        b.prClosed++;
        break;
      case "issue_opened":
        b.issuesOpened++;
        break;
      case "issue_closed":
        b.issuesClosed++;
        break;
    }
  }

  // Upsert into activity_historical
  for (const b of buckets.values()) {
    await prisma.activityHistorical.upsert({
      where: {
        repoId_date: { repoId: b.repoId, date: b.date },
      },
      create: {
        repoId: b.repoId,
        date: b.date,
        commitCount: b.commitCount,
        prOpened: b.prOpened,
        prMerged: b.prMerged,
        prClosed: b.prClosed,
        issuesOpened: b.issuesOpened,
        issuesClosed: b.issuesClosed,
        additions: b.additions,
        deletions: b.deletions,
        uniqueContributors: b.contributors.size,
      },
      update: {
        commitCount: { increment: b.commitCount },
        prOpened: { increment: b.prOpened },
        prMerged: { increment: b.prMerged },
        prClosed: { increment: b.prClosed },
        issuesOpened: { increment: b.issuesOpened },
        issuesClosed: { increment: b.issuesClosed },
        additions: { increment: b.additions },
        deletions: { increment: b.deletions },
      },
    });
  }

  // Update developer_repo_activity from events being rolled up
  await updateDeveloperRepoActivity(oldEvents);

  // Delete rolled-up rows
  const deleted = await prisma.activityRecent.deleteMany({
    where: { eventDate: { lt: cutoff } },
  });

  console.log(
    `[aggregation] Rolled up ${buckets.size} day-buckets from ${oldEvents.length} events, ` +
      `deleted ${deleted.count} rows`
  );

  // Recompute developer stats from developer_repo_activity + activity_recent
  const devsUpdated = await recomputeDeveloperStats();

  return {
    daysRolledUp: buckets.size,
    rowsDeleted: deleted.count,
    developersUpdated: devsUpdated,
  };
}

// ─── Developer Repo Activity Update ──────────────────────────────────────────

async function updateDeveloperRepoActivity(
  events: Array<{
    repoId: string;
    eventType: string;
    eventDate: Date;
    authorLogin: string | null;
  }>
): Promise<void> {
  // Aggregate per (author, repo)
  const map = new Map<string, { commits: number; prs: number; lastActiveAt: Date }>();

  for (const e of events) {
    if (!e.authorLogin) continue;
    const key = `${e.authorLogin}:${e.repoId}`;
    let s = map.get(key);
    if (!s) {
      s = { commits: 0, prs: 0, lastActiveAt: e.eventDate };
      map.set(key, s);
    }
    if (e.eventType === "commit") s.commits++;
    if (e.eventType === "pr_opened" || e.eventType === "pr_merged") s.prs++;
    if (e.eventDate > s.lastActiveAt) s.lastActiveAt = e.eventDate;
  }

  for (const [key, s] of map) {
    const [login, ...repoParts] = key.split(":");
    const repoId = repoParts.join(":"); // handle : in repo names (unlikely but safe)

    await prisma.developerRepoActivity.upsert({
      where: { developerLogin_repoId: { developerLogin: login, repoId } },
      create: {
        developerLogin: login,
        repoId,
        totalCommits: s.commits,
        totalPRs: s.prs,
        lastActiveAt: s.lastActiveAt,
      },
      update: {
        totalCommits: { increment: s.commits },
        totalPRs: { increment: s.prs },
        lastActiveAt: s.lastActiveAt,
      },
    });
  }
}

// ─── Developer Stats Recompute ───────────────────────────────────────────────

async function recomputeDeveloperStats(): Promise<number> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // All-time stats from developer_repo_activity (historical + previously rolled up)
  // + current week from activity_recent (not yet rolled up)
  const stats: Array<{
    developer_login: string;
    total_commits: bigint;
    total_prs: bigint;
    repo_count: bigint;
    org_count: bigint;
  }> = await prisma.$queryRaw`
    SELECT
      developer_login,
      SUM(total_commits) AS total_commits,
      SUM(total_prs) AS total_prs,
      COUNT(DISTINCT repo_id) AS repo_count,
      COUNT(DISTINCT split_part(repo_id, '/', 1)) AS org_count
    FROM (
      SELECT developer_login, repo_id, total_commits, total_prs
      FROM developer_repo_activity
      UNION ALL
      SELECT
        author_login AS developer_login,
        repo_id,
        COUNT(*) FILTER (WHERE event_type = 'commit') AS total_commits,
        COUNT(*) FILTER (WHERE event_type IN ('pr_opened', 'pr_merged')) AS total_prs
      FROM activity_recent
      WHERE author_login IS NOT NULL
      GROUP BY author_login, repo_id
    ) combined
    GROUP BY developer_login
  `;

  let updated = 0;
  for (const s of stats) {
    try {
      await prisma.githubDeveloper.updateMany({
        where: { id: s.developer_login },
        data: {
          totalCommits: Number(s.total_commits),
          totalPRs: Number(s.total_prs),
          repoCount: Number(s.repo_count),
          orgCount: Number(s.org_count),
          isActive: true,
        },
      });
      updated++;
    } catch {
      // Developer may not exist yet
    }
  }

  // Mark inactive developers (not seen in 90 days)
  await prisma.githubDeveloper.updateMany({
    where: {
      lastSeenAt: { lt: ninetyDaysAgo },
      isActive: true,
    },
    data: { isActive: false },
  });

  console.log(`[aggregation] Recomputed stats for ${updated} developers`);
  return updated;
}

// ─── Network Graph Precomputation ────────────────────────────────────────────

export async function precomputeNetworkGraphs(): Promise<void> {
  for (const days of [30, 90, 365]) {
    const graph = await buildNetworkGraph(days);
    graphCache.set(days, {
      data: graph,
      expiresAt: Date.now() + GRAPH_TTL_MS,
    });
  }
  console.log(`[aggregation] Network graphs precomputed (30d, 90d, 365d)`);
}

async function buildNetworkGraph(rangeDays: number): Promise<NetworkGraphData> {
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);

  // Get developer-repo connections from recent activity
  const connections: Array<{
    author_login: string;
    repo_id: string;
    activity_count: bigint;
  }> = await prisma.$queryRaw`
    SELECT
      author_login,
      repo_id,
      COUNT(*) AS activity_count
    FROM activity_recent
    WHERE author_login IS NOT NULL
      AND event_date >= ${since}
    GROUP BY author_login, repo_id
    ORDER BY activity_count DESC
    LIMIT 5000
  `;

  // Also include historical data for longer ranges
  if (rangeDays > 7) {
    const histConnections: Array<{
      repo_id: string;
      owner: string;
      total_activity: bigint;
    }> = await prisma.$queryRaw`
      SELECT
        repo_id,
        split_part(repo_id, '/', 1) AS owner,
        SUM(commit_count + pr_opened + pr_merged + issues_opened) AS total_activity
      FROM activity_historical
      WHERE date >= ${since}
      GROUP BY repo_id
      ORDER BY total_activity DESC
      LIMIT 1000
    `;

    // Add repo nodes from historical data (even if no recent connections)
    for (const h of histConnections) {
      if (!connections.some((c) => c.repo_id === h.repo_id)) {
        connections.push({
          author_login: "_historical_",
          repo_id: h.repo_id,
          activity_count: h.total_activity,
        });
      }
    }
  }

  // Build nodes and edges
  const orgSet = new Map<string, number>(); // org → total activity
  const repoSet = new Map<string, number>();
  const devSet = new Map<string, number>();
  const edges: GraphEdge[] = [];

  for (const c of connections) {
    const [owner] = c.repo_id.split("/");
    const count = Number(c.activity_count);

    orgSet.set(owner, (orgSet.get(owner) ?? 0) + count);
    repoSet.set(c.repo_id, (repoSet.get(c.repo_id) ?? 0) + count);

    if (c.author_login !== "_historical_") {
      devSet.set(c.author_login, (devSet.get(c.author_login) ?? 0) + count);
      edges.push({
        source: `dev:${c.author_login}`,
        target: `repo:${c.repo_id}`,
        weight: count,
      });
    }
  }

  // Add repo→org edges
  for (const [repoId, activity] of repoSet) {
    const [owner] = repoId.split("/");
    edges.push({
      source: `repo:${repoId}`,
      target: `org:${owner}`,
      weight: activity,
    });
  }

  // Cap at 500 nodes total
  const MAX_NODES = 500;
  const allNodes: GraphNode[] = [];

  for (const [id, size] of orgSet) {
    allNodes.push({ id: `org:${id}`, type: "org", label: id, size });
  }
  for (const [id, size] of repoSet) {
    const label = id.split("/")[1];
    allNodes.push({ id: `repo:${id}`, type: "repo", label, size });
  }
  for (const [id, size] of devSet) {
    allNodes.push({ id: `dev:${id}`, type: "developer", label: id, size });
  }

  // Sort by size DESC and cap
  allNodes.sort((a, b) => b.size - a.size);
  const nodes = allNodes.slice(0, MAX_NODES);
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Filter edges to only include nodes in the set
  const filteredEdges = edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
  );

  // ─── Enrich nodes with metadata ──────────────────────────────────────────
  const repoIds = nodes.filter((n) => n.type === "repo").map((n) => n.id.replace("repo:", ""));
  const devLogins = nodes.filter((n) => n.type === "developer").map((n) => n.id.replace("dev:", ""));

  const repoMeta = repoIds.length
    ? await prisma.githubRepository.findMany({
        where: { id: { in: repoIds } },
        select: { id: true, language: true, stars: true, forks: true, description: true, lastActivityAt: true, syncTier: true, isArchived: true },
      })
    : [];
  const devProfileMeta = devLogins.length
    ? await prisma.githubDeveloper.findMany({
        where: { id: { in: devLogins } },
        select: { id: true, avatarUrl: true, lastSeenAt: true, isActive: true },
      })
    : [];
  const commitCounts: Array<{ repo_id: string; commit_count: bigint }> = repoIds.length
    ? await prisma.$queryRaw`
        SELECT repo_id, COUNT(*) AS commit_count
        FROM activity_recent
        WHERE repo_id = ANY(${repoIds})
          AND event_type = 'commit'
          AND event_date >= ${since}
        GROUP BY repo_id
      `
    : [];
  const devActivityStats: Array<{ author_login: string; commits: bigint; prs: bigint }> = devLogins.length
    ? await prisma.$queryRaw`
        SELECT
          author_login,
          SUM(CASE WHEN event_type = 'commit' THEN 1 ELSE 0 END) AS commits,
          SUM(CASE WHEN event_type IN ('pr_opened', 'pr_merged') THEN 1 ELSE 0 END) AS prs
        FROM activity_recent
        WHERE author_login = ANY(${devLogins})
          AND event_date >= ${since}
        GROUP BY author_login
      `
    : [];

  const repoMetaMap = new Map(repoMeta.map((r) => [r.id, r]));
  const devProfileMap = new Map(devProfileMeta.map((d) => [d.id, d]));
  const commitCountMap = new Map(commitCounts.map((c) => [c.repo_id, Number(c.commit_count)]));
  const devStatsMap = new Map(devActivityStats.map((d) => [d.author_login, { commits: Number(d.commits), prs: Number(d.prs) }]));

  // Compute per-dev repo and org counts from graph edges
  const devRepoSets = new Map<string, Set<string>>();
  const devOrgSets = new Map<string, Set<string>>();
  for (const edge of filteredEdges) {
    if (edge.source.startsWith("dev:") && edge.target.startsWith("repo:")) {
      const login = edge.source.replace("dev:", "");
      const repoId = edge.target.replace("repo:", "");
      const [owner] = repoId.split("/");
      if (!devRepoSets.has(login)) devRepoSets.set(login, new Set());
      if (!devOrgSets.has(login)) devOrgSets.set(login, new Set());
      devRepoSets.get(login)!.add(repoId);
      devOrgSets.get(login)!.add(owner);
    }
  }

  // Compute org-level commit totals
  const orgCommitCounts = new Map<string, number>();
  const orgRepoCounts = new Map<string, number>();
  for (const repoId of repoIds) {
    const [owner] = repoId.split("/");
    orgCommitCounts.set(owner, (orgCommitCounts.get(owner) ?? 0) + (commitCountMap.get(repoId) ?? 0));
    orgRepoCounts.set(owner, (orgRepoCounts.get(owner) ?? 0) + 1);
  }

  for (const node of nodes) {
    if (node.type === "repo") {
      const id = node.id.replace("repo:", "");
      const rm = repoMetaMap.get(id);
      if (rm) {
        node.meta = {
          language: rm.language ?? undefined,
          stars: rm.stars,
          forks: rm.forks,
          description: rm.description ?? undefined,
          lastActivityAt: rm.lastActivityAt?.toISOString(),
          syncTier: rm.syncTier,
          isArchived: rm.isArchived,
          commitCount: commitCountMap.get(id) ?? 0,
        };
      }
    } else if (node.type === "developer") {
      const login = node.id.replace("dev:", "");
      const profile = devProfileMap.get(login);
      const stats = devStatsMap.get(login);
      const repoCount = devRepoSets.get(login)?.size ?? 0;
      const orgCount = devOrgSets.get(login)?.size ?? 0;
      node.meta = {
        avatarUrl: profile?.avatarUrl ?? undefined,
        totalCommits: stats?.commits ?? 0,
        totalPRs: stats?.prs ?? 0,
        lastSeenAt: profile?.lastSeenAt?.toISOString(),
        isActive: profile?.isActive ?? true,
        repoCount,
        orgCount,
        isBridge: orgCount >= 2,
      };
    } else if (node.type === "org") {
      const id = node.id.replace("org:", "");
      node.meta = {
        repoCount: orgRepoCounts.get(id) ?? 0,
        commitCount: orgCommitCounts.get(id) ?? 0,
      };
    }
  }

  return {
    nodes,
    edges: filteredEdges,
    generatedAt: new Date().toISOString(),
    rangeDays,
  };
}
