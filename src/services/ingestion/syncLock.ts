/**
 * Shared job lock utility for SyncStatus-based distributed locking.
 *
 * Provides a best-effort lease lock to prevent concurrent runs of the same job
 * across multiple instances (e.g. Cloud Run + cron). Uses the sync_status table
 * as a lease row: expire stale locks, check if running, upsert to acquire.
 *
 * Note: This is not a strict mutex. Under high contention, two callers can both
 * observe "not running" and both proceed. Good for low-contention operational
 * deduping; stronger semantics are a follow-up.
 */

import { prisma, withDbRead, withDbWrite } from "../prisma";

/** Default lock TTL (15 min). Jobs that run longer should pass ttlMs explicitly. */
export const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000;
const strictSyncLockEnabled = process.env.STRICT_SYNC_LOCK_ENABLED !== "false";

export interface AcquireJobLockOptions {
  /** Override default TTL. Used for slow jobs (e.g. delegation sync, missing epochs). */
  ttlMs?: number;
  /** Logical source for lockedBy (e.g. "cron", "api-instance"). */
  source?: string;
}

/**
 * Parses an env var as an integer with min/max bounds. Returns defaultValue if
 * missing, invalid, or out of range. Used for lock TTL overrides per job.
 */
export function getBoundedIntEnv(
  envKey: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const rawValue = process.env[envKey];
  if (!rawValue) return defaultValue;

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return defaultValue;
  }

  return parsed;
}

/**
 * Attempts to acquire a job lock in sync_status. Returns true if acquired, false
 * if another run is active. Runs inside a Prisma transaction: expire stale rows,
 * check isRunning, then upsert to claim. Call releaseJobLock when done.
 */
export async function acquireJobLock(
  jobName: string,
  displayName: string,
  options?: AcquireJobLockOptions
): Promise<boolean> {
  const now = new Date();
  const ttlMs = options?.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const lockedBy = process.env.HOSTNAME || options?.source || "api-instance";

  if (!strictSyncLockEnabled) {
    return withDbWrite(`sync-lock.acquire.${jobName}`, async () =>
      prisma.$transaction(async (tx) => {
      await tx.syncStatus.updateMany({
        where: {
          jobName,
          isRunning: true,
          expiresAt: { lt: now },
        },
        data: {
          isRunning: false,
          completedAt: now,
          lastResult: "expired",
          errorMessage: "Lock expired - previous run may have crashed",
        },
      });

      const status = await tx.syncStatus.findUnique({
        where: { jobName },
        select: { isRunning: true },
      });

      if (status?.isRunning) {
        return false;
      }

      await tx.syncStatus.upsert({
        where: { jobName },
        create: {
          jobName,
          displayName,
          isRunning: true,
          startedAt: now,
          completedAt: null,
          expiresAt: new Date(now.getTime() + ttlMs),
          lockedBy,
          errorMessage: null,
        },
        update: {
          displayName,
          isRunning: true,
          startedAt: now,
          completedAt: null,
          expiresAt: new Date(now.getTime() + ttlMs),
          lockedBy,
          errorMessage: null,
        },
      });

        return true;
      })
    );
  }

  return withDbWrite(`sync-lock.acquire.${jobName}`, async () =>
    prisma.$transaction(async (tx) => {
    // Ensure row exists so we can take a row-level lock deterministically.
    await tx.$executeRaw`
      INSERT INTO "sync_status" ("job_name", "display_name", "is_running", "created_at", "updated_at")
      VALUES (${jobName}, ${displayName}, false, NOW(), NOW())
      ON CONFLICT ("job_name") DO NOTHING
    `;

    // Lock this job row for the rest of the transaction to avoid check-then-set races.
    const rows = await tx.$queryRaw<
      Array<{ is_running: boolean; expires_at: Date | null; locked_by: string | null }>
    >`
      SELECT "is_running", "expires_at", "locked_by"
      FROM "sync_status"
      WHERE "job_name" = ${jobName}
      FOR UPDATE
    `;

    const row = rows[0];
    if (!row) {
      return false;
    }

    const expired = row.is_running && row.expires_at !== null && row.expires_at < now;
    if (expired) {
      await tx.syncStatus.update({
        where: { jobName },
        data: {
          isRunning: false,
          completedAt: now,
          lastResult: "expired",
          errorMessage: "Lock expired - previous run may have crashed",
        },
      });
    }

    if (row.is_running && !expired) {
      console.log(
        `[Sync Lock] action=contended job=${jobName} lockedBy=${row.locked_by ?? "unknown"}`
      );
      return false;
    }

    await tx.syncStatus.update({
      where: { jobName },
      data: {
        displayName,
        isRunning: true,
        startedAt: now,
        completedAt: null,
        expiresAt: new Date(now.getTime() + ttlMs),
        lockedBy,
        errorMessage: null,
      },
    });

      return true;
    })
  );
}

/** Stored on SyncStatus.lastResult (string column; extend as needed). */
export type JobLockReleaseResult =
  | "success"
  | "partial"
  | "failed"
  | "expired";

/**
 * Releases a job lock after work completes. Call with result "success", "partial",
 * "failed", or "expired". Optionally pass itemsProcessed and errorMessage for status tracking.
 */
export async function releaseJobLock(
  jobName: string,
  result: JobLockReleaseResult,
  itemsProcessed?: number,
  errorMessage?: string | null
): Promise<void> {
  await withDbWrite(`sync-lock.release.${jobName}`, async () =>
    prisma.syncStatus.update({
      where: { jobName },
      data: {
        isRunning: false,
        completedAt: new Date(),
        expiresAt: null,
        lastResult: result,
        itemsProcessed: itemsProcessed ?? null,
        errorMessage: errorMessage ?? null,
      },
    })
  );
}

/**
 * Returns true if the job is currently locked (another run is active).
 * Does not check expiresAt; use acquireJobLock to handle expiry.
 */
export async function isJobLockActive(jobName: string): Promise<boolean> {
  const status = await withDbRead(`sync-lock.status.${jobName}`, async () =>
    prisma.syncStatus.findUnique({
      where: { jobName },
      select: { isRunning: true },
    })
  );

  return !!status?.isRunning;
}
