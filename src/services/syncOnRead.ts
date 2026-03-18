/**
 * Sync-on-Read Service
 *
 * Provides on-demand syncing of proposals and votes from Koios API.
 * This enables near-real-time updates when users access proposal data,
 * so that new votes are reflected within seconds of being submitted on-chain.
 *
 * IMPORTANT: All sync functions run in the BACKGROUND (non-blocking) to ensure
 * fast API response times. The page loads instantly with existing data, and
 * new data will be available on the next request after the background sync completes.
 *
 * Throttling/cooldowns are implemented to avoid overwhelming Koios API:
 * - Overview sync: default 30 second cooldown (env override supported)
 * - Per-proposal sync: default 20 second cooldown per proposal (env override supported)
 */

import { ProposalStatus } from "@prisma/client";
import { prisma } from "./prisma";
import {
  getKoiosPressureState,
  getKoiosProposalList,
  koiosGet,
} from "./koios";
import {
  ingestProposalData,
  finalizeProposalStatusAfterVoteSync,
  getCurrentEpoch,
} from "./ingestion/proposal.service";
import {
  isProposalSyncLockActive,
  releaseProposalSyncLock,
  tryAcquireProposalSyncLock,
} from "./ingestion/proposalSyncLock";
import type {
  KoiosProposal,
  KoiosProposalVotingSummary,
} from "../types/koios.types";

type ProposalSyncTargetKind =
  | "proposalId"
  | "numericId"
  | "txHash"
  | "txHashAndIndex";

type ProposalSnapshot = {
  proposalId: string;
  status: ProposalStatus;
  drepActiveYesVotePower: bigint | null;
  drepActiveNoVotePower: bigint | null;
  drepActiveAbstainVotePower: bigint | null;
  spoActiveYesVotePower: bigint | null;
  spoActiveNoVotePower: bigint | null;
  spoActiveAbstainVotePower: bigint | null;
};

interface ParsedProposalIdentifier {
  raw: string;
  normalized: string;
  kind: ProposalSyncTargetKind;
  proposalId?: string;
  numericId?: number;
  txHash?: string;
  certIndex?: string;
}

interface ResolvedProposalSyncTarget {
  raw: string;
  kind: ProposalSyncTargetKind;
  canonicalKey: string;
  guardKey: string;
  proposalId?: string;
  dbProposal: ProposalSnapshot | null;
  txHash?: string;
  certIndex?: string;
}

function getCooldownMs(
  envKey: string,
  defaultMs: number,
  minMs = 15_000,
  maxMs = 60_000
): number {
  const raw = process.env[envKey];
  if (!raw) return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minMs || parsed > maxMs) {
    return defaultMs;
  }
  return parsed;
}

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

// Cooldown periods (in milliseconds)
// Defaults are intentionally conservative to reduce duplicate sync fanout
// during rapid UI refresh/navigation bursts while still keeping freshness.
const OVERVIEW_SYNC_COOLDOWN_MS = getCooldownMs(
  "OVERVIEW_SYNC_COOLDOWN_MS",
  30_000
);
const PROPOSAL_SYNC_COOLDOWN_MS = getCooldownMs(
  "PROPOSAL_SYNC_COOLDOWN_MS",
  20_000
);
const PROPOSAL_SYNC_ON_READ_GUARD_PREFIX = "sync-on-read:proposal:";
const PROPOSAL_SYNC_ON_READ_GUARD_TTL_MS = getBoundedIntEnv(
  "SYNC_ON_READ_PROPOSAL_GUARD_TTL_MS",
  120_000,
  5_000,
  600_000
);
const SYNC_ON_READ_SKIP_WHEN_PROPOSAL_SYNC_RUNNING =
  process.env.SYNC_ON_READ_SKIP_WHEN_PROPOSAL_SYNC_RUNNING !== "false";
const SYNC_ON_READ_SKIP_WHEN_KOIOS_DEGRADED =
  process.env.SYNC_ON_READ_SKIP_WHEN_KOIOS_DEGRADED !== "false";
const SYNC_ON_READ_OVERVIEW_LOCK_TTL_MS = getBoundedIntEnv(
  "SYNC_ON_READ_OVERVIEW_LOCK_TTL_MS",
  120_000,
  15_000,
  600_000
);
const MAX_TRACKED_PROPOSAL_SYNC_KEYS = getBoundedIntEnv(
  "SYNC_ON_READ_MAX_TRACKED_KEYS",
  2000,
  100,
  100_000
);
const MAX_TRACKED_PROPOSAL_IDENTIFIER_ALIASES = getBoundedIntEnv(
  "SYNC_ON_READ_MAX_TRACKED_ALIASES",
  4000,
  100,
  200_000
);
const GOV_ACTION_IDENTIFIER_PREFIX = "gov_action";
const TX_HASH_REGEX = /^[0-9a-f]{64}$/i;
const NUMERIC_ID_REGEX = /^\d+$/;

// Last sync timestamps
let lastOverviewSyncTime = 0;
const proposalSyncTimes = new Map<string, number>();
const proposalIdentifierAliases = new Map<string, string>();

// Track proposals currently being synced to prevent concurrent syncs
let isOverviewSyncInProgress = false;
const proposalSyncsInProgress = new Set<string>();

async function getSyncOnReadSkipReason(
  trigger: "overview" | "proposal",
  identifier?: string
): Promise<string | null> {
  if (
    SYNC_ON_READ_SKIP_WHEN_PROPOSAL_SYNC_RUNNING &&
    await isProposalSyncLockActive()
  ) {
    console.log(
      `[Sync-on-Read] action=skip trigger=${trigger} identifier=${identifier ?? "n/a"} reason=proposal-sync-active`
    );
    return "proposal-sync-active";
  }

  if (SYNC_ON_READ_SKIP_WHEN_KOIOS_DEGRADED) {
    const pressure = getKoiosPressureState();
    if (pressure.active) {
      console.log(
        `[Sync-on-Read] action=skip trigger=${trigger} identifier=${identifier ?? "n/a"} reason=koios-degraded cooldownRemainingMs=${pressure.remainingMs} observedErrors=${pressure.observedErrors}/${pressure.threshold} windowMs=${pressure.windowMs}`
      );
      return "koios-degraded";
    }
  }

  return null;
}

const proposalSnapshotSelect = {
  proposalId: true,
  status: true,
  drepActiveYesVotePower: true,
  drepActiveNoVotePower: true,
  drepActiveAbstainVotePower: true,
  spoActiveYesVotePower: true,
  spoActiveNoVotePower: true,
  spoActiveAbstainVotePower: true,
} as const;

function parseProposalIdentifier(
  identifier: string
): ParsedProposalIdentifier | null {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith(GOV_ACTION_IDENTIFIER_PREFIX)) {
    return {
      raw: identifier,
      normalized: trimmed,
      kind: "proposalId",
      proposalId: trimmed,
    };
  }

  if (NUMERIC_ID_REGEX.test(trimmed)) {
    return {
      raw: identifier,
      normalized: trimmed,
      kind: "numericId",
      numericId: Number.parseInt(trimmed, 10),
    };
  }

  if (trimmed.includes(":")) {
    const [rawHash, rawIndex] = trimmed.split(":");
    const txHash = rawHash?.trim().toLowerCase();
    const certIndex = rawIndex?.trim();
    if (!txHash || !certIndex || !TX_HASH_REGEX.test(txHash) || !NUMERIC_ID_REGEX.test(certIndex)) {
      return null;
    }

    return {
      raw: identifier,
      normalized: `${txHash}:${certIndex}`,
      kind: "txHashAndIndex",
      txHash,
      certIndex,
    };
  }

  const txHash = trimmed.toLowerCase();
  if (!TX_HASH_REGEX.test(txHash)) {
    return null;
  }

  return {
    raw: identifier,
    normalized: txHash,
    kind: "txHash",
    txHash,
  };
}

async function resolveProposalSyncTarget(
  identifier: string
): Promise<ResolvedProposalSyncTarget | null> {
  const parsed = parseProposalIdentifier(identifier);
  if (!parsed) {
    return null;
  }

  const aliasedProposalId =
    parsed.kind === "proposalId"
      ? parsed.proposalId
      : proposalIdentifierAliases.get(parsed.normalized);

  if (aliasedProposalId) {
    const dbProposal = await prisma.proposal.findUnique({
      where: { proposalId: aliasedProposalId },
      select: proposalSnapshotSelect,
    });
    return {
      raw: parsed.raw,
      kind: parsed.kind,
      canonicalKey: aliasedProposalId,
      guardKey: aliasedProposalId,
      proposalId: aliasedProposalId,
      dbProposal,
      txHash: parsed.txHash,
      certIndex: parsed.certIndex,
    };
  }

  if (parsed.kind === "proposalId") {
    const dbProposal = await prisma.proposal.findUnique({
      where: { proposalId: parsed.proposalId! },
      select: proposalSnapshotSelect,
    });
    return {
      raw: parsed.raw,
      kind: parsed.kind,
      canonicalKey: parsed.proposalId!,
      guardKey: parsed.proposalId!,
      proposalId: parsed.proposalId!,
      dbProposal,
    };
  }

  if (parsed.kind === "numericId") {
    const dbProposal = await prisma.proposal.findUnique({
      where: { id: parsed.numericId! },
      select: proposalSnapshotSelect,
    });
    return {
      raw: parsed.raw,
      kind: parsed.kind,
      canonicalKey: dbProposal?.proposalId ?? `db-id:${parsed.numericId}`,
      guardKey: dbProposal?.proposalId ?? `db-id:${parsed.numericId}`,
      proposalId: dbProposal?.proposalId,
      dbProposal,
    };
  }

  if (parsed.kind === "txHashAndIndex") {
    const dbProposal = await prisma.proposal.findFirst({
      where: {
        txHash: parsed.txHash,
        certIndex: parsed.certIndex,
      },
      select: proposalSnapshotSelect,
    });
    return {
      raw: parsed.raw,
      kind: parsed.kind,
      canonicalKey: dbProposal?.proposalId ?? parsed.normalized,
      guardKey: dbProposal?.proposalId ?? parsed.normalized,
      proposalId: dbProposal?.proposalId,
      dbProposal,
      txHash: parsed.txHash,
      certIndex: parsed.certIndex,
    };
  }

  const dbProposal = await prisma.proposal.findFirst({
    where: { txHash: parsed.txHash },
    select: proposalSnapshotSelect,
  });
  return {
    raw: parsed.raw,
    kind: parsed.kind,
    canonicalKey: dbProposal?.proposalId ?? parsed.normalized,
    guardKey: dbProposal?.proposalId ?? parsed.normalized,
    proposalId: dbProposal?.proposalId,
    dbProposal,
    txHash: parsed.txHash,
  };
}

function pruneProposalSyncCooldowns(now: number): void {
  for (const [key, lastSyncTime] of proposalSyncTimes) {
    if (now - lastSyncTime >= PROPOSAL_SYNC_COOLDOWN_MS) {
      proposalSyncTimes.delete(key);
    }
  }

  while (proposalSyncTimes.size > MAX_TRACKED_PROPOSAL_SYNC_KEYS) {
    const oldestKey = proposalSyncTimes.keys().next().value;
    if (!oldestKey) {
      break;
    }
    proposalSyncTimes.delete(oldestKey);
    console.log(
      `[Sync-on-Read] action=evict reason=proposal-cooldown-cap identifier=${oldestKey}`
    );
  }
}

function pruneProposalIdentifierAliases(): void {
  while (proposalIdentifierAliases.size > MAX_TRACKED_PROPOSAL_IDENTIFIER_ALIASES) {
    const oldestAlias = proposalIdentifierAliases.keys().next().value;
    if (!oldestAlias) {
      break;
    }
    proposalIdentifierAliases.delete(oldestAlias);
    console.log(
      `[Sync-on-Read] action=evict reason=identifier-alias-cap alias=${oldestAlias}`
    );
  }
}

function rememberProposalIdentifierAlias(
  alias: string | undefined,
  proposalId: string
): void {
  if (!alias || alias === proposalId) {
    return;
  }

  proposalIdentifierAliases.set(alias, proposalId);
  pruneProposalIdentifierAliases();
}

function rememberProposalAliases(proposal: KoiosProposal): void {
  rememberProposalIdentifierAlias(proposal.proposal_id, proposal.proposal_id);
  rememberProposalIdentifierAlias(
    proposal.proposal_tx_hash?.toLowerCase(),
    proposal.proposal_id
  );
  rememberProposalIdentifierAlias(
    `${proposal.proposal_tx_hash?.toLowerCase()}:${String(proposal.proposal_index)}`,
    proposal.proposal_id
  );
}

function getProposalGuardJobName(proposalId: string): string {
  return `${PROPOSAL_SYNC_ON_READ_GUARD_PREFIX}${proposalId}`;
}

async function tryAcquireProposalGuard(
  guardKey: string,
  source: string
): Promise<boolean> {
  const now = new Date();
  const jobName = getProposalGuardJobName(guardKey);
  return prisma.$transaction(async (tx) => {
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
        errorMessage: "Sync-on-read proposal guard lock expired",
      },
    });

    const status = await tx.syncStatus.findUnique({
      where: { jobName },
      select: { isRunning: true },
    });
    if (status?.isRunning) return false;

    await tx.syncStatus.upsert({
      where: { jobName },
      create: {
        jobName,
        displayName: "Sync-on-Read Proposal Guard",
        isRunning: true,
        startedAt: now,
        expiresAt: new Date(now.getTime() + PROPOSAL_SYNC_ON_READ_GUARD_TTL_MS),
        lockedBy: process.env.HOSTNAME || source,
      },
      update: {
        isRunning: true,
        startedAt: now,
        completedAt: null,
        expiresAt: new Date(now.getTime() + PROPOSAL_SYNC_ON_READ_GUARD_TTL_MS),
        lockedBy: process.env.HOSTNAME || source,
        errorMessage: null,
      },
    });

    return true;
  });
}

async function releaseProposalGuard(
  guardKey: string,
  status: "success" | "failed",
  errorMessage?: string
): Promise<void> {
  try {
    await prisma.syncStatus.update({
      where: { jobName: getProposalGuardJobName(guardKey) },
      data: {
        isRunning: false,
        completedAt: new Date(),
        expiresAt: null,
        lastResult: status,
        errorMessage: errorMessage ?? null,
      },
    });
  } catch (error: any) {
    console.warn(
      `[Sync-on-Read] action=non-retryable reason=proposal-guard-release-failed guardKey=${guardKey} message=${error?.message ?? String(error)}`
    );
  }
}

async function withProposalGuard<T>(
  guardKey: string,
  source: string,
  operation: () => Promise<T>
): Promise<{ executed: boolean; value?: T }> {
  const acquired = await tryAcquireProposalGuard(guardKey, source);
  if (!acquired) {
    console.log(
      `[Sync-on-Read] action=skip reason=proposal-guard-locked guardKey=${guardKey} source=${source}`
    );
    return { executed: false };
  }

  try {
    const value = await operation();
    await releaseProposalGuard(guardKey, "success");
    return { executed: true, value };
  } catch (error: any) {
    await releaseProposalGuard(
      guardKey,
      "failed",
      error?.message ?? "Unknown error"
    );
    throw error;
  }
}

async function getInteractiveProposalList(source: string): Promise<KoiosProposal[]> {
  return getKoiosProposalList({
    context: { source },
    interactiveCache: true,
  });
}

function findKoiosProposalForTarget(
  proposals: KoiosProposal[],
  target: ResolvedProposalSyncTarget
): KoiosProposal | undefined {
  if (target.kind === "proposalId" && target.proposalId) {
    return proposals.find((proposal) => proposal.proposal_id === target.proposalId);
  }

  if (target.kind === "txHashAndIndex" && target.txHash && target.certIndex) {
    return proposals.find(
      (proposal) =>
        proposal.proposal_tx_hash === target.txHash &&
        String(proposal.proposal_index) === target.certIndex
    );
  }

  if (target.txHash) {
    return proposals.find((proposal) => proposal.proposal_tx_hash === target.txHash);
  }

  return undefined;
}

/**
 * Syncs the proposals overview on read (BACKGROUND/NON-BLOCKING).
 * Called before returning the proposals list to trigger a background sync.
 *
 * This function returns immediately and runs the sync in the background,
 * so the API response is not delayed.
 *
 * This function:
 * 1. Checks if cooldown has elapsed since last sync
 * 2. If not in cooldown, triggers background sync
 * 3. Background sync compares Koios proposal count with DB count
 * 4. If there are new proposals, ingests them in the background
 */
export function syncProposalsOverviewOnRead(): void {
  void maybeStartOverviewSync();
}

async function maybeStartOverviewSync(): Promise<void> {
  const now = Date.now();

  // Check if sync is already in progress
  if (isOverviewSyncInProgress) {
    console.log(
      "[Sync-on-Read] action=skip trigger=overview reason=local-inflight"
    );
    return;
  }

  // Check cooldown
  if (now - lastOverviewSyncTime < OVERVIEW_SYNC_COOLDOWN_MS) {
    console.log(
      `[Sync-on-Read] action=skip trigger=overview reason=cooldown remainingMs=${OVERVIEW_SYNC_COOLDOWN_MS - (now - lastOverviewSyncTime)}`
    );
    return;
  }

  // Reserve the in-flight slot before any awaited checks so concurrent requests
  // in the same tick don't both pass the guard and launch duplicate syncs.
  isOverviewSyncInProgress = true;
  const skipReason = await getSyncOnReadSkipReason("overview");
  if (skipReason) {
    isOverviewSyncInProgress = false;
    return;
  }

  lastOverviewSyncTime = now;

  // Run sync in background (non-blocking) - don't await
  doOverviewSync()
    .catch((error) => {
      console.error(
        "[Sync-on-Read] Background overview sync failed:",
        error.message
      );
    })
    .finally(() => {
      isOverviewSyncInProgress = false;
    });
}

/**
 * Internal function that performs the actual overview sync
 */
async function doOverviewSync(): Promise<void> {
  console.log("[Sync-on-Read] Starting background overview sync...");

  const acquired = await tryAcquireProposalSyncLock("sync-on-read.overview", {
    ttlMs: SYNC_ON_READ_OVERVIEW_LOCK_TTL_MS,
  });
  if (!acquired) {
    console.log(
      "[Sync-on-Read] action=skip trigger=overview reason=proposal-sync-lock-busy"
    );
    return;
  }

  let itemsProcessed = 0;
  let partialFailures = 0;
  let guardSkips = 0;
  let topLevelError: string | undefined;

  try {
    // Get counts from DB and Koios in parallel
    const [dbCount, koiosProposals] = await Promise.all([
      prisma.proposal.count(),
      getInteractiveProposalList("sync-on-read.overview.proposal-list"),
    ]);

    if (!koiosProposals || koiosProposals.length === 0) {
      console.log("[Sync-on-Read] No proposals from Koios");
      return;
    }

    const koiosCount = koiosProposals.length;
    console.log(
      `[Sync-on-Read] DB has ${dbCount} proposals, Koios has ${koiosCount}`
    );

    // If Koios has more proposals, find and ingest the new ones
    if (koiosCount > dbCount) {
      const existingProposals = await prisma.proposal.findMany({
        select: { proposalId: true },
      });
      const existingIds = new Set(existingProposals.map((p) => p.proposalId));

      const newProposals = koiosProposals.filter(
        (p) => !existingIds.has(p.proposal_id)
      );

      console.log(
        `[Sync-on-Read] Found ${newProposals.length} new proposals to ingest`
      );

      const currentEpoch = await getCurrentEpoch();

      for (const proposal of newProposals) {
        try {
          const guarded = await withProposalGuard(
            proposal.proposal_id,
            "sync-on-read.overview",
            () =>
              ingestProposalData(proposal, {
                currentEpoch,
                minVotesEpoch: proposal.proposed_epoch,
                useCache: false,
                deferExpiredStatus: true,
              })
          );
          if (!guarded.executed || !guarded.value) {
            guardSkips++;
            console.log(
              `[Sync-on-Read] action=skip trigger=overview proposalId=${proposal.proposal_id} reason=proposal-guard-locked`
            );
            continue;
          }

          itemsProcessed++;
          await finalizeProposalStatusAfterVoteSync(guarded.value, "[Sync-on-Read]");
          if (!guarded.value.success) {
            partialFailures++;
            console.warn(
              `[Sync-on-Read] action=partial-failure trigger=overview proposalId=${proposal.proposal_id}`
            );
            continue;
          }
          console.log(
            `[Sync-on-Read] ✓ Ingested new proposal ${proposal.proposal_tx_hash}`
          );
        } catch (error: any) {
          console.error(
            `[Sync-on-Read] ✗ Failed to ingest proposal ${proposal.proposal_tx_hash}:`,
            error.message
          );
        }
      }
    } else {
      console.log("[Sync-on-Read] No new proposals to sync");
    }
    console.log(
      `[Sync-on-Read] Overview summary itemsProcessed=${itemsProcessed} partialFailures=${partialFailures} guardSkips=${guardSkips}`
    );
  } catch (error: any) {
    topLevelError = error?.message ?? String(error);
    throw error;
  } finally {
    try {
      await releaseProposalSyncLock({
        status: topLevelError ? "failed" : "success",
        errorMessage: topLevelError,
        itemsProcessed,
      });
    } catch (releaseError: any) {
      console.warn(
        `[Sync-on-Read] action=non-retryable reason=overview-lock-release-failed message=${releaseError?.message ?? String(releaseError)}`
      );
    }
  }
}

/**
 * Syncs a specific proposal's details on read (BACKGROUND/NON-BLOCKING).
 * Called before returning proposal details to trigger a background sync.
 *
 * This function returns immediately and runs the sync in the background,
 * so the API response is not delayed.
 *
 * This function:
 * 1. Checks if cooldown has elapsed for this proposal
 * 2. If not in cooldown, triggers background sync
 * 3. Background sync fetches latest voting summary from Koios
 * 4. Compares vote counts - if different, re-ingests the proposal
 *
 * @param identifier - Proposal identifier (proposalId, txHash, txHash:certIndex, or numeric id)
 */
export function syncProposalDetailsOnRead(identifier: string): void {
  void maybeStartProposalSync(identifier);
}

async function maybeStartProposalSync(identifier: string): Promise<void> {
  const now = Date.now();
  const target = await resolveProposalSyncTarget(identifier);

  if (!target) {
    console.log(
      `[Sync-on-Read] action=skip trigger=proposal identifier=${identifier} reason=invalid-identifier`
    );
    return;
  }

  if (target.raw.trim() !== target.canonicalKey) {
    console.log(
      `[Sync-on-Read] action=canonicalize raw=${target.raw.trim()} canonical=${target.canonicalKey}`
    );
  }

  pruneProposalSyncCooldowns(now);

  // Check if sync is already in progress for this proposal
  if (proposalSyncsInProgress.has(target.canonicalKey)) {
    console.log(
      `[Sync-on-Read] action=skip trigger=proposal identifier=${target.canonicalKey} reason=local-inflight`
    );
    return;
  }

  // Check cooldown for this specific proposal
  const lastSyncTime = proposalSyncTimes.get(target.canonicalKey) || 0;
  if (now - lastSyncTime < PROPOSAL_SYNC_COOLDOWN_MS) {
    console.log(
      `[Sync-on-Read] action=skip trigger=proposal identifier=${target.canonicalKey} reason=cooldown remainingMs=${PROPOSAL_SYNC_COOLDOWN_MS - (now - lastSyncTime)}`
    );
    return;
  }

  // Reserve in-process guard before awaiting skip checks to avoid
  // duplicate launches for the same identifier in concurrent requests.
  proposalSyncsInProgress.add(target.canonicalKey);
  const skipReason = await getSyncOnReadSkipReason("proposal", target.canonicalKey);
  if (skipReason) {
    proposalSyncsInProgress.delete(target.canonicalKey);
    return;
  }

  proposalSyncTimes.set(target.canonicalKey, now);
  pruneProposalSyncCooldowns(now);

  // Run sync in background (non-blocking) - don't await
  doProposalSync(target)
    .catch((error) => {
      console.error(
        `[Sync-on-Read] Background sync failed for ${target.canonicalKey}:`,
        error.message
      );
    })
    .finally(() => {
      proposalSyncsInProgress.delete(target.canonicalKey);
    });
}

/**
 * Internal function that performs the actual proposal sync
 */
async function doProposalSync(target: ResolvedProposalSyncTarget): Promise<void> {
  console.log(
    `[Sync-on-Read] Starting background sync for proposal ${target.canonicalKey} (raw=${target.raw})...`
  );

  const guarded = await withProposalGuard(
    target.guardKey,
    "sync-on-read.details",
    async () => {
      const dbProposal = target.dbProposal;

      if (!dbProposal) {
        console.log(
          `[Sync-on-Read] Proposal ${target.raw} not in DB, checking Koios...`
        );
        await tryIngestNewProposal(target);
        return;
      }

      if (dbProposal.status !== ProposalStatus.ACTIVE) {
        console.log(
          `[Sync-on-Read] Proposal ${target.canonicalKey} is ${dbProposal.status}, skipping sync`
        );
        return;
      }

      const koiosVotes = await fetchVotesForProposal(dbProposal.proposalId);
      const koiosVoteCount = koiosVotes.length;

      const dbVoteCount = await prisma.onchainVote.count({
        where: { proposalId: dbProposal.proposalId },
      });

      console.log(
        `[Sync-on-Read] Vote count proposalId=${dbProposal.proposalId} db=${dbVoteCount} koios=${koiosVoteCount}`
      );

      const hasVoteCountChange = koiosVoteCount !== dbVoteCount;

      const koiosSummary = await koiosGet<KoiosProposalVotingSummary[]>(
        `/proposal_voting_summary?_proposal_id=${dbProposal.proposalId}`,
        undefined,
        {
          source: "sync-on-read.details.voting-summary",
        }
      );

      let hasVotingPowerChange = false;
      if (koiosSummary && koiosSummary.length > 0) {
        const summary = koiosSummary[0];

        const koiosDrepYes = BigInt(summary.drep_active_yes_vote_power || "0");
        const koiosDrepNo = BigInt(summary.drep_active_no_vote_power || "0");
        const koiosDrepAbstain = BigInt(
          summary.drep_active_abstain_vote_power || "0"
        );
        const koiosSpoYes = BigInt(summary.pool_active_yes_vote_power || "0");
        const koiosSpoNo = BigInt(summary.pool_active_no_vote_power || "0");
        const koiosSpoAbstain = BigInt(
          summary.pool_active_abstain_vote_power || "0"
        );

        const dbDrepYes = dbProposal.drepActiveYesVotePower || BigInt(0);
        const dbDrepNo = dbProposal.drepActiveNoVotePower || BigInt(0);
        const dbDrepAbstain =
          dbProposal.drepActiveAbstainVotePower || BigInt(0);
        const dbSpoYes = dbProposal.spoActiveYesVotePower || BigInt(0);
        const dbSpoNo = dbProposal.spoActiveNoVotePower || BigInt(0);
        const dbSpoAbstain =
          dbProposal.spoActiveAbstainVotePower || BigInt(0);

        const hasDrepChanges =
          koiosDrepYes !== dbDrepYes ||
          koiosDrepNo !== dbDrepNo ||
          koiosDrepAbstain !== dbDrepAbstain;
        const hasSpoChanges =
          koiosSpoYes !== dbSpoYes ||
          koiosSpoNo !== dbSpoNo ||
          koiosSpoAbstain !== dbSpoAbstain;

        hasVotingPowerChange = hasDrepChanges || hasSpoChanges;

        if (hasVotingPowerChange) {
          console.log(
            `[Sync-on-Read] Voting power differences detected for ${dbProposal.proposalId}`
          );
        }
      }

      if (!hasVoteCountChange && !hasVotingPowerChange) {
        console.log(`[Sync-on-Read] No changes for ${dbProposal.proposalId}`);
        return;
      }

      console.log(
        `[Sync-on-Read] Changes detected for ${dbProposal.proposalId}: voteCount=${hasVoteCountChange}, votingPower=${hasVotingPowerChange}`
      );

      const koiosProposals = await getInteractiveProposalList(
        "sync-on-read.details.proposal-list"
      );
      const koiosProposal = findKoiosProposalForTarget(koiosProposals, {
        ...target,
        proposalId: dbProposal.proposalId,
        canonicalKey: dbProposal.proposalId,
        guardKey: dbProposal.proposalId,
      });

      if (!koiosProposal) {
        console.warn(
          `[Sync-on-Read] action=skip trigger=proposal proposalId=${dbProposal.proposalId} reason=proposal-missing-from-koios`
        );
        return;
      }

      const result = await ingestProposalData(koiosProposal, {
        minVotesEpoch: koiosProposal.proposed_epoch,
        useCache: false,
        deferExpiredStatus: true,
      });

      const finalized = await finalizeProposalStatusAfterVoteSync(
        result,
        "[Sync-on-Read]"
      );

      if (!result.success) {
        console.warn(
          `[Sync-on-Read] action=partial-failure trigger=proposal proposalId=${dbProposal.proposalId}`
        );
        return;
      }

      if (finalized.proposal.status !== result.proposal.status) {
        console.log(
          `[Sync-on-Read] ✓ Re-synced proposal ${dbProposal.proposalId} and updated status to ${finalized.proposal.status}`
        );
      } else {
        console.log(
          `[Sync-on-Read] ✓ Re-synced proposal ${dbProposal.proposalId}`
        );
      }
    }
  );

  if (!guarded.executed) {
    console.log(
      `[Sync-on-Read] action=skip trigger=proposal identifier=${target.guardKey} reason=proposal-guard-locked`
    );
  }
}

/**
 * Fetches all votes for a specific proposal from Koios
 * Used for vote count comparison
 */
async function fetchVotesForProposal(
  proposalId: string
): Promise<Array<{ vote_tx_hash: string }>> {
  const votes: Array<{ vote_tx_hash: string }> = [];
  let offset = 0;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const batch = await koiosGet<Array<{ vote_tx_hash: string }>>(
      "/vote_list",
      {
        proposal_id: `eq.${proposalId}`,
        limit,
        offset,
        // Stable ordering is important for offset-based pagination.
        order: "block_time.asc,vote_tx_hash.asc",
      },
      {
        source: "sync-on-read.details.vote-list",
      }
    );

    if (!batch || batch.length === 0) {
      hasMore = false;
    } else {
      votes.push(...batch);
      offset += batch.length;
      if (batch.length < limit) {
        hasMore = false;
      }
    }
  }

  return votes;
}

/**
 * Helper to try ingesting a new proposal by a canonicalized identifier
 */
async function tryIngestNewProposal(
  target: ResolvedProposalSyncTarget
): Promise<void> {
  try {
    if (target.kind === "numericId") {
      console.log(
        `[Sync-on-Read] action=skip trigger=proposal identifier=${target.raw} reason=numeric-id-not-discoverable`
      );
      return;
    }

    const koiosProposals = await getInteractiveProposalList(
      "sync-on-read.discovery.proposal-list"
    );
    if (!koiosProposals) return;

    const koiosProposal = findKoiosProposalForTarget(koiosProposals, target);

    if (koiosProposal) {
      const proposalToIngest = koiosProposal;
      rememberProposalAliases(proposalToIngest);

      const ingestOnce = async () => {
        const result = await ingestProposalData(proposalToIngest, {
          minVotesEpoch: proposalToIngest.proposed_epoch,
          useCache: false,
          deferExpiredStatus: true,
        });
        await finalizeProposalStatusAfterVoteSync(result, "[Sync-on-Read]");
        if (!result.success) {
          console.warn(
            `[Sync-on-Read] action=partial-failure trigger=proposal proposalId=${proposalToIngest.proposal_id}`
          );
          return;
        }
        console.log(
          `[Sync-on-Read] ✓ Ingested new proposal ${proposalToIngest.proposal_tx_hash}`
        );
      };

      if (target.guardKey !== proposalToIngest.proposal_id) {
        console.log(
          `[Sync-on-Read] action=canonicalize raw=${target.guardKey} canonical=${proposalToIngest.proposal_id} reason=koios-discovery`
        );
        const canonicalGuarded = await withProposalGuard(
          proposalToIngest.proposal_id,
          "sync-on-read.try-ingest-new.canonical",
          ingestOnce
        );
        if (!canonicalGuarded.executed) {
          console.log(
            `[Sync-on-Read] action=skip trigger=proposal identifier=${proposalToIngest.proposal_id} reason=proposal-guard-locked-after-discovery`
          );
        }
        return;
      }

      await ingestOnce();
    } else {
      console.log(`[Sync-on-Read] Proposal ${target.raw} not found in Koios`);
    }
  } catch (error: any) {
    console.error(
      `[Sync-on-Read] Failed to ingest new proposal ${target.raw}:`,
      error.message
    );
  }
}
