/**
 * Vote Ingestion Service
 * Handles ingestion of onchain votes for proposals
 */

import { VoteType, VoterType } from "@prisma/client";
import { prisma } from "../prisma";
import { getKoiosPressureState } from "../koios";
import { listVotes } from "../governanceProvider";
import { fetchJsonWithBrowserLikeClient } from "../remoteMetadata.service";
import { fetchTxMetadataByHash } from "../txMetadata.service";
import {
  ensureVoterExists,
  preloadVotersForVotes,
  type EnsureVoterResult,
  type VoteVoterRef,
} from "./voterIngestion.service";
import {
  recordDbFailureForFailFast,
  shouldFailFastForDb,
} from "./dbFailFast";
import type { KoiosVote } from "../../types/koios.types";
import {
  extractSurveyResponse,
} from "../../libs/surveyMetadata";
import type { IngestionDbClient } from "./dbSession";
import { withIngestionDbRead, withIngestionDbWrite } from "./dbSession";

// Cache for vote metadata JSON keyed by anchor URL to avoid duplicate fetches
const voteMetadataCache = new Map<string, string | null>();
const voteTxMetadataCache = new Map<string, Record<string, unknown> | Array<Record<string, unknown>> | null>();

export interface VoteIngestionRunCache {
  proposalVotes: Map<string, KoiosVote[]>;
  proposalVotesInFlight: Map<string, Promise<VoteIngestionResult>>;
}

export function createVoteIngestionRunCache(): VoteIngestionRunCache {
  return {
    proposalVotes: new Map(),
    proposalVotesInFlight: new Map(),
  };
}

/**
 * Fetches and serialises vote metadata JSON for a Koios vote.
 *
 * Preference order:
 * 1. Use meta_json from Koios response when available (no extra HTTP).
 * 2. Otherwise, fetch from meta_url / anchor_url, with IPFS gateway support.
 *
 * Returns the JSON as a string suitable for storing in Prisma String column,
 * or null if nothing could be fetched.
 */
async function getVoteRationaleJson(koiosVote: KoiosVote): Promise<string | null> {
  // 1) Prefer inline meta_json from Koios if present
  if (koiosVote.meta_json) {
    try {
      return JSON.stringify(koiosVote.meta_json);
    } catch (error: any) {
      console.warn(
        `[Vote Metadata] Failed to serialise meta_json for vote ${koiosVote.vote_tx_hash}:`,
        error?.message ?? error
      );
      // Fall through to URL-based fetch as a fallback
    }
  }

  // 2) Fallback to fetching from meta_url / anchor_url
  const rawUrl = koiosVote.meta_url;
  if (!rawUrl) {
    return null;
  }

  // Return from cache if we've already attempted this URL
  const cached = voteMetadataCache.get(rawUrl);
  if (cached !== undefined) {
    return cached;
  }

  let fetchUrl = rawUrl;

  // Handle ipfs:// URLs by routing through a public HTTP gateway
  if (fetchUrl.startsWith("ipfs://")) {
    const ipfsHash = fetchUrl.replace("ipfs://", "");
    fetchUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
    console.log(`[Vote Metadata] Converting IPFS URL to gateway: ${fetchUrl}`);
  }

  try {
    // Use the shared browser-like JSON fetcher which:
    // 1) Attempts a normal Axios HTTP GET first
    // 2) Falls back to Puppeteer for providers that block plain HTTP clients
    const meta = await fetchJsonWithBrowserLikeClient(fetchUrl);

    if (!meta) {
      voteMetadataCache.set(rawUrl, null);
      return null;
    }

    const jsonString = JSON.stringify(meta);
    voteMetadataCache.set(rawUrl, jsonString);
    return jsonString;
  } catch (error: any) {
    const message =
      error?.message ??
      (typeof error?.toString === "function" ? error.toString() : String(error));

    console.warn(
      `[Vote Metadata] Failed to fetch vote metadata (with Puppeteer fallback) from ${rawUrl}`,
      message
    );
    voteMetadataCache.set(rawUrl, null);
    return null;
  }
}

/**
 * Statistics for vote ingestion
 */
export interface VoteIngestionStats {
  /**
   * Legacy name kept for log/parser compatibility.
   * Represents idempotent upsert writes, not guaranteed inserts.
   */
  votesIngested: number;
  /**
   * Canonical write counter for proposal vote ingestion.
   * Every processed vote write currently uses an upsert path.
   */
  votesUpserted: number;
  /**
   * Legacy placeholder retained for compatibility with existing call sites.
   */
  votesUpdated: number;
  votesProcessed: number;
  votersCreated: { dreps: number; spos: number; ccs: number };
  votersUpdated: { dreps: number; spos: number; ccs: number };
  metadata: {
    attempts: number;
    success: number;
    failed: number;
    skipped: number;
  };
}

export interface VoteIngestionResult {
  success: boolean;
  stats: VoteIngestionStats;
  error?: string;
}

export interface VoteIngestionOptions {
  useCache?: boolean;
  runCache?: VoteIngestionRunCache;
  fetchSurveyMetadata?: boolean;
  prefetchedVotes?: KoiosVote[];
}

function getBoundedIntEnvLocal(
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

const VOTE_INGEST_USE_PREFETCHED =
  process.env.VOTE_INGEST_USE_PREFETCHED !== "false";
const VOTE_INGEST_DB_CONCURRENCY = getBoundedIntEnvLocal(
  "VOTE_INGEST_DB_CONCURRENCY",
  4,
  1,
  20
);
const VOTE_INGEST_PAGE_SIZE = 1000;
const VOTE_INGEST_CHECKPOINT_JOB_PREFIX = "vote-ingest-window";
const VOTE_INGEST_OVERLAP_SECONDS = 900;

interface VoteCursor {
  blockTime: number;
  voteTxHash: string;
}

interface VoteIngestionCheckpoint {
  proposalId: string;
  minEpoch: number | null;
  nextOffset: number;
  cursor: VoteCursor | null;
  phase: "pass1" | "pass2";
  pass2MinBlockTime: number | null;
  pass2Offset: number;
  processedVotes: number;
  updatedAt: string;
}

function getVoteIngestionJobName(proposalId: string): string {
  return `${VOTE_INGEST_CHECKPOINT_JOB_PREFIX}:${proposalId}`;
}

function parseCheckpoint(raw: string | null | undefined): VoteIngestionCheckpoint | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VoteIngestionCheckpoint>;
    if (
      typeof parsed?.proposalId === "string" &&
      typeof parsed?.nextOffset === "number" &&
      typeof parsed?.processedVotes === "number"
    ) {
      return {
        proposalId: parsed.proposalId,
        minEpoch:
          typeof parsed.minEpoch === "number" ? parsed.minEpoch : null,
        nextOffset: parsed.nextOffset,
        cursor:
          parsed.cursor &&
          typeof parsed.cursor === "object" &&
          typeof (parsed.cursor as VoteCursor).blockTime === "number" &&
          typeof (parsed.cursor as VoteCursor).voteTxHash === "string"
            ? (parsed.cursor as VoteCursor)
            : null,
        phase: parsed.phase === "pass2" ? "pass2" : "pass1",
        pass2MinBlockTime:
          typeof parsed.pass2MinBlockTime === "number"
            ? parsed.pass2MinBlockTime
            : null,
        pass2Offset:
          typeof parsed.pass2Offset === "number" ? parsed.pass2Offset : 0,
        processedVotes: parsed.processedVotes,
        updatedAt:
          typeof parsed.updatedAt === "string"
            ? parsed.updatedAt
            : new Date().toISOString(),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Clears the vote cache - should be called at the start of each sync
 */
export function clearVoteCache() {
  voteMetadataCache.clear();
  voteTxMetadataCache.clear();
}

/**
 * Ingests all votes for a specific proposal
 *
 * @param proposalId - Cardano governance action ID (proposal_id from Koios)
 * @param db - Prisma DB client (autocommit or transaction)
 * @param minEpoch - Optional minimum epoch to fetch votes from (inclusive).
 *                   Used to avoid fetching historical votes that cannot belong
 *                   to the proposals we are currently syncing.
 * @param options - Optional flags:
 *                  - useCache: when true (default), we fetch all votes once
 *                    and keep them in memory for the duration of a bulk sync.
 *                    When false, we query Koios just for this proposal and do
 *                    not touch the global cache. This is ideal for sync-on-read.
 * @returns Statistics about votes and voters created/updated
 */
export async function ingestVotesForProposal(
  proposalId: string,
  db: IngestionDbClient,
  minEpoch?: number,
  options?: VoteIngestionOptions
): Promise<VoteIngestionResult> {
  if (shouldFailFastForDb("ingestion.vote.ingest")) {
    return {
      success: false,
      stats: {
        votesIngested: 0,
        votesUpserted: 0,
        votesUpdated: 0,
        votesProcessed: 0,
        votersCreated: { dreps: 0, spos: 0, ccs: 0 },
        votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
        metadata: {
          attempts: 0,
          success: 0,
          failed: 0,
          skipped: 0,
        },
      },
      error: "DB fail-fast active; skipping vote ingestion",
    };
  }

  const startedAt = Date.now();
  const stats: VoteIngestionStats = {
    votesIngested: 0,
    votesUpserted: 0,
    votesUpdated: 0,
    votesProcessed: 0,
    votersCreated: { dreps: 0, spos: 0, ccs: 0 },
    votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
    metadata: {
      attempts: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    },
  };

  const useCache = options?.useCache !== false;
  const runCache = options?.runCache;
  const candidatePrefetchedVotes = options?.prefetchedVotes;
  const prefetchedVotes =
    VOTE_INGEST_USE_PREFETCHED && Array.isArray(candidatePrefetchedVotes)
      ? candidatePrefetchedVotes
      : undefined;
  let checkpointState: VoteIngestionCheckpoint = {
    proposalId,
    minEpoch: typeof minEpoch === "number" ? minEpoch : null,
    nextOffset: 0,
    cursor: null,
    phase: "pass1",
    pass2MinBlockTime: null,
    pass2Offset: 0,
    processedVotes: 0,
    updatedAt: new Date().toISOString(),
  };
  const runCacheKey = runCache
    ? getProposalVoteCacheKey(proposalId, minEpoch)
    : null;
  if (runCache && runCacheKey) {
    const inFlight = runCache.proposalVotesInFlight.get(runCacheKey);
    if (inFlight) {
      console.log(
        `[Vote Ingestion] action=single-flight-join proposal=${proposalId}`
      );
      return await inFlight;
    }
  }
  let resolveInFlight:
    | ((result: VoteIngestionResult) => void)
    | undefined;
  const inFlightPromise =
    runCache && runCacheKey
      ? new Promise<VoteIngestionResult>((resolve) => {
          resolveInFlight = resolve;
        })
      : null;
  if (runCache && runCacheKey && inFlightPromise) {
    runCache.proposalVotesInFlight.set(runCacheKey, inFlightPromise);
  }
  const completeResult = (result: VoteIngestionResult): VoteIngestionResult => {
    resolveInFlight?.(result);
    if (runCache && runCacheKey) {
      runCache.proposalVotesInFlight.delete(runCacheKey);
    }
    return result;
  };

  try {
    const proposalSurveyContext = await withIngestionDbRead(
      db,
      `vote.ingest.proposal-context.${proposalId}`,
      () =>
        db.proposal.findUnique({
          where: { proposalId },
          select: { linkedSurveyTxId: true },
        })
    );
    const shouldFetchSurveyMetadata =
      options?.fetchSurveyMetadata !== false &&
      Boolean(proposalSurveyContext?.linkedSurveyTxId) &&
      (process.env.KOIOS_SKIP_TX_METADATA_WHEN_DEGRADED === "false" ||
        !getKoiosPressureState().active);
    if (
      proposalSurveyContext?.linkedSurveyTxId &&
      !shouldFetchSurveyMetadata
    ) {
      console.log(
        `[Vote Ingestion] action=skip proposal=${proposalId} reason=survey-metadata-disabled`
      );
    }

    console.log(
      `[Vote Ingestion] metric=vote_ingest.db_write_concurrency proposal=${proposalId} concurrency=${VOTE_INGEST_DB_CONCURRENCY}`
    );

    let totalVoteRequests = 0;
    let pagesProcessed = 0;
    let totalVotesFetched = 0;

    const processVoteWindow = async (voteWindow: KoiosVote[]) => {
      if (voteWindow.length === 0) return;
      const preloadedVoters = await preloadVotersForVotes(
        extractVoterRefs(voteWindow),
        db
      );

      for (
        let startIndex = 0;
        startIndex < voteWindow.length;
        startIndex += VOTE_INGEST_DB_CONCURRENCY
      ) {
        const batch = voteWindow.slice(
          startIndex,
          startIndex + VOTE_INGEST_DB_CONCURRENCY
        );
        await Promise.all(
          batch.map((koiosVote) =>
            ingestSingleVote(
              koiosVote,
              proposalId,
              db,
              stats,
              shouldFetchSurveyMetadata,
              preloadedVoters
            )
          )
        );
      }
    };

    if (prefetchedVotes) {
      console.log(
        `[Vote Ingestion] metric=vote_ingest.prefetched_votes_used proposal=${proposalId} enabled=true count=${prefetchedVotes.length}`
      );
      pagesProcessed = prefetchedVotes.length > 0 ? 1 : 0;
      totalVotesFetched = prefetchedVotes.length;
      await processVoteWindow(prefetchedVotes);
    } else {
      if (useCache && !runCache) {
        console.warn(
          `[Vote Ingestion] action=proposal-cache-missing proposal=${proposalId} message=run cache not provided; proceeding with streaming fetch`
        );
      }
      const checkpoint = await loadVoteCheckpoint(db, proposalId, minEpoch);
      checkpointState = checkpoint;
      let cursor = checkpoint.cursor;
      stats.votesProcessed = Math.max(stats.votesProcessed, checkpoint.processedVotes);
      const processedVoteIds = new Set<string>();

      if (checkpoint.nextOffset > 0 || checkpoint.phase === "pass2") {
        console.log(
          `[Vote Ingestion] action=resume proposal=${proposalId} phase=${checkpoint.phase} nextOffset=${checkpoint.nextOffset} pass2Offset=${checkpoint.pass2Offset} processedVotes=${checkpoint.processedVotes} cursorBlockTime=${cursor?.blockTime ?? "none"}`
        );
      }

      let streamPromise: Promise<KoiosVote[]> | null = null;
      let passOneOffset = checkpoint.phase === "pass1" ? checkpoint.nextOffset : 0;
      while (checkpoint.phase === "pass1") {
        totalVoteRequests++;
        streamPromise = fetchVotePage(
          proposalId,
          passOneOffset,
          minEpoch,
          cursor?.blockTime
        );
        const voteWindow = await streamPromise;

        if (!voteWindow || voteWindow.length === 0) break;

        const filteredWindow = voteWindow.filter((vote) =>
          isVoteAfterCursor(vote, cursor)
        );
        const unseenVotes = filteredWindow.filter((vote) => {
          const identity = getKoiosVoteIdentity(proposalId, vote);
          if (processedVoteIds.has(identity)) return false;
          processedVoteIds.add(identity);
          return true;
        });

        pagesProcessed++;
        totalVotesFetched += voteWindow.length;
        await processVoteWindow(unseenVotes);
        passOneOffset += voteWindow.length;
        if (filteredWindow.length > 0) {
          cursor = getKoiosVoteCursor(filteredWindow[filteredWindow.length - 1]!);
        }

        checkpointState = {
          proposalId,
          minEpoch: typeof minEpoch === "number" ? minEpoch : null,
          nextOffset: passOneOffset,
          cursor,
          phase: "pass1",
          pass2MinBlockTime: null,
          pass2Offset: 0,
          processedVotes: stats.votesProcessed,
          updatedAt: new Date().toISOString(),
        };
        await saveVoteCheckpoint(
          db,
          proposalId,
          checkpointState,
          {
            isRunning: true,
            completedAt: null,
            lastResult: "partial",
            errorMessage: null,
          }
        );

        console.log(
          `[Vote Ingestion] action=window-complete proposal=${proposalId} phase=pass1 page=${pagesProcessed} windowSize=${voteWindow.length} effectiveWindowSize=${unseenVotes.length} totalProcessed=${stats.votesProcessed} nextOffset=${passOneOffset} cursorBlockTime=${cursor?.blockTime ?? "none"}`
        );

        if (voteWindow.length < VOTE_INGEST_PAGE_SIZE) break;
      }

      const passTwoMinBlockTime = cursor
        ? Math.max(0, cursor.blockTime - VOTE_INGEST_OVERLAP_SECONDS)
        : null;
      let passTwoOffset =
        checkpoint.phase === "pass2" ? checkpoint.pass2Offset : 0;
      checkpointState = {
        proposalId,
        minEpoch: typeof minEpoch === "number" ? minEpoch : null,
        nextOffset: 0,
        cursor,
        phase: "pass2",
        pass2MinBlockTime:
          checkpoint.phase === "pass2"
            ? checkpoint.pass2MinBlockTime
            : passTwoMinBlockTime,
        pass2Offset: passTwoOffset,
        processedVotes: stats.votesProcessed,
        updatedAt: new Date().toISOString(),
      };

      while (checkpointState.phase === "pass2") {
        totalVoteRequests++;
        streamPromise = fetchVotePage(
          proposalId,
          passTwoOffset,
          minEpoch,
          checkpointState.pass2MinBlockTime ?? undefined
        );
        const voteWindow = await streamPromise;
        if (!voteWindow || voteWindow.length === 0) break;

        const unseenVotes = voteWindow.filter((vote) => {
          const identity = getKoiosVoteIdentity(proposalId, vote);
          if (processedVoteIds.has(identity)) return false;
          processedVoteIds.add(identity);
          return true;
        });

        pagesProcessed++;
        totalVotesFetched += voteWindow.length;
        await processVoteWindow(unseenVotes);
        passTwoOffset += voteWindow.length;

        checkpointState = {
          proposalId,
          minEpoch: typeof minEpoch === "number" ? minEpoch : null,
          nextOffset: 0,
          cursor,
          phase: "pass2",
          pass2MinBlockTime: checkpointState.pass2MinBlockTime,
          pass2Offset: passTwoOffset,
          processedVotes: stats.votesProcessed,
          updatedAt: new Date().toISOString(),
        };
        await saveVoteCheckpoint(
          db,
          proposalId,
          checkpointState,
          {
            isRunning: true,
            completedAt: null,
            lastResult: "partial",
            errorMessage: null,
          }
        );
        console.log(
          `[Vote Ingestion] action=window-complete proposal=${proposalId} phase=pass2 page=${pagesProcessed} windowSize=${voteWindow.length} effectiveWindowSize=${unseenVotes.length} totalProcessed=${stats.votesProcessed} pass2Offset=${passTwoOffset} pass2MinBlockTime=${checkpointState.pass2MinBlockTime ?? "none"}`
        );

        if (voteWindow.length < VOTE_INGEST_PAGE_SIZE) break;
      }

      if (totalVotesFetched === 0) {
        console.log(`[Vote Ingestion] No votes found for proposal ${proposalId}`);
      }
      await markVoteCheckpointComplete(db, proposalId, stats.votesProcessed);
    }

    console.log(
      `[Vote Ingestion] metric=koios.vote_list.requests_per_proposal proposal=${proposalId} source=ingestion.vote.ingest.proposal.vote-list count=${totalVoteRequests} pages=${pagesProcessed}`
    );
  } catch (error: any) {
    recordDbFailureForFailFast(error, "ingestion.vote.ingest");
    // Vote ingestion errors remain non-fatal at this layer so later sync triggers
    // can resume from partial progress without replaying the whole proposal ingest.
    const errorMessage = error?.message ?? String(error);
    console.error(
      `[Vote Ingestion] action=partial-failure proposal=${proposalId} message=${errorMessage}`
    );
    await saveVoteCheckpoint(
      db,
      proposalId,
      {
        ...checkpointState,
        processedVotes: stats.votesProcessed,
        updatedAt: new Date().toISOString(),
      },
      {
        isRunning: false,
        completedAt: null,
        lastResult: "error",
        errorMessage,
      }
    );
    return completeResult({
      success: false,
      stats,
      error: errorMessage,
    });
  }

  console.log(
    `[Vote Ingestion] Summary proposal=${proposalId} success=true durationMs=${Date.now() - startedAt} votesProcessed=${stats.votesProcessed} upserted=${stats.votesUpserted} created=${stats.votesIngested} updated=${stats.votesUpdated} metadataAttempts=${stats.metadata.attempts} metadataSuccess=${stats.metadata.success} metadataFailed=${stats.metadata.failed} metadataSkipped=${stats.metadata.skipped}`
  );
  console.log(
    `[Vote Ingestion] metric=vote_ingest.duration_ms proposal=${proposalId} value=${Date.now() - startedAt}`
  );
  return completeResult({
    success: true,
    stats,
  });
}

function getProposalVoteCacheKey(
  proposalId: string,
  minEpoch?: number
): string {
  return `${proposalId}:${typeof minEpoch === "number" ? minEpoch : "all"}`;
}

function getKoiosVoteCursor(vote: KoiosVote): VoteCursor {
  return {
    blockTime: vote.block_time ?? 0,
    voteTxHash: vote.vote_tx_hash ?? "",
  };
}

function isVoteAfterCursor(vote: KoiosVote, cursor: VoteCursor | null): boolean {
  if (!cursor) return true;
  const voteBlockTime = vote.block_time ?? 0;
  if (voteBlockTime > cursor.blockTime) return true;
  if (voteBlockTime < cursor.blockTime) return false;
  const voteTxHash = vote.vote_tx_hash ?? "";
  return voteTxHash > cursor.voteTxHash;
}

function getKoiosVoteIdentity(proposalId: string, vote: KoiosVote): string {
  const voterType =
    vote.voter_role === "DRep"
      ? VoterType.DREP
      : vote.voter_role === "SPO"
      ? VoterType.SPO
      : VoterType.CC;
  const voterKey = vote.voter_id ?? "unknown";
  return `${vote.vote_tx_hash}:${proposalId}:${voterType}:${voterKey}`;
}

async function loadVoteCheckpoint(
  db: IngestionDbClient,
  proposalId: string,
  minEpoch: number | undefined
): Promise<VoteIngestionCheckpoint> {
  const jobName = getVoteIngestionJobName(proposalId);
  const existingStatus = await withIngestionDbRead(
    db,
    `vote-checkpoint.load.${proposalId}`,
    () =>
      db.syncStatus.findUnique({
        where: { jobName },
      })
  );
  const parsed = parseCheckpoint(existingStatus?.backfillCursor ?? null);
  if (
    parsed &&
    parsed.proposalId === proposalId &&
    parsed.minEpoch === (typeof minEpoch === "number" ? minEpoch : null)
  ) {
    return parsed;
  }
  return {
    proposalId,
    minEpoch: typeof minEpoch === "number" ? minEpoch : null,
    nextOffset: 0,
    cursor: null,
    phase: "pass1",
    pass2MinBlockTime: null,
    pass2Offset: 0,
    processedVotes: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function saveVoteCheckpoint(
  db: IngestionDbClient,
  proposalId: string,
  checkpoint: VoteIngestionCheckpoint,
  extras?: {
    isRunning?: boolean;
    completedAt?: Date | null;
    lastResult?: "success" | "partial" | "error";
    errorMessage?: string | null;
  }
): Promise<void> {
  const now = new Date();
  const jobName = getVoteIngestionJobName(proposalId);
  await withIngestionDbWrite(db, `vote-checkpoint.save.${proposalId}`, () =>
    db.syncStatus.upsert({
      where: { jobName },
      create: {
        jobName,
        displayName: `Vote Ingestion Window ${proposalId}`,
        isRunning: extras?.isRunning ?? true,
        startedAt: now,
        completedAt: extras?.completedAt ?? null,
        lastResult: extras?.lastResult,
        itemsProcessed: checkpoint.processedVotes,
        errorMessage: extras?.errorMessage ?? null,
        backfillCursor: JSON.stringify({
          ...checkpoint,
          updatedAt: now.toISOString(),
        }),
      },
      update: {
        isRunning: extras?.isRunning ?? true,
        completedAt: extras?.completedAt ?? null,
        lastResult: extras?.lastResult,
        itemsProcessed: checkpoint.processedVotes,
        errorMessage: extras?.errorMessage ?? null,
        backfillCursor: JSON.stringify({
          ...checkpoint,
          updatedAt: now.toISOString(),
        }),
      },
    })
  );
}

async function markVoteCheckpointComplete(
  db: IngestionDbClient,
  proposalId: string,
  processedVotes: number
): Promise<void> {
  const jobName = getVoteIngestionJobName(proposalId);
  await withIngestionDbWrite(
    db,
    `vote-checkpoint.complete.${proposalId}`,
    () =>
      db.syncStatus.upsert({
        where: { jobName },
        create: {
          jobName,
          displayName: `Vote Ingestion Window ${proposalId}`,
          isRunning: false,
          completedAt: new Date(),
          lastResult: "success",
          itemsProcessed: processedVotes,
          errorMessage: null,
          backfillCursor: null,
        },
        update: {
          isRunning: false,
          completedAt: new Date(),
          lastResult: "success",
          itemsProcessed: processedVotes,
          errorMessage: null,
          backfillCursor: null,
        },
      })
  );
}

async function fetchVotePage(
  proposalId: string,
  offset: number,
  minEpoch?: number,
  minBlockTime?: number
): Promise<KoiosVote[]> {
  return listVotes({
    proposalId,
    minEpoch,
    minBlockTime,
    limit: VOTE_INGEST_PAGE_SIZE,
    offset,
    order: "block_time.asc,vote_tx_hash.asc",
    source: "ingestion.vote.ingest.proposal.vote-list",
  });
}

function extractVoterRefs(votes: KoiosVote[]): VoteVoterRef[] {
  const refs: VoteVoterRef[] = [];
  for (const vote of votes) {
    if (!vote?.voter_id || !vote?.voter_role) continue;
    refs.push({
      voterRole: vote.voter_role,
      voterId: vote.voter_id,
    });
  }
  return refs;
}

/**
 * Ingests a single vote
 */
async function ingestSingleVote(
  koiosVote: KoiosVote,
  proposalId: string,
  db: IngestionDbClient,
  stats: VoteIngestionStats,
  shouldFetchSurveyMetadata: boolean,
  preloadedVoters?: Map<string, EnsureVoterResult>
): Promise<void> {
  stats.votesProcessed++;
  // 1. Ensure voter exists (creates if needed, updates voting power)
  const preloadedKey = `${koiosVote.voter_role}:${koiosVote.voter_id}`;
  const preloaded = preloadedVoters?.get(preloadedKey);
  const voterResult =
    preloaded ??
    (await ensureVoterExists(
      koiosVote.voter_role,
      koiosVote.voter_id,
      db
    ));

  // Update stats for voter creation/update
  if (!preloaded && voterResult.created) {
    if (koiosVote.voter_role === "DRep") stats.votersCreated.dreps++;
    else if (koiosVote.voter_role === "SPO") stats.votersCreated.spos++;
    else stats.votersCreated.ccs++;
  } else if (!preloaded && voterResult.updated) {
    if (koiosVote.voter_role === "DRep") stats.votersUpdated.dreps++;
    else if (koiosVote.voter_role === "SPO") stats.votersUpdated.spos++;
    else stats.votersUpdated.ccs++;
  }

  // 1b. For CC votes, update member name from vote metadata
  if (koiosVote.voter_role === "ConstitutionalCommittee" && koiosVote.meta_json?.authors) {
    const memberName = koiosVote.meta_json.authors[0]?.name;
    if (memberName) {
      await withIngestionDbWrite(
        db,
        `vote.ingest.cc-member-update.${voterResult.voterId}`,
        () =>
          db.cC.update({
            where: { ccId: voterResult.voterId },
            data: { memberName: memberName },
          })
      );
    }
  }

  // 2. Map Koios voter role to Prisma VoterType enum
  const voterType =
    koiosVote.voter_role === "DRep"
      ? VoterType.DREP
      : koiosVote.voter_role === "SPO"
      ? VoterType.SPO
      : VoterType.CC;

  // 3. Map Koios vote to Prisma VoteType enum
  const voteType =
    koiosVote.vote === "Yes"
      ? VoteType.YES
      : koiosVote.vote === "No"
      ? VoteType.NO
      : VoteType.ABSTAIN;

  // 4. Prepare foreign key IDs based on voter type
  const drepId = voterType === VoterType.DREP ? voterResult.voterId : null;
  const spoId = voterType === VoterType.SPO ? voterResult.voterId : null;
  const ccId = voterType === VoterType.CC ? voterResult.voterId : null;

  // 5. Get voter's voting power for this vote (stored in lovelace as BigInt)
  let votingPower = voterResult.votingPower;
  if (votingPower === undefined) {
    const voter = await getVoterWithPower(voterType, voterResult.voterId, db);
    votingPower = voter?.votingPower ?? null;
  }

  // 6. Fetch vote rationale/metadata JSON (stored as string in DB)
  const rationaleJson = await getVoteRationaleJson(koiosVote);
  let txMetadata:
    | Record<string, unknown>
    | Array<Record<string, unknown>>
    | null
    | undefined;
  // Guard tx_metadata calls:
  // 1) proposal must advertise linked survey context, and
  // 2) vote must have a tx hash.
  if (shouldFetchSurveyMetadata && koiosVote.vote_tx_hash) {
    txMetadata = voteTxMetadataCache.get(koiosVote.vote_tx_hash);
    if (txMetadata === undefined) {
      stats.metadata.attempts++;
      try {
        txMetadata = await fetchTxMetadataByHash(koiosVote.vote_tx_hash);
        voteTxMetadataCache.set(koiosVote.vote_tx_hash, txMetadata);
        if (txMetadata) {
          stats.metadata.success++;
        } else {
          // Keep null cached to avoid repeated misses.
          stats.metadata.failed++;
        }
      } catch (error: any) {
        // Keep null cached to avoid repeated failing calls in this run.
        voteTxMetadataCache.set(koiosVote.vote_tx_hash, null);
        stats.metadata.failed++;
        console.warn(
          `[Vote Ingestion] Non-fatal tx_metadata failure proposal=${proposalId} tx=${koiosVote.vote_tx_hash}:`,
          error?.message ?? error
        );
        txMetadata = null;
      }
    }
  } else {
    stats.metadata.skipped++;
  }

  const surveyResponse = txMetadata ? extractSurveyResponse(txMetadata) : null;
  const surveyResponseJson = surveyResponse
    ? JSON.stringify(surveyResponse)
    : undefined;

  // 7. Upsert vote by deterministic ID to avoid an extra read round-trip.
  // This keeps idempotency while handling metadata refreshes for the same tx.
  const voterKey = drepId ?? spoId ?? ccId ?? "unknown";
  const onchainVoteId = `${koiosVote.vote_tx_hash}:${proposalId}:${voterType}:${voterKey}`;
  const voteData = {
    txHash: koiosVote.vote_tx_hash,
    proposalId: proposalId,
    vote: voteType,
    voterType: voterType,
    votingPower: votingPower,
    responseEpoch: koiosVote.epoch_no ?? undefined,
    anchorUrl: koiosVote.meta_url,
    anchorHash: koiosVote.meta_hash,
    rationale: rationaleJson ?? undefined,
    surveyResponse: surveyResponseJson,
    surveyResponseSurveyTxId: surveyResponse?.surveyTxId,
    surveyResponseResponderRole: surveyResponse?.responderRole,
    votedAt: koiosVote.block_time
      ? new Date(koiosVote.block_time * 1000)
      : undefined,
    drepId: drepId,
    spoId: spoId,
    ccId: ccId,
  };

  await withIngestionDbWrite(db, `vote.ingest.upsert.${onchainVoteId}`, () =>
    db.onchainVote.upsert({
      where: { id: onchainVoteId },
      create: {
        id: onchainVoteId,
        ...voteData,
      },
      update: {
        ...voteData,
        // Preserve frontloaded rationale if cron fetch returned null
        ...(voteData.rationale == null ? { rationale: undefined } : {}),
      },
    })
  );
  stats.votesIngested++;
  stats.votesUpserted++;
}

/**
 * Gets voter with their voting power (stored in lovelace as BigInt)
 */
async function getVoterWithPower(
  voterType: VoterType,
  voterId: string,
  db: IngestionDbClient
): Promise<{ votingPower: bigint } | null> {
  if (voterType === VoterType.DREP) {
    const result = await withIngestionDbRead(
      db,
      `vote.ingest.voter-power.drep.${voterId}`,
      () =>
        db.drep.findUnique({
          where: { drepId: voterId },
          select: { votingPower: true },
        })
    );
    return result ? { votingPower: result.votingPower } : null;
  } else if (voterType === VoterType.SPO) {
    const result = await withIngestionDbRead(
      db,
      `vote.ingest.voter-power.spo.${voterId}`,
      () =>
        db.sPO.findUnique({
          where: { poolId: voterId },
          select: { votingPower: true },
        })
    );
    return result ? { votingPower: result.votingPower } : null;
  }
  // CC members don't have voting power tracked
  return null;
}

// ─── Frontload Vote (immediate write from frontend) ─────────────────────────

export interface FrontloadVoteInput {
  txHash: string;
  proposalId: string;
  vote: VoteType;
  voterType: VoterType;
  voterId: string;
  anchorUrl?: string;
  anchorHash?: string;
  rationale?: string;
  surveyResponse?: string;
  surveyResponseSurveyTxId?: string;
  surveyResponseResponderRole?: string;
}

/**
 * Immediately writes vote metadata to the database when a vote is submitted
 * through our frontend, bypassing the 20-40 min cron delay.
 *
 * Uses the same deterministic ID format as `ingestSingleVote` so when the
 * cron job eventually processes the same vote from Koios, its upsert merges
 * cleanly — filling in votingPower, responseEpoch, and votedAt.
 */
export async function frontloadVote(input: FrontloadVoteInput) {
  const { txHash, proposalId, vote, voterType, voterId } = input;

  const drepId = voterType === VoterType.DREP ? voterId : null;
  const spoId = voterType === VoterType.SPO ? voterId : null;
  const ccId = voterType === VoterType.CC ? voterId : null;

  // Verify voter exists in DB (catches format mismatches early —
  // e.g. CIP-105 sent instead of CIP-129)
  const voterExists = drepId
    ? await prisma.drep.findUnique({ where: { drepId }, select: { drepId: true } })
    : spoId
    ? await prisma.sPO.findUnique({ where: { poolId: spoId }, select: { poolId: true } })
    : ccId
    ? await prisma.cC.findUnique({ where: { ccId }, select: { ccId: true } })
    : null;

  if (!voterExists) {
    throw new Error(
      `Voter not found: ${voterType}:${voterId} — ensure the ID is in CIP-129 (bech32) format`
    );
  }

  // Must match the ID format in ingestSingleVote exactly
  const voterKey = drepId ?? spoId ?? ccId ?? "unknown";
  const onchainVoteId = `${txHash}:${proposalId}:${voterType}:${voterKey}`;

  const frontloadData = {
    txHash,
    proposalId,
    vote,
    voterType,
    drepId,
    spoId,
    ccId,
    anchorUrl: input.anchorUrl ?? null,
    anchorHash: input.anchorHash ?? null,
    rationale: input.rationale ?? null,
    surveyResponse: input.surveyResponse,
    surveyResponseSurveyTxId: input.surveyResponseSurveyTxId,
    surveyResponseResponderRole: input.surveyResponseResponderRole,
  };

  return prisma.onchainVote.upsert({
    where: { id: onchainVoteId },
    create: {
      id: onchainVoteId,
      ...frontloadData,
    },
    update: {
      // Only update metadata fields — do not overwrite chain-authoritative
      // fields (votingPower, responseEpoch, votedAt) that the cron may have set
      vote: frontloadData.vote,
      anchorUrl: frontloadData.anchorUrl,
      anchorHash: frontloadData.anchorHash,
      rationale: frontloadData.rationale,
      ...(frontloadData.surveyResponse !== undefined
        ? { surveyResponse: frontloadData.surveyResponse }
        : {}),
      ...(frontloadData.surveyResponseSurveyTxId !== undefined
        ? { surveyResponseSurveyTxId: frontloadData.surveyResponseSurveyTxId }
        : {}),
      ...(frontloadData.surveyResponseResponderRole !== undefined
        ? {
            surveyResponseResponderRole:
              frontloadData.surveyResponseResponderRole,
          }
        : {}),
    },
  });
}

/**
 * Ingests a single vote by transaction hash (for POST /data/vote/:tx_hash endpoint)
 *
 * Note: This requires knowing which proposal the vote belongs to
 */
export async function ingestVoteByTxHash(_txHash: string) {
  // TODO: Koios API needs to provide a way to get vote by tx_hash
  // OR we need to pass proposal_hash as well
  // For now, return a placeholder implementation

  return prisma.$transaction(async (_tx) => {
    // This would need to:
    // 1. Fetch vote from Koios by tx_hash
    // 2. Determine which proposal it belongs to
    // 3. Call ingestSingleVote

    throw new Error(
      "ingestVoteByTxHash not yet implemented - need to determine proposal from vote tx_hash"
    );
  });
}
