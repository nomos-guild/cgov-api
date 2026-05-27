/**
 * Tests for composeChunk — guards the C6 invariants:
 *  - chunkStartFor math: arbitrary epoch in the chunk maps to its [chunkStart, chunkStart+49] range.
 *  - "Latest vote wins": when a DRep voted multiple times on the same proposal,
 *    the LAST entry (votedAt asc, id asc) overwrites earlier ones.
 *  - MIGRATIONS sentinel filter (drep_always_*) is applied via the Prisma `notIn` clauses
 *    passed to migrationAggregate.findMany.
 *  - isStable requires BOTH "no NULL amount_at_switch rows" AND
 *    "delegation full-scan watermark set"; either alone leaves isStable=false.
 */

const SENTINELS = ["drep_always_abstain", "drep_always_no_confidence"];

function setupHarness(opts: {
  proposals?: Array<{ proposalId: string; title: string; governanceActionType: string | null; submissionEpoch: number | null }>;
  votes?: Array<{ drepId: string | null; proposalId: string; vote: string | null }>;
  migrations?: Array<{ epoch: number; fromDrepId: string; toDrepId: string; adaLovelace: bigint; delegators: number }>;
  currentEpoch?: number;
  unstableCount?: number;
  fullScanCompleted?: boolean;
}) {
  jest.resetModules();

  const proposalFindMany = jest.fn().mockResolvedValue(opts.proposals ?? []);
  const voteFindMany = jest.fn().mockResolvedValue(opts.votes ?? []);
  const migrationFindMany = jest.fn().mockResolvedValue(opts.migrations ?? []);
  const aggregateMock = jest
    .fn()
    .mockResolvedValue({ _max: { epoch: opts.currentEpoch ?? 700 } });
  const queryRaw = jest
    .fn()
    .mockResolvedValue([{ unstable: BigInt(opts.unstableCount ?? 0) }]);
  const findUniqueCheckpoint = jest.fn().mockResolvedValue({
    lastFullAllDrepsScanAt: opts.fullScanCompleted === false ? null : new Date(),
  });

  jest.doMock("../src/services/prisma", () => ({
    prisma: {
      proposal: { findMany: proposalFindMany, aggregate: jest.fn() },
      onchainVote: { findMany: voteFindMany },
      migrationAggregate: { findMany: migrationFindMany },
      epochTotals: { aggregate: aggregateMock },
      delegationSyncCheckpoint: { findUnique: findUniqueCheckpoint },
      $queryRaw: queryRaw,
    },
  }));
  jest.doMock("../src/services/cache", () => ({
    cacheGet: jest.fn(),
    cacheSet: jest.fn(),
    cacheInvalidatePrefix: jest.fn(() => 0),
  }));

  return {
    proposalFindMany,
    voteFindMany,
    migrationFindMany,
    aggregateMock,
    queryRaw,
    findUniqueCheckpoint,
  };
}

describe("composeChunk", () => {
  it("maps an arbitrary epoch to its 50-wide chunk window", async () => {
    setupHarness({});
    const { composeChunk } = await import("../src/services/snapshot.service");
    const chunk = await composeChunk(627);
    expect(chunk.epochStart).toBe(600);
    expect(chunk.epochEnd).toBe(649);
  });

  it("aligns chunk window when called on a chunk-boundary epoch", async () => {
    setupHarness({});
    const { composeChunk } = await import("../src/services/snapshot.service");
    const chunk = await composeChunk(650);
    expect(chunk.epochStart).toBe(650);
    expect(chunk.epochEnd).toBe(699);
  });

  it("LAST vote (by votedAt asc, id asc) wins when a DRep voted twice on the same proposal", async () => {
    // The mock returns rows in the order the loop will iterate. Because the
    // composer overwrites bucket[proposalId] = v, the LAST entry should win.
    const h = setupHarness({
      votes: [
        { drepId: "drep-a", proposalId: "p1", vote: "no" },     // earlier
        { drepId: "drep-a", proposalId: "p1", vote: "yes" },    // later — wins
        { drepId: "drep-b", proposalId: "p1", vote: "abstain" },
      ],
    });
    const { composeChunk } = await import("../src/services/snapshot.service");
    const chunk = await composeChunk(600);
    expect(chunk.votes["drep-a"]).toEqual({ p1: "yes" });
    expect(chunk.votes["drep-b"]).toEqual({ p1: "abstain" });

    // The "last wins" guarantee is only meaningful if the production query
    // imposes the deterministic [votedAt asc, id asc] ordering on the iterated
    // rows. Pin that contract here so a regression that drops the orderBy is
    // caught by the test rather than only at integration time.
    expect(h.voteFindMany).toHaveBeenCalledTimes(1);
    const orderBy = h.voteFindMany.mock.calls[0][0].orderBy;
    expect(orderBy).toEqual([{ votedAt: "asc" }, { id: "asc" }]);
  });

  it("drops votes with missing drepId or vote", async () => {
    setupHarness({
      votes: [
        { drepId: null, proposalId: "p1", vote: "yes" },
        { drepId: "drep-x", proposalId: "p1", vote: null },
        { drepId: "drep-y", proposalId: "p1", vote: "yes" },
      ],
    });
    const { composeChunk } = await import("../src/services/snapshot.service");
    const chunk = await composeChunk(600);
    expect(chunk.votes).toEqual({ "drep-y": { p1: "yes" } });
  });

  it("requests MIGRATIONS with a sentinel exclusion filter on both sides", async () => {
    const h = setupHarness({});
    const { composeChunk } = await import("../src/services/snapshot.service");
    await composeChunk(600);

    expect(h.migrationFindMany).toHaveBeenCalledTimes(1);
    const where = h.migrationFindMany.mock.calls[0][0].where;
    expect(where.fromDrepId.notIn).toEqual(SENTINELS);
    expect(where.toDrepId.notIn).toEqual(SENTINELS);
  });

  it("isStable=true only when isFinal AND no unstable rows AND full-scan watermark is set", async () => {
    const h = setupHarness({
      currentEpoch: 700,           // chunk 600..649 is final
      unstableCount: 0,
      fullScanCompleted: true,
    });
    const { composeChunk } = await import("../src/services/snapshot.service");
    const chunk = await composeChunk(600);
    expect(chunk.isFinal).toBe(true);
    expect(chunk.isStable).toBe(true);

    // The unstable-count SQL must:
    //  (i) key off `amount_at_switch IS NULL` (post-C2 invariant — `amount_source IS NULL`
    //      would silently mark koios-malformed rows as stable)
    //  (ii) exclude both `drep_always_*` sentinels on both from/to columns
    //       (C3 — without this, a sentinel-targeted unbackfilled row would pin
    //       isStable=false forever despite never appearing in the chunk payload).
    // The Prisma tagged-template form passes a TemplateStringsArray as args[0]
    // — concatenating it gives us the SQL skeleton independent of param values.
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const templateParts = h.queryRaw.mock.calls[0][0] as ReadonlyArray<string>;
    const sql = templateParts.join(" ? ");
    expect(sql).toContain("amount_at_switch");
    expect(sql).toContain("IS NULL");
    expect(sql).toContain("drep_always_abstain");
    expect(sql).toContain("drep_always_no_confidence");
    // Sanity guard against accidental regression to the old amount_source predicate
    // (which would mark malformed rows as stable).
    expect(sql).not.toMatch(/"amount_source"\s+IS\s+NULL/);
  });

  it("isStable=false when delegation full-scan watermark is missing", async () => {
    setupHarness({
      currentEpoch: 700,
      unstableCount: 0,
      fullScanCompleted: false,
    });
    const { composeChunk } = await import("../src/services/snapshot.service");
    const chunk = await composeChunk(600);
    expect(chunk.isFinal).toBe(true);
    expect(chunk.isStable).toBe(false);
  });

  it("isStable=false when there are still rows with NULL amount_at_switch", async () => {
    setupHarness({
      currentEpoch: 700,
      unstableCount: 5,
      fullScanCompleted: true,
    });
    const { composeChunk } = await import("../src/services/snapshot.service");
    const chunk = await composeChunk(600);
    expect(chunk.isFinal).toBe(true);
    expect(chunk.isStable).toBe(false);
  });

  it("isStable=false (and isFinal=false) for the current chunk", async () => {
    setupHarness({
      currentEpoch: 620,           // chunk 600..649 is the CURRENT chunk
      unstableCount: 0,
      fullScanCompleted: true,
    });
    const { composeChunk } = await import("../src/services/snapshot.service");
    const chunk = await composeChunk(600);
    expect(chunk.isFinal).toBe(false);
    expect(chunk.isStable).toBe(false);
  });
});

/**
 * snapshotService.getChunk — verifies the L2 finality-mismatch invariant:
 * if the SnapshotCache row was written when the chunk was still mutable
 * (isFinal=false) but the current epoch has since advanced past the chunk's
 * end (so isFinal should now be true), readOrCompose MUST treat the L2 row
 * as a miss and recompose, writing back a row with the corrected flag.
 *
 * Without this re-check, the cached body would stay pinned under final-TTL
 * semantics across an epoch boundary, serving partial mutable data with
 * immutable cache headers.
 */
describe("snapshotService.getChunk — L2 finality-mismatch round-trip", () => {
  function setupRoundTripHarness() {
    jest.resetModules();

    const findUniqueSnapshotCache = jest.fn();
    const upsertSnapshotCache = jest.fn(async (args: { create: unknown; update: unknown }) => args.create as unknown);
    // Fire-and-forget update of `lastAccessedAt` returns a promise the production
    // code chains `.catch` on; mock must return a thenable so the chain doesn't
    // throw on .catch of undefined.
    const updateSnapshotCache = jest.fn().mockResolvedValue(undefined);
    const aggregateMock = jest.fn().mockResolvedValue({ _max: { epoch: 700 } });
    const proposalFindMany = jest.fn().mockResolvedValue([]);
    const voteFindMany = jest.fn().mockResolvedValue([]);
    const migrationFindMany = jest.fn().mockResolvedValue([]);
    const queryRaw = jest.fn().mockResolvedValue([{ unstable: 0n }]);
    const findUniqueCheckpoint = jest
      .fn()
      .mockResolvedValue({ lastFullAllDrepsScanAt: new Date() });

    jest.doMock("../src/services/prisma", () => ({
      prisma: {
        proposal: { findMany: proposalFindMany, aggregate: jest.fn() },
        onchainVote: { findMany: voteFindMany },
        migrationAggregate: { findMany: migrationFindMany },
        epochTotals: { aggregate: aggregateMock },
        delegationSyncCheckpoint: { findUnique: findUniqueCheckpoint },
        snapshotCache: {
          findUnique: findUniqueSnapshotCache,
          upsert: upsertSnapshotCache,
          update: updateSnapshotCache,
        },
        $queryRaw: queryRaw,
      },
    }));
    jest.doMock("../src/services/cache", () => ({
      cacheGet: jest.fn().mockReturnValue(undefined),
      cacheSet: jest.fn(),
      cacheInvalidatePrefix: jest.fn(() => 0),
    }));

    return {
      findUniqueSnapshotCache,
      upsertSnapshotCache,
      updateSnapshotCache,
      proposalFindMany,
    };
  }

  it("treats an L2 row whose isFinal disagrees with the current tip as a miss and recomposes", async () => {
    const h = setupRoundTripHarness();

    // Pretend a stale row exists for chunk 600..649 with isFinal=false even
    // though current epoch is 700 (so the chunk is in fact final).
    const { gzipSync } = await import("node:zlib");
    const staleBody = gzipSync(Buffer.from("{}"));
    h.findUniqueSnapshotCache.mockResolvedValue({
      cacheKey: "snapshot:v1:chunk:600",
      bodyGzip: staleBody,
      contentEncoding: "gzip",
      generatedAt: new Date(Date.now() - 60_000),
      schemaVersion: "v1",
      isFinal: false, // ← mismatch
      byteSize: staleBody.byteLength,
      etag: "stale-etag",
    });

    const { snapshotService } = await import("../src/services/snapshot.service");
    const result = await snapshotService.getChunk(600);

    // The reader must NOT serve the stale body. It must recompose (which
    // hits the proposal/vote/migration mocks) and upsert a fresh row.
    expect(result.etag).not.toBe("stale-etag");
    expect(result.isFinal).toBe(true);
    expect(h.proposalFindMany).toHaveBeenCalled();
    expect(h.upsertSnapshotCache).toHaveBeenCalled();
  });

  it("self-heals a poisoned L2 row (corrupted gzip body) by deleting it and recomposing", async () => {
    const h = setupRoundTripHarness();
    const deleteSnapshotCache = jest.fn().mockResolvedValue({ count: 1 });
    const deleteManySnapshotCache = jest.fn().mockResolvedValue({ count: 1 });
    // Wire deleteSnapshotCache into the mocked prisma — needs re-doMock since
    // the harness already mocked it without delete.
    jest.resetModules();
    const findUniqueSnapshotCache = jest.fn();
    const upsertSnapshotCache = jest.fn(async (args: { create: unknown }) => args.create);
    const updateSnapshotCache = jest.fn().mockResolvedValue(undefined);
    const aggregateMock = jest.fn().mockResolvedValue({ _max: { epoch: 700 } });
    const proposalFindMany = jest.fn().mockResolvedValue([]);
    const voteFindMany = jest.fn().mockResolvedValue([]);
    const migrationFindMany = jest.fn().mockResolvedValue([]);
    const queryRaw = jest.fn().mockResolvedValue([{ unstable: 0n }]);
    const findUniqueCheckpoint = jest
      .fn()
      .mockResolvedValue({ lastFullAllDrepsScanAt: new Date() });

    jest.doMock("../src/services/prisma", () => ({
      prisma: {
        proposal: { findMany: proposalFindMany, aggregate: jest.fn() },
        onchainVote: { findMany: voteFindMany },
        migrationAggregate: { findMany: migrationFindMany },
        epochTotals: { aggregate: aggregateMock },
        delegationSyncCheckpoint: { findUnique: findUniqueCheckpoint },
        snapshotCache: {
          findUnique: findUniqueSnapshotCache,
          upsert: upsertSnapshotCache,
          update: updateSnapshotCache,
          delete: deleteSnapshotCache,
          deleteMany: deleteManySnapshotCache,
        },
        $queryRaw: queryRaw,
      },
    }));
    jest.doMock("../src/services/cache", () => ({
      cacheGet: jest.fn().mockReturnValue(undefined),
      cacheSet: jest.fn(),
      cacheInvalidatePrefix: jest.fn(() => 0),
    }));

    // Body is corrupted (not valid gzip). The reader must NOT 500 — it must
    // catch the gunzip error, delete the poisoned row, and recompose.
    const corruptBody = Buffer.from("not-actually-gzip");
    findUniqueSnapshotCache.mockResolvedValue({
      cacheKey: "snapshot:v1:chunk:600",
      bodyGzip: corruptBody,
      contentEncoding: "gzip",
      generatedAt: new Date(),
      schemaVersion: "v1",
      isFinal: true, // matches current tip — so self-heal must trigger via the gunzip throw, not the finality check
      byteSize: corruptBody.byteLength,
      etag: "poisoned-etag",
    });

    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { snapshotService } = await import("../src/services/snapshot.service");
      const result = await snapshotService.getChunk(600);

      expect(result.etag).not.toBe("poisoned-etag");
      // Conditional delete: scope to (cacheKey, etag) so we don't wipe a fresh
      // row another instance just wrote between our read and our self-heal.
      expect(deleteManySnapshotCache).toHaveBeenCalledWith({
        where: {
          cacheKey: "snapshot:v1:chunk:600",
          etag: "poisoned-etag",
        },
      });
      expect(upsertSnapshotCache).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
    // Silence the lint about unused harness for this isolated test:
    void h;
  });
});
