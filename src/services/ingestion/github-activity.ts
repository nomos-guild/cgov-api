import type { GithubRepository } from "@prisma/client";
import { prisma } from "../prisma";
import { githubGraphQL, buildBatchRepoQuery, getRateLimitState } from "../github-graphql";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SyncResult {
  total: number;
  success: number;
  failed: number;
  eventsCreated: number;
  developersUpserted: number;
  snapshotsTaken: number;
  errors: Array<{ repo: string; error: string }>;
}

interface CommitNode {
  oid: string;
  message: string;
  committedDate: string;
  additions: number;
  deletions: number;
  author: { user: { login: string; avatarUrl: string } | null } | null;
}

interface PRNode {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  author: { login: string; avatarUrl: string } | null;
}

interface IssueNode {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  closedAt: string | null;
  author: { login: string; avatarUrl: string } | null;
}

interface ReleaseNode {
  tagName: string;
  name: string | null;
  createdAt: string;
  author: { login: string; avatarUrl: string } | null;
}

interface RepoActivityData {
  defaultBranchRef: {
    target: {
      history: {
        nodes: CommitNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  } | null;
  pullRequests: { nodes: PRNode[] };
  recentIssues: { nodes: IssueNode[] };
  releases: { nodes: ReleaseNode[] };
  stargazerCount: number;
  forkCount: number;
  openIssueCount: { totalCount: number };
  watchers: { totalCount: number };
}

// ─── Configuration ───────────────────────────────────────────────────────────

const BATCH_SIZE = 5;
const RECENT_WINDOW_DAYS = 7;

// ─── Sync Entry Points ──────────────────────────────────────────────────────

export async function syncActiveRepos(): Promise<SyncResult> {
  const repos = await prisma.githubRepository.findMany({
    where: { syncTier: "active", isActive: true },
    orderBy: { lastSyncedAt: "asc" },
  });
  console.log(`[sync] Syncing ${repos.length} active repos`);
  return syncRepos(repos);
}

export async function syncModerateRepos(): Promise<SyncResult> {
  const repos = await prisma.githubRepository.findMany({
    where: { syncTier: "moderate", isActive: true },
    orderBy: { lastSyncedAt: "asc" },
  });
  console.log(`[sync] Syncing ${repos.length} moderate repos`);
  return syncRepos(repos);
}

export async function syncDormantRepos(): Promise<SyncResult> {
  const repos = await prisma.githubRepository.findMany({
    where: { syncTier: "dormant", isActive: true },
    orderBy: { lastSyncedAt: "asc" },
  });
  console.log(`[sync] Syncing ${repos.length} dormant repos`);
  return syncRepos(repos);
}

// ─── Core Sync ───────────────────────────────────────────────────────────────

async function syncRepos(repos: GithubRepository[]): Promise<SyncResult> {
  const result: SyncResult = {
    total: repos.length,
    success: 0,
    failed: 0,
    eventsCreated: 0,
    developersUpserted: 0,
    snapshotsTaken: 0,
    errors: [],
  };

  if (repos.length === 0) return result;

  const since = new Date(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    try {
      await syncBatch(batch, since, today, result);
    } catch (error: any) {
      console.error(`[sync] Batch ${i / BATCH_SIZE} failed:`, error.message);
      for (const repo of batch) {
        result.failed++;
        result.errors.push({ repo: repo.id, error: error.message });
      }
    }
  }

  console.log(
    `[sync] Complete: ${result.success}/${result.total} repos, ` +
      `${result.eventsCreated} events, ${result.developersUpserted} devs, ` +
      `${result.snapshotsTaken} snapshots (rate limit: ${getRateLimitState().remaining})`
  );
  return result;
}

async function syncBatch(
  batch: GithubRepository[],
  since: string,
  today: Date,
  result: SyncResult
): Promise<void> {
  const fragment = buildActivityFragment(since);
  const query = buildBatchRepoQuery(
    batch.map((r) => ({ owner: r.owner, name: r.name })),
    fragment
  );

  const data = await githubGraphQL<Record<string, RepoActivityData>>(query);
  const allAuthors = new Map<string, string | null>(); // login -> avatarUrl
  const allEvents: Array<{ repoId: string; eventType: string; authorLogin: string | null; eventDate: Date }> = [];

  for (let j = 0; j < batch.length; j++) {
    const repo = batch[j];
    const repoData = data[`repo${j}`];

    if (!repoData) {
      result.failed++;
      result.errors.push({ repo: repo.id, error: "No data returned" });
      continue;
    }

    try {
      const events = extractEvents(repo.id, repoData, since);
      allEvents.push(...events);
      const authors = collectAuthors(repoData);

      // Upsert events (skipDuplicates handles idempotency)
      if (events.length > 0) {
        const created = await prisma.activityRecent.createMany({
          data: events,
          skipDuplicates: true,
        });
        result.eventsCreated += created.count;
      }

      // Track authors for batch developer upsert
      for (const [login, avatar] of authors) {
        allAuthors.set(login, avatar);
      }

      // Daily snapshot (one per repo per day)
      await prisma.repoDailySnapshot.upsert({
        where: {
          repoId_date: { repoId: repo.id, date: today },
        },
        create: {
          repoId: repo.id,
          date: today,
          stars: repoData.stargazerCount,
          forks: repoData.forkCount,
          openIssues: repoData.openIssueCount.totalCount,
          watchers: repoData.watchers.totalCount,
        },
        update: {
          stars: repoData.stargazerCount,
          forks: repoData.forkCount,
          openIssues: repoData.openIssueCount.totalCount,
          watchers: repoData.watchers.totalCount,
        },
      });
      result.snapshotsTaken++;

      // Update repo metadata
      const latestEventDate = events.length > 0
        ? new Date(Math.max(...events.map((e) => e.eventDate.getTime())))
        : null;

      await prisma.githubRepository.update({
        where: { id: repo.id },
        data: {
          lastSyncedAt: new Date(),
          stars: repoData.stargazerCount,
          forks: repoData.forkCount,
          ...(latestEventDate && { lastActivityAt: latestEventDate }),
        },
      });

      result.success++;
    } catch (error: any) {
      result.failed++;
      result.errors.push({ repo: repo.id, error: error.message });
    }
  }

  // Batch upsert developers, then update per-repo activity stats
  await upsertDevelopers(allAuthors);
  result.developersUpserted += allAuthors.size;
  await updateDeveloperRepoStats(allEvents);
}

async function updateDeveloperRepoStats(
  events: Array<{ repoId: string; eventType: string; authorLogin: string | null; eventDate: Date }>
): Promise<void> {
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
    const repoId = repoParts.join(":");
    try {
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
    } catch {
      // Developer may not exist yet (race condition with upsertDevelopers)
    }
  }
}

// ─── Event Extraction ────────────────────────────────────────────────────────

function extractEvents(
  repoId: string,
  data: RepoActivityData,
  since: string
): Array<{
  repoId: string;
  eventType: string;
  eventId: string;
  title: string | null;
  authorLogin: string | null;
  additions: number | null;
  deletions: number | null;
  eventDate: Date;
}> {
  const sinceDate = new Date(since);
  const events: ReturnType<typeof extractEvents> = [];

  // Commits
  const commits = data.defaultBranchRef?.target?.history?.nodes ?? [];
  for (const c of commits) {
    const firstLine = c.message?.split("\n")[0]?.slice(0, 255) ?? null;
    events.push({
      repoId,
      eventType: "commit",
      eventId: c.oid.slice(0, 12),
      title: firstLine,
      authorLogin: c.author?.user?.login ?? null,
      additions: c.additions,
      deletions: c.deletions,
      eventDate: new Date(c.committedDate),
    });
  }

  // PRs (filter to recent window)
  for (const pr of data.pullRequests.nodes) {
    const createdAt = new Date(pr.createdAt);
    if (createdAt >= sinceDate) {
      events.push({
        repoId,
        eventType: "pr_opened",
        eventId: String(pr.number),
        title: pr.title,
        authorLogin: pr.author?.login ?? null,
        additions: pr.additions,
        deletions: pr.deletions,
        eventDate: createdAt,
      });
    }

    if (pr.state === "MERGED" && pr.mergedAt) {
      const mergedAt = new Date(pr.mergedAt);
      if (mergedAt >= sinceDate) {
        events.push({
          repoId,
          eventType: "pr_merged",
          eventId: String(pr.number),
          title: pr.title,
          authorLogin: pr.author?.login ?? null,
          additions: pr.additions,
          deletions: pr.deletions,
          eventDate: mergedAt,
        });
      }
    }

    if (pr.state === "CLOSED" && !pr.mergedAt && pr.closedAt) {
      const closedAt = new Date(pr.closedAt);
      if (closedAt >= sinceDate) {
        events.push({
          repoId,
          eventType: "pr_closed",
          eventId: String(pr.number),
          title: pr.title,
          authorLogin: pr.author?.login ?? null,
          additions: null,
          deletions: null,
          eventDate: closedAt,
        });
      }
    }
  }

  // Issues (filter to recent window)
  for (const issue of data.recentIssues.nodes) {
    const createdAt = new Date(issue.createdAt);
    if (createdAt >= sinceDate) {
      events.push({
        repoId,
        eventType: "issue_opened",
        eventId: String(issue.number),
        title: issue.title,
        authorLogin: issue.author?.login ?? null,
        additions: null,
        deletions: null,
        eventDate: createdAt,
      });
    }

    if (issue.state === "CLOSED" && issue.closedAt) {
      const closedAt = new Date(issue.closedAt);
      if (closedAt >= sinceDate) {
        events.push({
          repoId,
          eventType: "issue_closed",
          eventId: String(issue.number),
          title: issue.title,
          authorLogin: issue.author?.login ?? null,
          additions: null,
          deletions: null,
          eventDate: closedAt,
        });
      }
    }
  }

  // Releases
  for (const rel of data.releases?.nodes ?? []) {
    const createdAt = new Date(rel.createdAt);
    if (createdAt >= sinceDate) {
      events.push({
        repoId,
        eventType: "release",
        eventId: rel.tagName,
        title: rel.name || rel.tagName,
        authorLogin: rel.author?.login ?? null,
        additions: null,
        deletions: null,
        eventDate: createdAt,
      });
    }
  }

  return events;
}

// ─── Developer Upsert ────────────────────────────────────────────────────────

function collectAuthors(
  data: RepoActivityData
): Map<string, string | null> {
  const authors = new Map<string, string | null>();

  for (const c of data.defaultBranchRef?.target?.history?.nodes ?? []) {
    const user = c.author?.user;
    if (user?.login) authors.set(user.login, user.avatarUrl ?? null);
  }
  for (const pr of data.pullRequests.nodes) {
    if (pr.author?.login)
      authors.set(pr.author.login, pr.author.avatarUrl ?? null);
  }
  for (const issue of data.recentIssues.nodes) {
    if (issue.author?.login)
      authors.set(issue.author.login, issue.author.avatarUrl ?? null);
  }
  for (const rel of data.releases?.nodes ?? []) {
    if (rel.author?.login)
      authors.set(rel.author.login, rel.author.avatarUrl ?? null);
  }

  return authors;
}

async function upsertDevelopers(
  authors: Map<string, string | null>
): Promise<void> {
  const now = new Date();
  for (const [login, avatarUrl] of authors) {
    try {
      await prisma.githubDeveloper.upsert({
        where: { id: login },
        create: {
          id: login,
          avatarUrl,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        update: {
          avatarUrl,
          lastSeenAt: now,
        },
      });
    } catch {
      // Non-critical — log and continue
    }
  }
}

// ─── Re-Tiering ──────────────────────────────────────────────────────────────

export async function reTierRepos(): Promise<{
  promoted: number;
  demoted: number;
}> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Promote to active: activity in last 7 days
  const promoted = await prisma.githubRepository.updateMany({
    where: {
      isActive: true,
      syncTier: { not: "active" },
      lastActivityAt: { gte: sevenDaysAgo },
    },
    data: { syncTier: "active" },
  });

  // Demote active → moderate: no activity in 7 days but within 90
  const toModerate = await prisma.githubRepository.updateMany({
    where: {
      isActive: true,
      syncTier: "active",
      OR: [
        { lastActivityAt: { lt: sevenDaysAgo, gte: ninetyDaysAgo } },
        { lastActivityAt: null },
      ],
    },
    data: { syncTier: "moderate" },
  });

  // Demote moderate → dormant: no activity in 90+ days
  const toDormant = await prisma.githubRepository.updateMany({
    where: {
      isActive: true,
      syncTier: "moderate",
      OR: [
        { lastActivityAt: { lt: ninetyDaysAgo } },
        { lastActivityAt: null },
      ],
    },
    data: { syncTier: "dormant" },
  });

  const stats = {
    promoted: promoted.count,
    demoted: toModerate.count + toDormant.count,
  };

  console.log(
    `[re-tier] ${stats.promoted} promoted to active, ` +
      `${toModerate.count} → moderate, ${toDormant.count} → dormant`
  );
  return stats;
}

// ─── Daily Snapshot (lightweight, all repos) ─────────────────────────────────

const SNAPSHOT_BATCH_SIZE = 50;

export interface SnapshotResult {
  total: number;
  success: number;
  failed: number;
  errors: Array<{ repo: string; error: string }>;
}

export async function snapshotAllRepos(): Promise<SnapshotResult> {
  const repos = await prisma.githubRepository.findMany({
    where: { isActive: true },
    select: { id: true, owner: true, name: true },
    orderBy: { lastSyncedAt: "asc" },
  });

  const result: SnapshotResult = { total: repos.length, success: 0, failed: 0, errors: [] };
  if (repos.length === 0) return result;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const fragment = `stargazerCount\n    forkCount\n    openIssueCount: issues(states: [OPEN]) { totalCount }\n    watchers { totalCount }`;

  for (let i = 0; i < repos.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = repos.slice(i, i + SNAPSHOT_BATCH_SIZE);

    try {
      const query = buildBatchRepoQuery(
        batch.map((r) => ({ owner: r.owner, name: r.name })),
        fragment
      );

      const data = await githubGraphQL<Record<string, {
        stargazerCount: number;
        forkCount: number;
        openIssueCount: { totalCount: number };
        watchers: { totalCount: number };
      }>>(query);

      for (let j = 0; j < batch.length; j++) {
        const repo = batch[j];
        const repoData = data[`repo${j}`];

        if (!repoData) {
          result.failed++;
          result.errors.push({ repo: `${repo.owner}/${repo.name}`, error: "No data returned" });
          continue;
        }

        try {
          await prisma.repoDailySnapshot.upsert({
            where: { repoId_date: { repoId: repo.id, date: today } },
            create: {
              repoId: repo.id,
              date: today,
              stars: repoData.stargazerCount,
              forks: repoData.forkCount,
              openIssues: repoData.openIssueCount.totalCount,
              watchers: repoData.watchers.totalCount,
            },
            update: {
              stars: repoData.stargazerCount,
              forks: repoData.forkCount,
              openIssues: repoData.openIssueCount.totalCount,
              watchers: repoData.watchers.totalCount,
            },
          });

          await prisma.githubRepository.update({
            where: { id: repo.id },
            data: {
              stars: repoData.stargazerCount,
              forks: repoData.forkCount,
            },
          });

          result.success++;
        } catch (error: any) {
          result.failed++;
          result.errors.push({ repo: `${repo.owner}/${repo.name}`, error: error.message });
        }
      }
    } catch (error: any) {
      for (const repo of batch) {
        result.failed++;
        result.errors.push({ repo: `${repo.owner}/${repo.name}`, error: error.message });
      }
    }
  }

  console.log(
    `[snapshot] Complete: ${result.success}/${result.total} repos ` +
      `(rate limit: ${getRateLimitState().remaining})`
  );
  return result;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export async function purgeOldRecentActivity(): Promise<number> {
  const cutoff = new Date(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const deleted = await prisma.activityRecent.deleteMany({
    where: { eventDate: { lt: cutoff } },
  });
  console.log(`[cleanup] Purged ${deleted.count} old activity_recent rows`);
  return deleted.count;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildActivityFragment(since: string): string {
  return `defaultBranchRef {
      target {
        ... on Commit {
          history(since: "${since}", first: 100) {
            nodes {
              oid
              message
              committedDate
              additions
              deletions
              author { user { login avatarUrl } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
    pullRequests(last: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        createdAt
        mergedAt
        closedAt
        additions
        deletions
        author { login avatarUrl }
      }
    }
    recentIssues: issues(last: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        createdAt
        closedAt
        author { login avatarUrl }
      }
    }
    releases(last: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        tagName
        name
        createdAt
        author { login avatarUrl }
      }
    }
    stargazerCount
    forkCount
    openIssueCount: issues(states: [OPEN]) { totalCount }
    watchers { totalCount }`;
}
