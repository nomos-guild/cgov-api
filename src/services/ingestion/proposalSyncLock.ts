import { prisma } from "../prisma";

export const PROPOSAL_SYNC_JOB_NAME = "proposal-sync";
const PROPOSAL_SYNC_DISPLAY_NAME = "Proposal Sync";
const DEFAULT_PROPOSAL_SYNC_LOCK_TTL_MS = 15 * 60 * 1000;

function getBoundedIntEnv(
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

export const PROPOSAL_SYNC_LOCK_TTL_MS = getBoundedIntEnv(
  "PROPOSAL_SYNC_LOCK_TTL_MS",
  DEFAULT_PROPOSAL_SYNC_LOCK_TTL_MS,
  30_000,
  60 * 60 * 1000
);

export interface AcquireProposalSyncLockOptions {
  ttlMs?: number;
  displayName?: string;
}

export interface ReleaseProposalSyncLockOptions {
  status: "success" | "failed" | "expired";
  errorMessage?: string | null;
  itemsProcessed?: number;
}

export async function isProposalSyncLockActive(): Promise<boolean> {
  const status = await prisma.syncStatus.findUnique({
    where: { jobName: PROPOSAL_SYNC_JOB_NAME },
    select: { isRunning: true },
  });
  return !!status?.isRunning;
}

export async function tryAcquireProposalSyncLock(
  source: string,
  options?: AcquireProposalSyncLockOptions
): Promise<boolean> {
  const now = new Date();
  const ttlMs = options?.ttlMs ?? PROPOSAL_SYNC_LOCK_TTL_MS;
  const displayName = options?.displayName ?? PROPOSAL_SYNC_DISPLAY_NAME;

  return prisma.$transaction(async (tx) => {
    await tx.syncStatus.updateMany({
      where: {
        jobName: PROPOSAL_SYNC_JOB_NAME,
        isRunning: true,
        expiresAt: { lt: now },
      },
      data: {
        isRunning: false,
        completedAt: now,
        lastResult: "expired",
        errorMessage: "Proposal sync lock expired before completion",
      },
    });

    const status = await tx.syncStatus.findUnique({
      where: { jobName: PROPOSAL_SYNC_JOB_NAME },
      select: { isRunning: true },
    });

    if (status?.isRunning) {
      return false;
    }

    await tx.syncStatus.upsert({
      where: { jobName: PROPOSAL_SYNC_JOB_NAME },
      create: {
        jobName: PROPOSAL_SYNC_JOB_NAME,
        displayName,
        isRunning: true,
        startedAt: now,
        completedAt: null,
        expiresAt: new Date(now.getTime() + ttlMs),
        lockedBy: process.env.HOSTNAME || source,
        errorMessage: null,
      },
      update: {
        displayName,
        isRunning: true,
        startedAt: now,
        completedAt: null,
        expiresAt: new Date(now.getTime() + ttlMs),
        lockedBy: process.env.HOSTNAME || source,
        errorMessage: null,
      },
    });

    return true;
  });
}

export async function releaseProposalSyncLock(
  options: ReleaseProposalSyncLockOptions
): Promise<void> {
  await prisma.syncStatus.update({
    where: { jobName: PROPOSAL_SYNC_JOB_NAME },
    data: {
      isRunning: false,
      completedAt: new Date(),
      expiresAt: null,
      lastResult: options.status,
      itemsProcessed: options.itemsProcessed,
      errorMessage: options.errorMessage ?? null,
    },
  });
}
