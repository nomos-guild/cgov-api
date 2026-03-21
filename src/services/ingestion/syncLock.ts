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

import { prisma } from "../prisma";

/** Default lock TTL (15 min). Jobs that run longer should pass ttlMs explicitly. */
export const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000;

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

  return prisma.$transaction(async (tx) => {
    // 1. Expire stale locks (previous run crashed or timed out)
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

    // 2. Check if job is already running (another instance holds the lock)
    const status = await tx.syncStatus.findUnique({
      where: { jobName },
      select: { isRunning: true },
    });

    if (status?.isRunning) {
      return false;
    }

    // 3. Acquire lock: upsert row with isRunning=true and expiresAt
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
  });
}

/**
 * Releases a job lock after work completes. Call with result "success", "failed",
 * or "expired". Optionally pass itemsProcessed and errorMessage for status tracking.
 */
export async function releaseJobLock(
  jobName: string,
  result: "success" | "failed" | "expired",
  itemsProcessed?: number,
  errorMessage?: string | null
): Promise<void> {
  await prisma.syncStatus.update({
    where: { jobName },
    data: {
      isRunning: false,
      completedAt: new Date(),
      expiresAt: null,
      lastResult: result,
      itemsProcessed: itemsProcessed ?? null,
      errorMessage: errorMessage ?? null,
    },
  });
}

/**
 * Returns true if the job is currently locked (another run is active).
 * Does not check expiresAt; use acquireJobLock to handle expiry.
 */
export async function isJobLockActive(jobName: string): Promise<boolean> {
  const status = await prisma.syncStatus.findUnique({
    where: { jobName },
    select: { isRunning: true },
  });

  return !!status?.isRunning;
}
