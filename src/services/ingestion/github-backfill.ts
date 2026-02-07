import type { GithubRepository } from "@prisma/client";
import { prisma } from "../prisma";
import { githubGraphQL, getRateLimitState } from "../github-graphql";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BackfillResult {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  errors: Array<{ repo: string; error: string }>;
}

export interface BackfillOptions {
  limit?: number; // max repos to process in one run
  minStars?: number; // only backfill repos with >= this many stars
  minRateLimit?: number; // stop if rate limit drops below this
}

interface DailyBucket {
  commitCount: number;
  prOpened: number;
  prMerged: number;
  prClosed: number;
  issuesOpened: number;
  issuesClosed: number;
  additions: number;
  deletions: number;
  contributors: Set<string>;
  prMergeHours: number[];
  issueResolutionHours: number[];
  releasesPublished: number;
}

// ─── GraphQL Queries ─────────────────────────────────────────────────────────

const COMMITS_QUERY = `
  query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(since: $since, first: 100, after: $after) {
              nodes {
                oid
                committedDate
                additions
                deletions
                author { user { login } }
              }
              pageInfo { hasNextPage endCursor }
              totalCount
            }
          }
        }
      }
    }
  }
`;

const PRS_QUERY = `
  query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 100, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
        nodes {
          number
          createdAt
          mergedAt
          closedAt
          state
          author { login }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const ISSUES_QUERY = `
  query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
        nodes {
          number
          createdAt
          closedAt
          state
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const RELEASES_QUERY = `
  query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      releases(first: 100, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
        nodes { publishedAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// ─── Entry Point ─────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<BackfillOptions> = {
  limit: 50,
  minStars: 0,
  minRateLimit: 200,
};

export async function backfillRepositories(
  opts?: BackfillOptions
): Promise<BackfillResult> {
  const options = { ...DEFAULT_OPTIONS, ...opts };

  const repos = await prisma.githubRepository.findMany({
    where: {
      backfilledAt: null,
      isActive: true,
      stars: { gte: options.minStars },
    },
    orderBy: { stars: "desc" },
    take: options.limit,
  });

  const result: BackfillResult = {
    total: repos.length,
    success: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  console.log(
    `[backfill] Starting: ${repos.length} repos (minStars=${options.minStars}, limit=${options.limit})`
  );

  for (const repo of repos) {
    const rl = getRateLimitState();
    if (rl.remaining < options.minRateLimit) {
      console.warn(
        `[backfill] Rate limit low (${rl.remaining}). Stopping. ` +
          `Completed ${result.success}/${result.total}.`
      );
      result.skipped = result.total - result.success - result.failed;
      break;
    }

    try {
      await backfillRepo(repo);
      result.success++;
      console.log(
        `[backfill] ${repo.id}: done (${result.success}/${result.total}, rl=${getRateLimitState().remaining})`
      );
    } catch (error: any) {
      result.failed++;
      result.errors.push({ repo: repo.id, error: error.message });
      console.error(`[backfill] ${repo.id}: failed — ${error.message}`);
    }
  }

  console.log(
    `[backfill] Complete: ${result.success} ok, ${result.failed} failed, ${result.skipped} skipped`
  );
  return result;
}

// ─── Per-Repo Backfill ───────────────────────────────────────────────────────

async function backfillRepo(repo: GithubRepository): Promise<void> {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 5);
  const sinceISO = since.toISOString();

  const buckets = new Map<string, DailyBucket>();
  // Track per-developer stats: login → { commits, prs, lastActiveAt }
  const devStats = new Map<string, { commits: number; prs: number; lastActiveAt: Date }>();

  // Fetch commits
  await paginateCommits(repo, sinceISO, buckets, devStats);

  // Fetch PRs (also tracks developer PR counts)
  await paginatePRs(repo, since, buckets, devStats);

  // Fetch issues
  await paginateIssues(repo, since, buckets);

  // Fetch releases
  await paginateReleases(repo, since, buckets);

  // Upsert into activity_historical
  const entries = Array.from(buckets.entries()).map(([dateStr, b]) => ({
    repoId: repo.id,
    date: new Date(dateStr),
    commitCount: b.commitCount,
    prOpened: b.prOpened,
    prMerged: b.prMerged,
    prClosed: b.prClosed,
    issuesOpened: b.issuesOpened,
    issuesClosed: b.issuesClosed,
    additions: b.additions,
    deletions: b.deletions,
    uniqueContributors: b.contributors.size,
    avgPrMergeHours:
      b.prMergeHours.length > 0
        ? b.prMergeHours.reduce((a, b) => a + b, 0) / b.prMergeHours.length
        : null,
    avgIssueResolutionHours:
      b.issueResolutionHours.length > 0
        ? b.issueResolutionHours.reduce((a, b) => a + b, 0) / b.issueResolutionHours.length
        : null,
    releasesPublished: b.releasesPublished,
  }));

  if (entries.length > 0) {
    await prisma.activityHistorical.createMany({
      data: entries,
      skipDuplicates: true,
    });
  }

  // Upsert developer_repo_activity for all-time tracking
  for (const [login, stats] of devStats) {
    // Ensure developer exists first
    await prisma.githubDeveloper.upsert({
      where: { id: login },
      create: { id: login, firstSeenAt: stats.lastActiveAt, lastSeenAt: stats.lastActiveAt },
      update: { lastSeenAt: stats.lastActiveAt },
    });

    await prisma.developerRepoActivity.upsert({
      where: { developerLogin_repoId: { developerLogin: login, repoId: repo.id } },
      create: {
        developerLogin: login,
        repoId: repo.id,
        totalCommits: stats.commits,
        totalPRs: stats.prs,
        lastActiveAt: stats.lastActiveAt,
      },
      update: {
        totalCommits: stats.commits,
        totalPRs: stats.prs,
        lastActiveAt: stats.lastActiveAt,
      },
    });
  }

  // Mark as backfilled
  await prisma.githubRepository.update({
    where: { id: repo.id },
    data: { backfilledAt: new Date() },
  });
}

// ─── Pagination Helpers ──────────────────────────────────────────────────────

function getBucket(buckets: Map<string, DailyBucket>, date: Date): DailyBucket {
  const key = date.toISOString().slice(0, 10); // YYYY-MM-DD
  let b = buckets.get(key);
  if (!b) {
    b = {
      commitCount: 0,
      prOpened: 0,
      prMerged: 0,
      prClosed: 0,
      issuesOpened: 0,
      issuesClosed: 0,
      additions: 0,
      deletions: 0,
      contributors: new Set(),
      prMergeHours: [],
      issueResolutionHours: [],
      releasesPublished: 0,
    };
    buckets.set(key, b);
  }
  return b;
}

type DevStatsMap = Map<string, { commits: number; prs: number; lastActiveAt: Date }>;

function trackDev(devStats: DevStatsMap, login: string, date: Date, type: "commit" | "pr"): void {
  let s = devStats.get(login);
  if (!s) {
    s = { commits: 0, prs: 0, lastActiveAt: date };
    devStats.set(login, s);
  }
  if (type === "commit") s.commits++;
  else s.prs++;
  if (date > s.lastActiveAt) s.lastActiveAt = date;
}

async function paginateCommits(
  repo: GithubRepository,
  sinceISO: string,
  buckets: Map<string, DailyBucket>,
  devStats: DevStatsMap
): Promise<void> {
  let cursor: string | null = null;

  while (true) {
    const data = await githubGraphQL<{
      repository: {
        defaultBranchRef: {
          target: {
            history: {
              nodes: Array<{
                oid: string;
                committedDate: string;
                additions: number;
                deletions: number;
                author: { user: { login: string } | null } | null;
              }>;
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        } | null;
      };
    }>(COMMITS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      since: sinceISO,
      after: cursor,
    });

    const history = data.repository.defaultBranchRef?.target?.history;
    if (!history || history.nodes.length === 0) break;

    for (const c of history.nodes) {
      const date = new Date(c.committedDate);
      const b = getBucket(buckets, date);
      b.commitCount++;
      b.additions += c.additions;
      b.deletions += c.deletions;
      const login = c.author?.user?.login;
      if (login) {
        b.contributors.add(login);
        trackDev(devStats, login, date, "commit");
      }
    }

    if (!history.pageInfo.hasNextPage) break;
    cursor = history.pageInfo.endCursor;
  }
}

async function paginatePRs(
  repo: GithubRepository,
  since: Date,
  buckets: Map<string, DailyBucket>,
  devStats: DevStatsMap
): Promise<void> {
  let cursor: string | null = null;

  while (true) {
    const data = await githubGraphQL<{
      repository: {
        pullRequests: {
          nodes: Array<{
            number: number;
            createdAt: string;
            mergedAt: string | null;
            closedAt: string | null;
            state: string;
            author: { login: string } | null;
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    }>(PRS_QUERY, { owner: repo.owner, name: repo.name, after: cursor });

    const prs = data.repository.pullRequests;
    if (prs.nodes.length === 0) break;

    for (const pr of prs.nodes) {
      const createdAt = new Date(pr.createdAt);
      if (createdAt >= since) {
        getBucket(buckets, createdAt).prOpened++;
        if (pr.author?.login) {
          trackDev(devStats, pr.author.login, createdAt, "pr");
        }
      }

      if (pr.state === "MERGED" && pr.mergedAt) {
        const mergedAt = new Date(pr.mergedAt);
        if (mergedAt >= since) {
          const b = getBucket(buckets, mergedAt);
          b.prMerged++;
          const hours =
            (mergedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
          if (hours >= 0) b.prMergeHours.push(hours);
        }
      }

      if (pr.state === "CLOSED" && !pr.mergedAt && pr.closedAt) {
        const closedAt = new Date(pr.closedAt);
        if (closedAt >= since) {
          getBucket(buckets, closedAt).prClosed++;
        }
      }
    }

    if (!prs.pageInfo.hasNextPage) break;
    cursor = prs.pageInfo.endCursor;
  }
}

async function paginateIssues(
  repo: GithubRepository,
  since: Date,
  buckets: Map<string, DailyBucket>
): Promise<void> {
  let cursor: string | null = null;

  while (true) {
    const data = await githubGraphQL<{
      repository: {
        issues: {
          nodes: Array<{
            number: number;
            createdAt: string;
            closedAt: string | null;
            state: string;
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    }>(ISSUES_QUERY, { owner: repo.owner, name: repo.name, after: cursor });

    const issues = data.repository.issues;
    if (issues.nodes.length === 0) break;

    // Stop early if we're past our date range (sorted ASC by createdAt)
    const oldestInPage = new Date(issues.nodes[0].createdAt);
    if (oldestInPage < since && issues.nodes.every((i) => new Date(i.createdAt) < since && (!i.closedAt || new Date(i.closedAt) < since))) {
      // All items in this page are before our window — but we still need to
      // continue because closedAt dates can be within range
    }

    for (const issue of issues.nodes) {
      const createdAt = new Date(issue.createdAt);
      if (createdAt >= since) {
        getBucket(buckets, createdAt).issuesOpened++;
      }

      if (issue.state === "CLOSED" && issue.closedAt) {
        const closedAt = new Date(issue.closedAt);
        if (closedAt >= since) {
          const b = getBucket(buckets, closedAt);
          b.issuesClosed++;
          const hours = (closedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
          if (hours >= 0) b.issueResolutionHours.push(hours);
        }
      }
    }

    if (!issues.pageInfo.hasNextPage) break;
    cursor = issues.pageInfo.endCursor;
  }
}

async function paginateReleases(
  repo: GithubRepository,
  since: Date,
  buckets: Map<string, DailyBucket>
): Promise<void> {
  let cursor: string | null = null;

  while (true) {
    const data = await githubGraphQL<{
      repository: {
        releases: {
          nodes: Array<{ publishedAt: string | null }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    }>(RELEASES_QUERY, { owner: repo.owner, name: repo.name, after: cursor });

    const releases = data.repository.releases;
    if (releases.nodes.length === 0) break;

    for (const r of releases.nodes) {
      if (!r.publishedAt) continue;
      const pubDate = new Date(r.publishedAt);
      if (pubDate >= since) {
        getBucket(buckets, pubDate).releasesPublished++;
      }
    }

    if (!releases.pageInfo.hasNextPage) break;
    cursor = releases.pageInfo.endCursor;
  }
}
