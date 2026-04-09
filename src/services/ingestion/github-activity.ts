import { Prisma, type GithubRepository } from "@prisma/client";
import { createHash } from "crypto";
import { prisma } from "../prisma";
import {
  githubGraphQL,
  buildBatchRepoQuery,
  getRateLimitState,
} from "../github-graphql";
import {
  recordDbFailureForFailFast,
  shouldFailFastForDb,
} from "./dbFailFast";
import {
  getUnresolvedRepoNamesFromGraphQLError,
  unresolvedRepoDisableThreshold,
} from "./github-unresolved";
import { incrementGithubRepoHealthCounter } from "./githubSharedCoordination";
import {
  type IngestionDbClient,
  withIngestionDbRead,
  withIngestionDbWrite,
} from "./dbSession";

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
const DB_BATCH_SIZE = 200;
const batchedGithubActivityWritesEnabled =
  process.env.GITHUB_ACTIVITY_BATCHED_DB_WRITES_ENABLED !== "false";

interface RepoHealthSummary {
  unresolvedSeen: number;
  reposDeactivated: number;
  transientBatchFailures: number;
}

interface RepoRef {
  id: string;
  owner: string;
  name: string;
}

interface ActivityEvent {
  repoId: string;
  eventType: string;
  eventId: string;
  title: string | null;
  authorLogin: string | null;
  additions: number | null;
  deletions: number | null;
  eventDate: Date;
}

interface InsertedActivityEvent {
  repoId: string;
  eventType: string;
  authorLogin: string | null;
  eventDate: Date;
}

interface PreparedActivityEvent extends ActivityEvent {
  id: string;
}

// ─── Sync Entry Points ──────────────────────────────────────────────────────

export async function syncActiveRepos(
  db: IngestionDbClient = prisma
): Promise<SyncResult> {
  const repos = await withIngestionDbRead(db, "github-activity.find-active-repos", () =>
    db.githubRepository.findMany({
      where: { syncTier: "active", isActive: true },
      orderBy: { lastSyncedAt: "asc" },
    })
  );
  console.log(`[sync] Syncing ${repos.length} active repos`);
  return syncRepos(db, repos);
}

export async function syncModerateRepos(
  db: IngestionDbClient = prisma
): Promise<SyncResult> {
  const repos = await withIngestionDbRead(
    db,
    "github-activity.find-moderate-repos",
    () =>
      db.githubRepository.findMany({
        where: { syncTier: "moderate", isActive: true },
        orderBy: { lastSyncedAt: "asc" },
      })
  );
  console.log(`[sync] Syncing ${repos.length} moderate repos`);
  return syncRepos(db, repos);
}

export async function syncDormantRepos(
  db: IngestionDbClient = prisma
): Promise<SyncResult> {
  const repos = await withIngestionDbRead(db, "github-activity.find-dormant-repos", () =>
    db.githubRepository.findMany({
      where: { syncTier: "dormant", isActive: true },
      orderBy: { lastSyncedAt: "asc" },
    })
  );
  console.log(`[sync] Syncing ${repos.length} dormant repos`);
  return syncRepos(db, repos);
}

// ─── Core Sync ───────────────────────────────────────────────────────────────

async function syncRepos(
  db: IngestionDbClient,
  repos: GithubRepository[]
): Promise<SyncResult> {
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
  if (shouldFailFastForDb("ingestion.github-activity.sync-repos")) {
    result.failed = repos.length;
    result.errors.push({
      repo: "all",
      error: "DB fail-fast active; skipping github activity sync",
    });
    return result;
  }

  const since = new Date(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const healthSummary: RepoHealthSummary = {
    unresolvedSeen: 0,
    reposDeactivated: 0,
    transientBatchFailures: 0,
  };

  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    try {
      await syncBatch(db, batch, since, today, result, healthSummary);
    } catch (error: any) {
      recordDbFailureForFailFast(error, "ingestion.github-activity.sync-batch");
      healthSummary.transientBatchFailures += 1;
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
  console.log(
    `[github-repo-health] scope=ingestion.github-activity.sync-repos unresolvedSeen=${healthSummary.unresolvedSeen} reposDeactivated=${healthSummary.reposDeactivated} transientBatchFailures=${healthSummary.transientBatchFailures}`
  );
  return result;
}

async function syncBatch(
  db: IngestionDbClient,
  batch: GithubRepository[],
  since: string,
  today: Date,
  result: SyncResult,
  healthSummary: RepoHealthSummary
): Promise<void> {
  const { batch: filteredBatch, data } =
    await fetchBatchDataWithUnresolvedHandling<RepoActivityData>(
      batch,
      buildActivityFragment(since),
      result,
      healthSummary,
      "ingestion.github-activity.sync-batch-item",
      db
    );
  if (filteredBatch.length === 0) return;

  const allAuthors = new Map<string, string | null>(); // login -> avatarUrl
  const insertedEventsForStats: InsertedActivityEvent[] = [];

  for (let j = 0; j < filteredBatch.length; j++) {
    const repo = filteredBatch[j];
    const repoData = data[`repo${j}`];

    if (!repoData) {
      result.failed++;
      result.errors.push({ repo: repo.id, error: "No data returned" });
      continue;
    }

    try {
      if (shouldFailFastForDb("ingestion.github-activity.sync-batch-item")) {
        throw new Error("DB fail-fast active; skipping github repository batch");
      }
      const events = extractEvents(repo.id, repoData, since);
      const authors = collectAuthors(repoData);

      // Insert events and only use newly inserted rows for stats increments.
      const insertedEvents = await insertRecentEventsReturningInserted(db, events);
      result.eventsCreated += insertedEvents.length;
      insertedEventsForStats.push(...insertedEvents);

      // Track authors for batch developer upsert
      for (const [login, avatar] of authors) {
        allAuthors.set(login, avatar);
      }

      // Daily snapshot (one per repo per day)
      await withIngestionDbWrite(db, "github-activity.upsert-daily-snapshot", () =>
        db.repoDailySnapshot.upsert({
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
        })
      );
      result.snapshotsTaken++;

      // Update repo metadata
      const latestEventDate = events.length > 0
        ? new Date(Math.max(...events.map((e) => e.eventDate.getTime())))
        : null;

      await withIngestionDbWrite(db, "github-activity.update-repo-metadata", () =>
        db.githubRepository.update({
          where: { id: repo.id },
          data: {
            lastSyncedAt: new Date(),
            stars: repoData.stargazerCount,
            forks: repoData.forkCount,
            ...(latestEventDate && { lastActivityAt: latestEventDate }),
          },
        })
      );

      result.success++;
    } catch (error: any) {
      recordDbFailureForFailFast(error, "ingestion.github-activity.sync-batch-item");
      result.failed++;
      result.errors.push({ repo: repo.id, error: error.message });
    }
  }

  // Batch upsert developers, then update per-repo activity stats
  await upsertDevelopers(db, allAuthors);
  result.developersUpserted += allAuthors.size;
  await updateDeveloperRepoStats(db, insertedEventsForStats);
}

async function insertRecentEventsReturningInserted(
  db: IngestionDbClient,
  events: ActivityEvent[]
): Promise<InsertedActivityEvent[]> {
  if (events.length === 0) return [];
  const inserted: InsertedActivityEvent[] = [];

  for (let i = 0; i < events.length; i += DB_BATCH_SIZE) {
    const chunk = events.slice(i, i + DB_BATCH_SIZE);
    const preparedChunk = chunk.map((event) => ({
      ...event,
      id: buildActivityRecentId(event),
    }));
    let rows: Array<{
      repo_id: string;
      event_type: string;
      author_login: string | null;
      event_date: Date;
    }> = [];
    try {
      const values = Prisma.join(
        preparedChunk.map((event) =>
          Prisma.sql`(${event.id}, ${event.repoId}, ${event.eventType}, ${event.eventId}, ${event.title}, ${event.authorLogin}, ${sqlNullableInt32(
            event.additions
          )}, ${sqlNullableInt32(event.deletions)}, ${event.eventDate})`
        )
      );
      rows = await withIngestionDbWrite(
        db,
        "github-activity.insert-recent-events-returning",
        () =>
          db.$queryRaw<
            Array<{
              repo_id: string;
              event_type: string;
              author_login: string | null;
              event_date: Date;
            }>
          >`
            WITH incoming(
              "id",
              "repo_id",
              "event_type",
              "event_id",
              "title",
              "author_login",
              "additions",
              "deletions",
              "event_date"
            ) AS (
              VALUES ${values}
            ),
            inserted AS (
              INSERT INTO "activity_recent" (
                "id",
                "repo_id",
                "event_type",
                "event_id",
                "title",
                "author_login",
                "additions",
                "deletions",
                "event_date"
              )
              SELECT
                i."id",
                i."repo_id",
                i."event_type",
                i."event_id",
                i."title",
                i."author_login",
                i."additions",
                i."deletions",
                i."event_date"
              FROM incoming i
              ON CONFLICT DO NOTHING
              RETURNING "repo_id", "event_type", "author_login", "event_date"
            )
            SELECT "repo_id", "event_type", "author_login", "event_date"
            FROM inserted
          `
      );
    } catch (error) {
      console.warn(
        `[sync] Falling back to row-wise activity_recent inserts after raw chunk failure: ${(error as Error).message}`
      );
      rows = await insertRecentEventsChunkFallback(db, preparedChunk);
    }
    inserted.push(
      ...rows.map((row) => ({
        repoId: row.repo_id,
        eventType: row.event_type,
        authorLogin: row.author_login,
        eventDate: new Date(row.event_date),
      }))
    );
  }

  return inserted;
}

async function insertRecentEventsChunkFallback(
  db: IngestionDbClient,
  chunk: PreparedActivityEvent[]
): Promise<
  Array<{
    repo_id: string;
    event_type: string;
    author_login: string | null;
    event_date: Date;
  }>
> {
  const insertedRows: Array<{
    repo_id: string;
    event_type: string;
    author_login: string | null;
    event_date: Date;
  }> = [];

  for (const event of chunk) {
    try {
      const created = await withIngestionDbWrite(
        db,
        "github-activity.insert-recent-events-fallback-row",
        () =>
          db.activityRecent.create({
            data: {
              id: event.id,
              repoId: event.repoId,
              eventType: event.eventType,
              eventId: event.eventId,
              title: event.title,
              authorLogin: event.authorLogin,
              additions: event.additions,
              deletions: event.deletions,
              eventDate: event.eventDate,
            },
          })
      );
      insertedRows.push({
        repo_id: created.repoId,
        event_type: created.eventType,
        author_login: created.authorLogin,
        event_date: created.eventDate,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        continue;
      }
      throw error;
    }
  }

  return insertedRows;
}

async function updateDeveloperRepoStats(
  db: IngestionDbClient,
  events: Array<{
    repoId: string;
    eventType: string;
    authorLogin: string | null;
    eventDate: Date;
  }>
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

  if (map.size === 0) return;

  const rows = Array.from(map.entries()).map(([key, stats]) => {
    const [login, ...repoParts] = key.split(":");
    return {
      login,
      repoId: repoParts.join(":"),
      commits: stats.commits,
      prs: stats.prs,
      lastActiveAt: stats.lastActiveAt,
    };
  });

  if (!batchedGithubActivityWritesEnabled) {
    for (const row of rows) {
      await withIngestionDbWrite(db, "github-activity.upsert-developer-repo-activity", () =>
        db.developerRepoActivity.upsert({
          where: {
            developerLogin_repoId: {
              developerLogin: row.login,
              repoId: row.repoId,
            },
          },
          create: {
            developerLogin: row.login,
            repoId: row.repoId,
            totalCommits: row.commits,
            totalPRs: row.prs,
            lastActiveAt: row.lastActiveAt,
          },
          update: {
            totalCommits: { increment: row.commits },
            totalPRs: { increment: row.prs },
            lastActiveAt: row.lastActiveAt,
          },
        })
      );
    }
    return;
  }

  for (let i = 0; i < rows.length; i += DB_BATCH_SIZE) {
    const chunk = rows.slice(i, i + DB_BATCH_SIZE);
    const updatedAt = new Date();
    const values = Prisma.join(
      chunk.map((row) =>
        Prisma.sql`(${row.login}, ${row.repoId}, ${row.commits}, ${row.prs}, ${row.lastActiveAt}, ${updatedAt})`
      )
    );

    await withIngestionDbWrite(
      db,
      "github-activity.bulk-upsert-developer-repo-activity",
      () => db.$executeRaw`
      WITH incoming("developer_login", "repo_id", "total_commits", "total_prs", "last_active_at", "updated_at") AS (
        VALUES ${values}
      )
      INSERT INTO "developer_repo_activity" (
        "id",
        "developer_login",
        "repo_id",
        "total_commits",
        "total_prs",
        "last_active_at",
        "updated_at"
      )
      SELECT
        i."developer_login" || ':' || i."repo_id",
        i."developer_login",
        i."repo_id",
        i."total_commits",
        i."total_prs",
        i."last_active_at",
        i."updated_at"
      FROM incoming i
      INNER JOIN "github_developer" gd
        ON gd."id" = i."developer_login"
      ON CONFLICT ("developer_login", "repo_id")
      DO UPDATE SET
        "total_commits" = "developer_repo_activity"."total_commits" + EXCLUDED."total_commits",
        "total_prs" = "developer_repo_activity"."total_prs" + EXCLUDED."total_prs",
        "last_active_at" = GREATEST("developer_repo_activity"."last_active_at", EXCLUDED."last_active_at"),
        "updated_at" = EXCLUDED."updated_at"
    `
    );
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
  db: IngestionDbClient,
  authors: Map<string, string | null>
): Promise<void> {
  if (authors.size === 0) return;
  const now = new Date();
  const rows = Array.from(authors.entries()).map(([login, avatarUrl]) => ({
    id: login,
    avatarUrl,
    firstSeenAt: now,
    lastSeenAt: now,
  }));

  await withIngestionDbWrite(db, "github-activity.create-many-developers", () =>
    db.githubDeveloper.createMany({
      data: rows,
      skipDuplicates: true,
    })
  );

  if (!batchedGithubActivityWritesEnabled) {
    for (const row of rows) {
      await withIngestionDbWrite(db, "github-activity.update-developer", () =>
        db.githubDeveloper.update({
          where: { id: row.id },
          data: {
            avatarUrl: row.avatarUrl,
            lastSeenAt: row.lastSeenAt,
          },
        })
      );
    }
    return;
  }

  for (let i = 0; i < rows.length; i += DB_BATCH_SIZE) {
    const chunk = rows.slice(i, i + DB_BATCH_SIZE);
    const values = Prisma.join(
      chunk.map((row) => Prisma.sql`(${row.id}, ${row.avatarUrl}, ${row.lastSeenAt})`)
    );

    await withIngestionDbWrite(db, "github-activity.bulk-update-developers", () =>
      db.$executeRaw`
      WITH incoming("id", "avatar_url", "last_seen_at") AS (
        VALUES ${values}
      )
      UPDATE "github_developer" gd
      SET
        "avatar_url" = incoming."avatar_url",
        "last_seen_at" = incoming."last_seen_at"
      FROM incoming
      WHERE gd."id" = incoming."id"
    `
    );
  }
}

// ─── Re-Tiering ──────────────────────────────────────────────────────────────

export async function reTierRepos(
  db: IngestionDbClient = prisma
): Promise<{
  promoted: number;
  demoted: number;
}> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Promote to active: activity in last 7 days
  const promoted = await withIngestionDbWrite(db, "github-activity.retier-promote", () =>
    db.githubRepository.updateMany({
      where: {
        isActive: true,
        syncTier: { not: "active" },
        lastActivityAt: { gte: sevenDaysAgo },
      },
      data: { syncTier: "active" },
    })
  );

  // Demote active → moderate: no activity in 7 days but within 90
  const toModerate = await withIngestionDbWrite(
    db,
    "github-activity.retier-to-moderate",
    () =>
      db.githubRepository.updateMany({
        where: {
          isActive: true,
          syncTier: "active",
          OR: [
            { lastActivityAt: { lt: sevenDaysAgo, gte: ninetyDaysAgo } },
            { lastActivityAt: null },
          ],
        },
        data: { syncTier: "moderate" },
      })
  );

  // Demote moderate → dormant: no activity in 90+ days
  const toDormant = await withIngestionDbWrite(
    db,
    "github-activity.retier-to-dormant",
    () =>
      db.githubRepository.updateMany({
        where: {
          isActive: true,
          syncTier: "moderate",
          OR: [
            { lastActivityAt: { lt: ninetyDaysAgo } },
            { lastActivityAt: null },
          ],
        },
        data: { syncTier: "dormant" },
      })
  );

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

export async function snapshotAllRepos(
  db: IngestionDbClient = prisma
): Promise<SnapshotResult> {
  const repos = await withIngestionDbRead(db, "github-activity.snapshot-find-repos", () =>
    db.githubRepository.findMany({
      where: { isActive: true },
      select: { id: true, owner: true, name: true },
      orderBy: { lastSyncedAt: "asc" },
    })
  );

  const result: SnapshotResult = { total: repos.length, success: 0, failed: 0, errors: [] };
  const healthSummary: RepoHealthSummary = {
    unresolvedSeen: 0,
    reposDeactivated: 0,
    transientBatchFailures: 0,
  };
  if (repos.length === 0) return result;
  if (shouldFailFastForDb("ingestion.github-activity.snapshot")) {
    result.failed = repos.length;
    result.errors.push({
      repo: "all",
      error: "DB fail-fast active; skipping github snapshot sync",
    });
    return result;
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const fragment = `stargazerCount\n    forkCount\n    openIssueCount: issues(states: [OPEN]) { totalCount }\n    watchers { totalCount }`;

  for (let i = 0; i < repos.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = repos.slice(i, i + SNAPSHOT_BATCH_SIZE);

    try {
      const { batch: filteredBatch, data } =
        await fetchBatchDataWithUnresolvedHandling<{
          stargazerCount: number;
          forkCount: number;
          openIssueCount: { totalCount: number };
          watchers: { totalCount: number };
        }>(
          batch,
          fragment,
          result,
          healthSummary,
          "ingestion.github-activity.snapshot-item",
          db
        );
      if (filteredBatch.length === 0) {
        continue;
      }

      for (let j = 0; j < filteredBatch.length; j++) {
        const repo = filteredBatch[j];
        const repoData = data[`repo${j}`];

        if (!repoData) {
          result.failed++;
          result.errors.push({ repo: `${repo.owner}/${repo.name}`, error: "No data returned" });
          continue;
        }

        try {
          if (shouldFailFastForDb("ingestion.github-activity.snapshot-item")) {
            throw new Error("DB fail-fast active; skipping github snapshot item");
          }
          await withIngestionDbWrite(
            db,
            "github-activity.snapshot-upsert-daily-snapshot",
            () =>
              db.repoDailySnapshot.upsert({
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
              })
          );

          await withIngestionDbWrite(
            db,
            "github-activity.snapshot-update-repo",
            () =>
              db.githubRepository.update({
                where: { id: repo.id },
                data: {
                  stars: repoData.stargazerCount,
                  forks: repoData.forkCount,
                },
              })
          );

          result.success++;
        } catch (error: any) {
          recordDbFailureForFailFast(
            error,
            "ingestion.github-activity.snapshot-item"
          );
          result.failed++;
          result.errors.push({ repo: `${repo.owner}/${repo.name}`, error: error.message });
        }
      }
    } catch (error: any) {
      recordDbFailureForFailFast(error, "ingestion.github-activity.snapshot-batch");
      healthSummary.transientBatchFailures += 1;
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
  console.log(
    `[github-repo-health] scope=ingestion.github-activity.snapshot unresolvedSeen=${healthSummary.unresolvedSeen} reposDeactivated=${healthSummary.reposDeactivated} transientBatchFailures=${healthSummary.transientBatchFailures}`
  );
  return result;
}

async function fetchBatchDataWithUnresolvedHandling<T>(
  initialBatch: RepoRef[],
  fragment: string,
  result: { failed: number; errors: Array<{ repo: string; error: string }> },
  healthSummary: RepoHealthSummary,
  scope: string,
  db: IngestionDbClient = prisma
): Promise<{ batch: RepoRef[]; data: Record<string, T> }> {
  let batch = initialBatch;

  while (true) {
    const query = buildBatchRepoQuery(
      batch.map((r) => ({ owner: r.owner, name: r.name })),
      fragment
    );

    try {
      const data = await githubGraphQL<Record<string, T>>(query);
      return { batch, data };
    } catch (error: unknown) {
      const unresolvedNames = getUnresolvedRepoNamesFromGraphQLError(error);
      if (unresolvedNames.size === 0) {
        throw error;
      }

      const unresolvedRepos = batch.filter((repo) =>
        unresolvedNames.has(`${repo.owner}/${repo.name}`)
      );
      if (unresolvedRepos.length === 0) {
        throw error;
      }

      for (const repo of unresolvedRepos) {
        await markRepoUnresolved(repo, result, healthSummary, scope, db);
      }

      batch = batch.filter(
        (repo) => !unresolvedNames.has(`${repo.owner}/${repo.name}`)
      );
      if (batch.length === 0) {
        return { batch, data: {} };
      }

      console.warn(
        `[github-repo-health] action=retry-without-unresolved scope=${scope} removed=${unresolvedRepos.length} remaining=${batch.length}`
      );
    }
  }
}

async function markRepoUnresolved(
  repo: RepoRef,
  result: { failed: number; errors: Array<{ repo: string; error: string }> },
  healthSummary: RepoHealthSummary,
  scope: string,
  db: IngestionDbClient = prisma
): Promise<void> {
  const nextCount = await incrementGithubRepoHealthCounter(
    "activityUnresolved",
    repo.id
  );
  healthSummary.unresolvedSeen += 1;
  result.failed += 1;
  result.errors.push({
    repo: repo.id,
    error: "GitHub repo unresolved (not found or inaccessible)",
  });

  console.warn(
    `[github-repo-health] action=unresolved scope=${scope} repo=${repo.id} count=${nextCount} threshold=${unresolvedRepoDisableThreshold}`
  );

  if (nextCount < unresolvedRepoDisableThreshold) {
    return;
  }

  const deactivated = await withIngestionDbWrite(
    db,
    "github-activity.deactivate-unresolved-repo",
    () =>
      db.githubRepository.updateMany({
        where: { id: repo.id, isActive: true },
        data: { isActive: false },
      })
  );
  if (deactivated.count > 0) {
    healthSummary.reposDeactivated += 1;
    console.warn(
      `[github-repo-health] action=deactivate scope=${scope} repo=${repo.id} count=${nextCount}`
    );
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export async function purgeOldRecentActivity(
  db: IngestionDbClient = prisma
): Promise<number> {
  const cutoff = new Date(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const deleted = await withIngestionDbWrite(
    db,
    "github-activity.purge-old-recent-activity",
    () =>
      db.activityRecent.deleteMany({
        where: { eventDate: { lt: cutoff } },
      })
  );
  console.log(`[cleanup] Purged ${deleted.count} old activity_recent rows`);
  return deleted.count;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildActivityRecentId(event: Pick<ActivityEvent, "repoId" | "eventType" | "eventId">): string {
  const key = `${event.repoId}:${event.eventType}:${event.eventId}`;
  const digest = createHash("sha256").update(key).digest("hex");
  return `gha_${digest.slice(0, 48)}`;
}

/** Postgres infers untyped VALUES columns as text when nullable params mix; cast INTEGER explicitly. */
function sqlNullableInt32(value: number | null): Prisma.Sql {
  if (value === null) {
    return Prisma.sql`NULL::integer`;
  }
  return Prisma.sql`${value}::integer`;
}

function isUniqueConstraintError(error: unknown): boolean {
  const e = error as { code?: string; cause?: unknown } | null;
  if (e && typeof e === "object" && e.code === "P2002") {
    return true;
  }
  if (e && typeof e === "object" && e.cause) {
    return isUniqueConstraintError(e.cause);
  }
  return false;
}

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
