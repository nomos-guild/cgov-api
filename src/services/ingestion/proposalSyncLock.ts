import {
  acquireJobLock,
  getBoundedIntEnv,
  isJobLockActive,
  releaseJobLock,
  type JobLockReleaseResult,
} from "./syncLock";

export const PROPOSAL_SYNC_JOB_NAME = "proposal-sync";
const PROPOSAL_SYNC_DISPLAY_NAME = "Proposal Sync";
const DEFAULT_PROPOSAL_SYNC_LOCK_TTL_MS = 15 * 60 * 1000;

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
  status: JobLockReleaseResult;
  errorMessage?: string | null;
  itemsProcessed?: number;
}

export async function isProposalSyncLockActive(): Promise<boolean> {
  return isJobLockActive(PROPOSAL_SYNC_JOB_NAME);
}

export async function tryAcquireProposalSyncLock(
  source: string,
  options?: AcquireProposalSyncLockOptions
): Promise<boolean> {
  const displayName = options?.displayName ?? PROPOSAL_SYNC_DISPLAY_NAME;
  return acquireJobLock(PROPOSAL_SYNC_JOB_NAME, displayName, {
    ttlMs: options?.ttlMs ?? PROPOSAL_SYNC_LOCK_TTL_MS,
    source,
  });
}

export async function releaseProposalSyncLock(
  options: ReleaseProposalSyncLockOptions
): Promise<void> {
  await releaseJobLock(
    PROPOSAL_SYNC_JOB_NAME,
    options.status,
    options.itemsProcessed,
    options.errorMessage
  );
}
