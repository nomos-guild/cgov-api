import { prisma, withDbRead, withDbWrite } from "../prisma";

const GITHUB_COORDINATION_JOB_NAME = "github-shared-coordination";
const GITHUB_COORDINATION_DISPLAY_NAME = "GitHub Shared Coordination";

export type GithubRepoHealthCounterKind =
  | "activityUnresolved"
  | "backfillTransient"
  | "backfillUnresolved";

interface GithubRateLimitCursor {
  cooldownUntilMs: number;
  updatedAt: string;
}

interface GithubRepoHealthCountersCursor {
  activityUnresolved: Record<string, number>;
  backfillTransient: Record<string, number>;
  backfillUnresolved: Record<string, number>;
  updatedAt: string;
}

interface GithubSharedCursor {
  rateLimit: GithubRateLimitCursor;
  repoHealthCounters: GithubRepoHealthCountersCursor;
  updatedAt: string;
}

export interface GithubSharedRateLimitSnapshot {
  cooldownUntilMs: number;
  updatedAt: string;
}

function emptyRateLimitSnapshot(): GithubRateLimitCursor {
  return {
    cooldownUntilMs: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

function emptyRepoHealthCounters(): GithubRepoHealthCountersCursor {
  return {
    activityUnresolved: {},
    backfillTransient: {},
    backfillUnresolved: {},
    updatedAt: new Date(0).toISOString(),
  };
}

function emptySharedCursor(): GithubSharedCursor {
  return {
    rateLimit: emptyRateLimitSnapshot(),
    repoHealthCounters: emptyRepoHealthCounters(),
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeCounterMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const next: Record<string, number> = {};
  for (const [repoId, count] of entries) {
    if (typeof repoId !== "string" || repoId.length === 0) continue;
    if (typeof count !== "number" || !Number.isFinite(count)) continue;
    const normalized = Math.max(0, Math.floor(count));
    if (normalized > 0) {
      next[repoId] = normalized;
    }
  }
  return next;
}

function parseCursor(raw: string | null | undefined): GithubSharedCursor {
  if (!raw) return emptySharedCursor();
  try {
    const parsed = JSON.parse(raw) as Partial<GithubSharedCursor>;
    const parsedRate = parsed.rateLimit as Partial<GithubRateLimitCursor> | undefined;
    const parsedCounters =
      parsed.repoHealthCounters as Partial<GithubRepoHealthCountersCursor> | undefined;
    return {
      rateLimit: {
        cooldownUntilMs: normalizeTimestamp(parsedRate?.cooldownUntilMs),
        updatedAt:
          typeof parsedRate?.updatedAt === "string"
            ? parsedRate.updatedAt
            : new Date(0).toISOString(),
      },
      repoHealthCounters: {
        activityUnresolved: normalizeCounterMap(parsedCounters?.activityUnresolved),
        backfillTransient: normalizeCounterMap(parsedCounters?.backfillTransient),
        backfillUnresolved: normalizeCounterMap(parsedCounters?.backfillUnresolved),
        updatedAt:
          typeof parsedCounters?.updatedAt === "string"
            ? parsedCounters.updatedAt
            : new Date(0).toISOString(),
      },
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return emptySharedCursor();
  }
}

async function withLockedSharedCursor<T>(
  mutator: (cursor: GithubSharedCursor) => T
): Promise<T> {
  return withDbWrite("github-shared-coordination.write", async () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "sync_status" ("job_name", "display_name", "is_running", "created_at", "updated_at")
        VALUES (${GITHUB_COORDINATION_JOB_NAME}, ${GITHUB_COORDINATION_DISPLAY_NAME}, false, NOW(), NOW())
        ON CONFLICT ("job_name") DO NOTHING
      `;

      const rows = await tx.$queryRaw<Array<{ backfill_cursor: string | null }>>`
        SELECT "backfill_cursor"
        FROM "sync_status"
        WHERE "job_name" = ${GITHUB_COORDINATION_JOB_NAME}
        FOR UPDATE
      `;

      const current = parseCursor(rows[0]?.backfill_cursor ?? null);
      const next = mutator(current);
      current.updatedAt = new Date().toISOString();

      await tx.syncStatus.update({
        where: { jobName: GITHUB_COORDINATION_JOB_NAME },
        data: {
          displayName: GITHUB_COORDINATION_DISPLAY_NAME,
          isRunning: false,
          backfillCursor: JSON.stringify(current),
        },
      });

      return next;
    })
  );
}

export async function getGithubSharedRateLimitSnapshot(): Promise<GithubSharedRateLimitSnapshot> {
  return withDbRead("github-shared-coordination.read-rate-limit", async () => {
    const row = await prisma.syncStatus.findUnique({
      where: { jobName: GITHUB_COORDINATION_JOB_NAME },
      select: { backfillCursor: true },
    });
    const parsed = parseCursor(row?.backfillCursor);
    return {
      cooldownUntilMs: parsed.rateLimit.cooldownUntilMs,
      updatedAt: parsed.rateLimit.updatedAt,
    };
  });
}

export async function mergeGithubSharedRateLimitCooldown(
  cooldownUntilMs: number
): Promise<GithubSharedRateLimitSnapshot> {
  const normalizedCooldownUntil = normalizeTimestamp(cooldownUntilMs);
  return withLockedSharedCursor((cursor) => {
    cursor.rateLimit.cooldownUntilMs = Math.max(
      cursor.rateLimit.cooldownUntilMs,
      normalizedCooldownUntil
    );
    cursor.rateLimit.updatedAt = new Date().toISOString();
    return {
      cooldownUntilMs: cursor.rateLimit.cooldownUntilMs,
      updatedAt: cursor.rateLimit.updatedAt,
    };
  });
}

export async function incrementGithubRepoHealthCounter(
  kind: GithubRepoHealthCounterKind,
  repoId: string
): Promise<number> {
  return withLockedSharedCursor((cursor) => {
    const current = cursor.repoHealthCounters[kind][repoId] ?? 0;
    const next = current + 1;
    cursor.repoHealthCounters[kind][repoId] = next;
    cursor.repoHealthCounters.updatedAt = new Date().toISOString();
    return next;
  });
}

export async function clearGithubRepoHealthCounters(
  repoId: string,
  kinds: GithubRepoHealthCounterKind[]
): Promise<void> {
  await withLockedSharedCursor((cursor) => {
    for (const kind of kinds) {
      delete cursor.repoHealthCounters[kind][repoId];
    }
    cursor.repoHealthCounters.updatedAt = new Date().toISOString();
    return undefined;
  });
}
