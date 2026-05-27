/**
 * Snapshot composition for drep-lens (and any other drep-lens-shaped consumer).
 *
 * Reads from Drep, Proposal, OnchainVote, MigrationAggregate, DrepEpochSnapshot,
 * DrepLifecycleEvent and EpochTotals; serialises in the wire shape defined by
 * src/responses/snapshot.response.ts.
 *
 * Two-tier caching:
 *   L1 — in-memory single-flight via services/cache.ts (fastest, per-instance).
 *   L2 — SnapshotCache Prisma table (gzipped bodies + etag, shared across instances).
 *
 * Writes go through snapshot-builder.service.ts (called from epoch-analytics
 * after each successful epoch sync). Reads compose-and-cache on miss so the
 * service degrades gracefully if the rebuild hook hasn't fired yet.
 */

import { GovernanceType, VoterType } from "@prisma/client";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { cacheGet, cacheSet, cacheInvalidatePrefix } from "./cache";
import { governanceTypeLabelMap } from "../libs/proposalMapper";
import {
  chunkFinality,
  SnapshotChunk,
  SnapshotChunkAction,
  SnapshotChunkMigration,
  SnapshotDrep,
  SnapshotDreps,
  SnapshotManifest,
  SnapshotManifestChunk,
  SnapshotVote,
  toAda,
  toKada,
} from "../responses";
import { SENTINEL_DREP_IDS } from "../libs/sentinels";

export const SNAPSHOT_SCHEMA_VERSION = "v1" as const;
export const SNAPSHOT_CHUNK_SIZE = 50;

const CACHE_PREFIX = `snapshot:${SNAPSHOT_SCHEMA_VERSION}:`;
const CACHE_TTL_FRESH_MS = 5 * 60 * 1000;
const CACHE_TTL_FINAL_MS = 60 * 60 * 1000;

const inFlight = new Map<string, Promise<unknown>>();

async function singleFlight<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = loader().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

// Wire-format converters re-export the branded helpers from responses/lovelace.ts
// so the conversion happens at exactly one boundary and types stay tight on the
// composer side. These thin wrappers exist to keep the call sites short.
const lovelaceToKada = toKada;
const lovelaceToAda = toAda;

function slugifyForHandle(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function deriveHandle(name: string | null | undefined, drepId: string): string {
  const slug = slugifyForHandle(name);
  if (slug) return `@${slug}`;
  return `@${drepId.slice(0, 12)}`;
}

function lowercaseVote(vote: string | null | undefined): SnapshotVote | null {
  if (!vote) return null;
  const v = vote.toLowerCase();
  if (v === "yes" || v === "no" || v === "abstain") return v;
  return null;
}

/**
 * Round a fraction to 4 decimal places. Matches the precision the denorm
 * path delivers (drep-denorm.service stores percent rounded to 2 decimals;
 * dividing by 100 yields a fraction with 4 decimals). Both the denorm and
 * fallback recompute paths must round identically so the same DRep returns
 * a stable `participation` regardless of which path serves it.
 */
function roundParticipation(fraction: number): number {
  return Math.round(fraction * 10_000) / 10_000;
}

function chunkStartFor(epoch: number): number {
  return Math.floor(epoch / SNAPSHOT_CHUNK_SIZE) * SNAPSHOT_CHUNK_SIZE;
}

async function readCurrentEpoch(): Promise<number> {
  const row = await prisma.epochTotals.aggregate({ _max: { epoch: true } });
  return row._max.epoch ?? 0;
}

async function readFirstGovEpoch(): Promise<number> {
  const row = await prisma.proposal.aggregate({
    _min: { submissionEpoch: true },
  });
  return row._min.submissionEpoch ?? 0;
}

// ─── Cache key helpers ────────────────────────────────────────────────────

export const cacheKeys = {
  manifest(opts?: { epochStart?: number; epochEnd?: number }): string {
    if (opts?.epochStart != null || opts?.epochEnd != null) {
      return `${CACHE_PREFIX}manifest:${opts?.epochStart ?? ""}:${opts?.epochEnd ?? ""}`;
    }
    return `${CACHE_PREFIX}manifest:default`;
  },
  dreps(opts?: { topN?: number; includeHistory?: boolean }): string {
    return `${CACHE_PREFIX}dreps:${opts?.topN ?? 0}:${opts?.includeHistory ? "h" : ""}`;
  },
  chunk(startEpoch: number): string {
    return `${CACHE_PREFIX}chunk:${chunkStartFor(startEpoch)}`;
  },
};

// ─── DReps composer ───────────────────────────────────────────────────────

export async function composeDreps(opts: {
  topN?: number;
  includeHistory?: boolean;
}): Promise<SnapshotDreps> {
  const drepRows = await prisma.drep.findMany({
    where: { OR: [{ doNotList: false }, { doNotList: null }] },
    orderBy: { votingPower: "desc" },
    take: opts.topN && opts.topN > 0 ? opts.topN : undefined,
    select: {
      drepId: true,
      name: true,
      iconUrl: true,
      votingPower: true,
      delegatorCount: true,
      firstSeenEpoch: true,
      proposalParticipationPercent: true,
    },
  });

  const drepIds = drepRows.map((d) => d.drepId);
  const allDenormPopulated = drepRows.every(
    (d) => d.firstSeenEpoch != null && d.proposalParticipationPercent != null
  );

  // Denorm fallback — only run on-fly groupBys if the columns aren't populated yet
  const firstSeenEpochMap = new Map<string, number>();
  const participationMap = new Map<string, number>();

  if (!allDenormPopulated) {
    const [lifecycleRegs, drepProposalPairs, totalProposals] = await Promise.all([
      prisma.drepLifecycleEvent.groupBy({
        by: ["drepId"],
        where: { drepId: { in: drepIds }, action: "registration" },
        _min: { epochNo: true },
      }),
      prisma.onchainVote.groupBy({
        by: ["drepId", "proposalId"],
        where: { drepId: { in: drepIds }, voterType: VoterType.DREP },
      }),
      prisma.proposal.count(),
    ]);

    for (const row of lifecycleRegs) {
      if (row._min.epochNo != null) firstSeenEpochMap.set(row.drepId, row._min.epochNo);
    }
    const distinctProposalsMap = new Map<string, number>();
    for (const pair of drepProposalPairs) {
      if (!pair.drepId) continue;
      distinctProposalsMap.set(pair.drepId, (distinctProposalsMap.get(pair.drepId) ?? 0) + 1);
    }
    for (const id of drepIds) {
      const distinctVoted = distinctProposalsMap.get(id) ?? 0;
      participationMap.set(
        id,
        totalProposals > 0
          ? roundParticipation(distinctVoted / totalProposals)
          : 0
      );
    }
  }

  const historyRows = opts.includeHistory
    ? await prisma.drepEpochSnapshot.findMany({
        where: { drepId: { in: drepIds } },
        orderBy: { epoch: "asc" },
        select: {
          drepId: true,
          epoch: true,
          delegatorCount: true,
          votingPower: true,
        },
      })
    : [];

  const historyByDrep = new Map<string, Array<{ epoch: number; power: ReturnType<typeof toKada>; delegators: number }>>();
  for (const r of historyRows) {
    let arr = historyByDrep.get(r.drepId);
    if (!arr) {
      arr = [];
      historyByDrep.set(r.drepId, arr);
    }
    arr.push({
      epoch: r.epoch,
      power: lovelaceToKada(r.votingPower),
      delegators: r.delegatorCount,
    });
  }

  const DREPS: SnapshotDrep[] = drepRows.map((d) => {
    const denormParticipation = d.proposalParticipationPercent;
    // The denorm column stores percent (0..100, 2-decimal precision via SQL ROUND);
    // dividing by 100 yields a fraction with 4 decimals. Pass through roundParticipation
    // anyway so floating-point noise from the divide-by-100 doesn't smuggle in an
    // extra decimal.
    const participation =
      denormParticipation != null
        ? roundParticipation(denormParticipation / 100)
        : participationMap.get(d.drepId) ?? 0;
    const joined = d.firstSeenEpoch ?? firstSeenEpochMap.get(d.drepId) ?? 0;

    return {
      id: d.drepId,
      name: d.name ?? "",
      handle: deriveHandle(d.name, d.drepId),
      power: lovelaceToKada(d.votingPower),
      delegators: d.delegatorCount ?? 0,
      participation,
      joined,
      cluster: 0,
      iconUrl: d.iconUrl ?? null,
      ...(opts.includeHistory
        ? { powerSeries: historyByDrep.get(d.drepId) ?? [] }
        : {}),
    };
  });

  const featuredIds = [...DREPS]
    .filter((d) => d.name && d.name.trim().length > 0)
    .sort((a, b) => b.power - a.power)
    .slice(0, 8)
    .map((d) => d.id);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    drepCount: DREPS.length,
    DREPS,
    featuredIds,
  };
}

// ─── Chunk composer ───────────────────────────────────────────────────────

export async function composeChunk(startEpoch: number): Promise<SnapshotChunk> {
  const chunkStart = chunkStartFor(startEpoch);
  const chunkEnd = chunkStart + SNAPSHOT_CHUNK_SIZE - 1;

  const [proposals, voteRows, migrationRows, currentEpoch, amountStability, delegationWatermark] = await Promise.all([
    prisma.proposal.findMany({
      where: { submissionEpoch: { gte: chunkStart, lte: chunkEnd } },
      orderBy: [{ submissionEpoch: "asc" }, { proposalId: "asc" }],
      select: {
        proposalId: true,
        title: true,
        governanceActionType: true,
        submissionEpoch: true,
      },
    }),
    prisma.onchainVote.findMany({
      where: {
        voterType: VoterType.DREP,
        vote: { not: null },
        drepId: { not: null },
        proposal: {
          submissionEpoch: { gte: chunkStart, lte: chunkEnd },
        },
      },
      // votedAt asc + tie-break by id keeps writes deterministic; the loop below
      // overwrites earlier rows so the LAST processed (= latest vote) wins on
      // proposals where a DRep changed its vote.
      orderBy: [{ votedAt: "asc" }, { id: "asc" }],
      select: { drepId: true, proposalId: true, vote: true },
    }),
    // Filter sentinels here (not in MigrationAggregate refresh): /migrations
    // exposes excludeSentinels=false to callers that want them, but drep-lens's
    // cluster geometry should never see drep_always_* edges.
    prisma.migrationAggregate.findMany({
      where: {
        epoch: { gte: chunkStart, lte: chunkEnd },
        fromDrepId: { notIn: [...SENTINEL_DREP_IDS] },
        toDrepId: { notIn: [...SENTINEL_DREP_IDS] },
      },
      orderBy: [{ epoch: "asc" }, { fromDrepId: "asc" }, { toDrepId: "asc" }],
    }),
    readCurrentEpoch(),
    // Stability check: are ALL non-sentinel changelog rows in this chunk's epoch
    // range backfilled with amount_at_switch from /account_history? If yes, the
    // chunk's MIGRATIONS values will never change → safe to serve as immutable.
    // Sentinels (drep_always_*) are filtered out of the chunk MIGRATIONS payload
    // (lines 280-282) so they must also be filtered here, otherwise an unbackfilled
    // sentinel row would pin isStable=false forever despite never appearing in the
    // payload.
    prisma.$queryRaw<Array<{ unstable: bigint }>>`
      SELECT COUNT(*)::bigint AS unstable
      FROM "stake_delegation_change"
      WHERE "delegated_epoch_no" BETWEEN ${chunkStart} AND ${chunkEnd}
        AND "delegated_epoch_no" <> -1
        AND "from_drep_id" <> ''
        AND "to_drep_id"   <> ''
        AND "from_drep_id" <> "to_drep_id"
        AND "from_drep_id" NOT IN ('drep_always_abstain', 'drep_always_no_confidence')
        AND "to_drep_id"   NOT IN ('drep_always_abstain', 'drep_always_no_confidence')
        AND "amount_at_switch" IS NULL
        -- Stability is keyed off amount_at_switch, not amount_source: 'unknown'
        -- rows are stable (Koios confirmed zero active_stake; deterministic),
        -- 'koios-malformed' rows are NOT (amountAtSwitch=NULL until an operator
        -- clears the tag and re-runs the backfill).
    `,
    // Delegation full-scan watermark: until the first full inventory pass
    // completes, the changelog itself may be missing historical rows for
    // this chunk's epoch range — so isStable=true would be premature.
    prisma.delegationSyncCheckpoint.findUnique({
      where: { id: "default" },
      select: { lastFullAllDrepsScanAt: true },
    }),
  ]);

  // isStable requires BOTH: every existing row has historical amount AND the
  // changelog itself has been fully scanned at least once. Without the second
  // condition, sync-drep-delegators can still append historical rows after a
  // chunk has already been served as immutable. The `chunkFinality()` helper
  // collapses these signals into a discriminated union so the illegal
  // `{isFinal:false, isStable:true}` cannot be constructed.
  const finality = chunkFinality({
    isFinal: chunkEnd < currentEpoch,
    allAmountsHistorical: Number(amountStability[0]?.unstable ?? 0) === 0,
    fullScanCompleted: !!delegationWatermark?.lastFullAllDrepsScanAt,
  });

  const ACTIONS: SnapshotChunkAction[] = proposals.map((p) => ({
    id: p.proposalId,
    title: p.title,
    type: p.governanceActionType
      ? governanceTypeLabelMap[p.governanceActionType as GovernanceType] ?? "Unknown"
      : "Unknown",
    epoch: p.submissionEpoch ?? chunkStart,
  }));

  const votes: Record<string, Record<string, SnapshotVote>> = {};
  for (const row of voteRows) {
    if (!row.drepId || !row.vote) continue;
    const v = lowercaseVote(row.vote);
    if (!v) continue;
    let bucket = votes[row.drepId];
    if (!bucket) {
      bucket = {};
      votes[row.drepId] = bucket;
    }
    bucket[row.proposalId] = v;
  }

  const MIGRATIONS: SnapshotChunkMigration[] = migrationRows.map((r) => ({
    epoch: r.epoch,
    from: r.fromDrepId,
    to: r.toDrepId,
    // drep-lens's analysis layer remaps clusters per-pass and falls back to
    // these values when a DRep id isn't in the assign map (see Migration type).
    fromCluster: 0,
    toCluster: 0,
    ada: lovelaceToAda(r.adaLovelace),
    delegators: r.delegators,
  }));

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    epochStart: chunkStart,
    epochEnd: chunkEnd,
    ACTIONS,
    votes,
    MIGRATIONS,
    ...finality,
  };
}

// ─── Manifest composer ────────────────────────────────────────────────────

export async function composeManifest(opts?: {
  epochStart?: number;
  epochEnd?: number;
}): Promise<SnapshotManifest> {
  const [currentEpoch, firstGovEpoch, drepCount] = await Promise.all([
    readCurrentEpoch(),
    readFirstGovEpoch(),
    prisma.drep.count({
      where: { OR: [{ doNotList: false }, { doNotList: null }] },
    }),
  ]);

  const filterStart = opts?.epochStart ?? firstGovEpoch;
  const filterEnd = opts?.epochEnd ?? currentEpoch;

  // Clip the requested range to the data's actual extent: we never have
  // chunks before firstGovEpoch or beyond currentEpoch.
  const effectiveStart = Math.max(firstGovEpoch, filterStart);
  const effectiveEnd = Math.min(currentEpoch, filterEnd);

  const firstChunkStart = chunkStartFor(effectiveStart);
  const lastChunkStart = chunkStartFor(effectiveEnd);

  const proposalCountsByEpoch = await prisma.proposal.groupBy({
    by: ["submissionEpoch"],
    _count: { _all: true },
    where: {
      submissionEpoch: {
        gte: firstChunkStart,
        lte: lastChunkStart + SNAPSHOT_CHUNK_SIZE - 1,
        not: null,
      },
    },
  });

  // Filter sentinels here too so manifest.migrationCount equals what
  // composeChunk's MIGRATIONS[] actually emits.
  const migrationCountsByEpoch = await prisma.migrationAggregate.groupBy({
    by: ["epoch"],
    _count: { _all: true },
    where: {
      epoch: { gte: firstChunkStart, lte: lastChunkStart + SNAPSHOT_CHUNK_SIZE - 1 },
      fromDrepId: { notIn: [...SENTINEL_DREP_IDS] },
      toDrepId: { notIn: [...SENTINEL_DREP_IDS] },
    },
  });

  // COUNT(DISTINCT (drep_id, proposal_id)) — match what the chunk payload
  // actually exposes (one entry per drep+proposal after vote-change dedup).
  const voteCountsByEpoch: Array<{ submission_epoch: number; n: bigint }> =
    await prisma.$queryRaw`
      SELECT p."submission_epoch" AS submission_epoch, COUNT(DISTINCT (v."drep_id", v."proposal_id"))::bigint AS n
      FROM "onchain_vote" v
      JOIN "proposal" p ON p."proposal_id" = v."proposal_id"
      WHERE v."voter_type" = 'DREP'
        AND v."vote" IS NOT NULL
        AND v."drep_id" IS NOT NULL
        AND p."submission_epoch" IS NOT NULL
        AND p."submission_epoch" BETWEEN ${firstChunkStart} AND ${lastChunkStart + SNAPSHOT_CHUNK_SIZE - 1}
      GROUP BY p."submission_epoch"
    `;

  const propByEpoch = new Map<number, number>();
  for (const r of proposalCountsByEpoch) {
    if (r.submissionEpoch != null) propByEpoch.set(r.submissionEpoch, r._count._all);
  }
  const migByEpoch = new Map<number, number>();
  for (const r of migrationCountsByEpoch) {
    migByEpoch.set(r.epoch, r._count._all);
  }
  const voteByEpoch = new Map<number, number>();
  for (const r of voteCountsByEpoch) {
    voteByEpoch.set(r.submission_epoch, Number(r.n));
  }

  // Per-epoch unstable count — number of changelog rows whose amount_at_switch
  // is not yet from /account_history. Aggregating per-chunk is done below.
  const unstableByEpoch: Array<{ epoch: number; n: bigint }> =
    await prisma.$queryRaw`
      SELECT "delegated_epoch_no" AS epoch, COUNT(*)::bigint AS n
      FROM "stake_delegation_change"
      WHERE "delegated_epoch_no" BETWEEN ${firstChunkStart} AND ${lastChunkStart + SNAPSHOT_CHUNK_SIZE - 1}
        AND "delegated_epoch_no" <> -1
        AND "from_drep_id" <> ''
        AND "to_drep_id"   <> ''
        AND "from_drep_id" <> "to_drep_id"
        AND "from_drep_id" NOT IN ('drep_always_abstain', 'drep_always_no_confidence')
        AND "to_drep_id"   NOT IN ('drep_always_abstain', 'drep_always_no_confidence')
        AND "amount_at_switch" IS NULL
        -- See composeChunk above: stability is keyed off amount_at_switch so
        -- 'koios-malformed' (NULL value, retry pending) blocks isStable while
        -- 'unknown' (zero confirmed by Koios) does not. Sentinels are excluded to
        -- match the chunk MIGRATIONS payload — see migrationCountsByEpoch above.
      GROUP BY "delegated_epoch_no"
    `;
  const unstableCountByEpoch = new Map<number, number>();
  for (const r of unstableByEpoch) {
    unstableCountByEpoch.set(r.epoch, Number(r.n));
  }

  // Delegation full-scan watermark — see composeChunk for rationale.
  const delegationWatermark = await prisma.delegationSyncCheckpoint.findUnique({
    where: { id: "default" },
    select: { lastFullAllDrepsScanAt: true },
  });
  const fullScanCompleted = !!delegationWatermark?.lastFullAllDrepsScanAt;

  const chunks: SnapshotManifestChunk[] = [];
  for (let s = firstChunkStart; s <= lastChunkStart; s += SNAPSHOT_CHUNK_SIZE) {
    const e = s + SNAPSHOT_CHUNK_SIZE - 1;
    let actionCount = 0;
    let voteCount = 0;
    let migrationCount = 0;
    let unstableInChunk = 0;
    for (let ep = s; ep <= e; ep++) {
      actionCount += propByEpoch.get(ep) ?? 0;
      voteCount += voteByEpoch.get(ep) ?? 0;
      migrationCount += migByEpoch.get(ep) ?? 0;
      unstableInChunk += unstableCountByEpoch.get(ep) ?? 0;
    }
    const finality = chunkFinality({
      isFinal: e < currentEpoch,
      allAmountsHistorical: unstableInChunk === 0,
      fullScanCompleted,
    });
    chunks.push({
      startEpoch: s,
      endEpoch: e,
      url: `/snapshot/chunks/${s}-${e}`,
      actionCount,
      voteCount,
      migrationCount,
      ...finality,
    });
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    chunkSize: SNAPSHOT_CHUNK_SIZE,
    currentEpoch,
    firstGovEpoch,
    drepsUrl: "/snapshot/dreps",
    drepCount,
    chunks,
  };
}

// ─── Cache I/O (L2: SnapshotCache table) ──────────────────────────────────

export interface CachedSnapshot<T> {
  data: T;
  etag: string;
  generatedAt: Date;
  isFinal: boolean;
  byteSize: number;
  /** Pre-gzipped body for direct streaming with Content-Encoding: gzip */
  gzippedBody: Buffer;
}

function sha1(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

async function readCachedRow(cacheKey: string): Promise<{
  body: Buffer;
  etag: string;
  generatedAt: Date;
  isFinal: boolean;
  byteSize: number;
  contentEncoding: string;
} | null> {
  const row = await prisma.snapshotCache.findUnique({ where: { cacheKey } });
  if (!row) return null;
  // Bump lastAccessedAt — fire-and-forget to keep read latency low.
  prisma.snapshotCache
    .update({
      where: { cacheKey },
      data: { lastAccessedAt: new Date() },
    })
    .catch(() => undefined);
  return {
    body: Buffer.from(row.bodyGzip),
    etag: row.etag,
    generatedAt: row.generatedAt,
    isFinal: row.isFinal,
    byteSize: row.byteSize,
    contentEncoding: row.contentEncoding,
  };
}

export async function writeCachedSnapshot(
  cacheKey: string,
  payload: unknown,
  opts: { isFinal: boolean }
): Promise<{ etag: string; byteSize: number; gzippedBody: Buffer; generatedAt: Date }> {
  const json = JSON.stringify(payload);
  const gzippedBody = gzipSync(json, { level: 6 });
  const etag = sha1(gzippedBody);
  const generatedAt = new Date();
  await prisma.snapshotCache.upsert({
    where: { cacheKey },
    update: {
      bodyGzip: gzippedBody,
      contentEncoding: "gzip",
      generatedAt,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      isFinal: opts.isFinal,
      byteSize: gzippedBody.byteLength,
      etag,
    },
    create: {
      cacheKey,
      bodyGzip: gzippedBody,
      contentEncoding: "gzip",
      generatedAt,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      isFinal: opts.isFinal,
      byteSize: gzippedBody.byteLength,
      etag,
    },
  });
  cacheInvalidatePrefix(cacheKey); // drop L1 entries that match this exact key
  return { etag, byteSize: gzippedBody.byteLength, gzippedBody, generatedAt };
}

async function readOrCompose<T>(
  cacheKey: string,
  isFinal: boolean,
  composer: () => Promise<T>,
  opts: { canonical: boolean }
): Promise<CachedSnapshot<T>> {
  // L1 — in-memory. Validate finality matches expectation: a memHit with the
  // wrong `isFinal` flag means the epoch tip moved while the entry was alive,
  // and we'd otherwise pin a current-chunk body under final-TTL semantics.
  const memHit = cacheGet<CachedSnapshot<T>>(cacheKey);
  if (memHit && memHit.isFinal === isFinal) return memHit;

  // L2 — SnapshotCache table. Only canonical keys (manifest:default,
  // dreps:0:, chunk:N) are persisted by snapshot-builder.rebuildAfterEpoch
  // and therefore safe to read from L2. Variant keys (?topN=, ?epochStart=)
  // are NOT refreshed by the rebuilder and would otherwise serve stale
  // data forever once persisted; treat them as L1-only.
  if (opts.canonical) {
    const dbHit = await readCachedRow(cacheKey);
    // Skip L2 hit if its finality flag disagrees with the current tip — that
    // means the row was written before the epoch boundary and serving it as
    // final would lock in a partial mutable payload.
    if (dbHit && dbHit.isFinal === isFinal) {
      try {
        const data = JSON.parse(gunzipSync(dbHit.body).toString("utf-8")) as T;
        const cached: CachedSnapshot<T> = {
          data,
          etag: dbHit.etag,
          generatedAt: dbHit.generatedAt,
          isFinal: dbHit.isFinal,
          byteSize: dbHit.byteSize,
          gzippedBody: dbHit.body,
        };
        cacheSet(cacheKey, cached, isFinal ? CACHE_TTL_FINAL_MS : CACHE_TTL_FRESH_MS);
        return cached;
      } catch (e) {
        // Self-heal a poisoned L2 row: corrupted gzip / non-JSON body would
        // otherwise 500 every reader for this key forever. Conditional-delete
        // by etag so we don't wipe a fresh row that another instance just
        // wrote between our read and our delete; if the row was already
        // replaced, deleteMany matches zero rows and we proceed to recompose
        // (an extra recompose is harmless idempotent work).
        console.error(
          `[snapshot.service] L2 cache poison for ${cacheKey} — dropping row and recomposing`,
          e
        );
        await prisma.snapshotCache
          .deleteMany({ where: { cacheKey, etag: dbHit.etag } })
          .catch((delErr) => {
            console.error(
              `[snapshot.service] failed to evict poisoned L2 row ${cacheKey}`,
              delErr
            );
          });
      }
    }
  }

  // Miss — compose. Canonical keys also persist to L2 for cross-instance
  // reuse + ETag stability; variants stay in L1 only.
  return singleFlight(cacheKey, async () => {
    const data = await composer();
    if (opts.canonical) {
      const written = await writeCachedSnapshot(cacheKey, data, { isFinal });
      const cached: CachedSnapshot<T> = {
        data,
        etag: written.etag,
        generatedAt: written.generatedAt,
        isFinal,
        byteSize: written.byteSize,
        gzippedBody: written.gzippedBody,
      };
      cacheSet(cacheKey, cached, isFinal ? CACHE_TTL_FINAL_MS : CACHE_TTL_FRESH_MS);
      return cached;
    }

    // Variant — compose ad-hoc and cache in L1 only with a short TTL.
    const gzippedBody = gzipSync(JSON.stringify(data), { level: 6 });
    const etag = sha1(gzippedBody);
    const cached: CachedSnapshot<T> = {
      data,
      etag,
      generatedAt: new Date(),
      isFinal,
      byteSize: gzippedBody.byteLength,
      gzippedBody,
    };
    cacheSet(cacheKey, cached, CACHE_TTL_FRESH_MS);
    return cached;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────

function isCanonicalManifest(opts?: { epochStart?: number; epochEnd?: number }): boolean {
  return opts?.epochStart == null && opts?.epochEnd == null;
}

function isCanonicalDreps(opts?: { topN?: number; includeHistory?: boolean }): boolean {
  return (!opts?.topN || opts.topN === 0) && !opts?.includeHistory;
}

export const snapshotService = {
  async getManifest(opts?: {
    epochStart?: number;
    epochEnd?: number;
  }): Promise<CachedSnapshot<SnapshotManifest>> {
    const key = cacheKeys.manifest(opts);
    return readOrCompose(key, false, () => composeManifest(opts), {
      canonical: isCanonicalManifest(opts),
    });
  },

  async getDreps(opts?: {
    topN?: number;
    includeHistory?: boolean;
  }): Promise<CachedSnapshot<SnapshotDreps>> {
    const key = cacheKeys.dreps(opts);
    return readOrCompose(
      key,
      false,
      () => composeDreps({ topN: opts?.topN, includeHistory: !!opts?.includeHistory }),
      { canonical: isCanonicalDreps(opts) }
    );
  },

  async getChunk(startEpoch: number): Promise<CachedSnapshot<SnapshotChunk>> {
    const chunkStart = chunkStartFor(startEpoch);
    const key = cacheKeys.chunk(chunkStart);
    // We need to know isFinal up-front for TTL; ask the DB tip.
    const currentEpoch = await readCurrentEpoch();
    const chunkEnd = chunkStart + SNAPSHOT_CHUNK_SIZE - 1;
    const isFinal = chunkEnd < currentEpoch;
    // Chunks have no variants — every chunk URL is canonical.
    return readOrCompose(key, isFinal, () => composeChunk(chunkStart), { canonical: true });
  },

  invalidateAll(): number {
    return cacheInvalidatePrefix(CACHE_PREFIX);
  },
};
