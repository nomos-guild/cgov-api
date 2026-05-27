/**
 * Tests for writeCachedSnapshot — guards the C6 invariants:
 *  - Identical payloads produce identical ETags (deterministic gzip + sha1).
 *  - Different payloads produce different ETags.
 *  - The persisted body is gzipped and round-trips back to the source JSON.
 *  - The isFinal flag is mirrored into the cached row so readers can detect
 *    the "wrote-as-mutable, now-actually-final" mismatch and recompose.
 */

import { gunzipSync } from "node:zlib";

interface SnapshotCacheRow {
  cacheKey: string;
  bodyGzip: Buffer;
  contentEncoding: string;
  generatedAt: Date;
  schemaVersion: string;
  isFinal: boolean;
  byteSize: number;
  etag: string;
}

function setupHarness() {
  jest.resetModules();

  // Tiny in-memory SnapshotCache table backed by a Map.
  const store = new Map<string, SnapshotCacheRow>();

  const upsert = jest.fn(async ({ where, update, create }: {
    where: { cacheKey: string };
    update: Partial<SnapshotCacheRow>;
    create: SnapshotCacheRow;
  }) => {
    const existing = store.get(where.cacheKey);
    if (existing) {
      const merged = { ...existing, ...update };
      store.set(where.cacheKey, merged);
      return merged;
    }
    store.set(create.cacheKey, create);
    return create;
  });

  jest.doMock("../src/services/prisma", () => ({
    prisma: {
      snapshotCache: { upsert },
      epochTotals: { aggregate: jest.fn() },
      proposal: { aggregate: jest.fn() },
      drep: { count: jest.fn() },
    },
  }));

  // No L1 cache invalidation noise in tests.
  jest.doMock("../src/services/cache", () => ({
    cacheGet: jest.fn(),
    cacheSet: jest.fn(),
    cacheInvalidatePrefix: jest.fn(() => 0),
  }));

  return { store, upsert };
}

describe("writeCachedSnapshot ETag determinism", () => {
  it("produces identical etag for identical payloads", async () => {
    const { upsert } = setupHarness();
    const { writeCachedSnapshot } = await import(
      "../src/services/snapshot.service"
    );

    const payload = { schemaVersion: "v1", n: 42, items: [1, 2, 3] };
    const a = await writeCachedSnapshot("k:a", payload, { isFinal: false });
    const b = await writeCachedSnapshot("k:b", payload, { isFinal: false });

    expect(a.etag).toBe(b.etag);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("produces different etag for different payloads", async () => {
    setupHarness();
    const { writeCachedSnapshot } = await import(
      "../src/services/snapshot.service"
    );

    const a = await writeCachedSnapshot("k:a", { x: 1 }, { isFinal: false });
    const b = await writeCachedSnapshot("k:b", { x: 2 }, { isFinal: false });

    expect(a.etag).not.toBe(b.etag);
  });

  it("persists a gzipped body that round-trips back to the source JSON", async () => {
    const { store } = setupHarness();
    const { writeCachedSnapshot } = await import(
      "../src/services/snapshot.service"
    );

    const payload = { tag: "round-trip", arr: [{ a: 1 }, { a: 2 }] };
    await writeCachedSnapshot("k:roundtrip", payload, { isFinal: true });

    const row = store.get("k:roundtrip");
    expect(row).toBeDefined();
    expect(row!.byteSize).toBe(row!.bodyGzip.byteLength);
    const decoded = JSON.parse(gunzipSync(row!.bodyGzip).toString("utf-8"));
    expect(decoded).toEqual(payload);
  });

  it("propagates isFinal into the persisted row so the reader can detect mutable-vs-final mismatch", async () => {
    const { store } = setupHarness();
    const { writeCachedSnapshot } = await import(
      "../src/services/snapshot.service"
    );

    await writeCachedSnapshot("k:mut", { v: 1 }, { isFinal: false });
    await writeCachedSnapshot("k:fin", { v: 1 }, { isFinal: true });

    expect(store.get("k:mut")?.isFinal).toBe(false);
    expect(store.get("k:fin")?.isFinal).toBe(true);
    // ETags are still equal across the two writes — finality does not feed the body.
    expect(store.get("k:mut")?.etag).toBe(store.get("k:fin")?.etag);
  });

  it("re-upserting the same key updates body, etag, byteSize, and isFinal", async () => {
    const { store } = setupHarness();
    const { writeCachedSnapshot } = await import(
      "../src/services/snapshot.service"
    );

    const first = await writeCachedSnapshot("k:overwrite", { v: 1 }, { isFinal: false });
    const second = await writeCachedSnapshot("k:overwrite", { v: 2 }, { isFinal: true });

    expect(first.etag).not.toBe(second.etag);
    const row = store.get("k:overwrite");
    expect(row?.etag).toBe(second.etag);
    expect(row?.isFinal).toBe(true);
    const decoded = JSON.parse(gunzipSync(row!.bodyGzip).toString("utf-8"));
    expect(decoded).toEqual({ v: 2 });
  });

  it("persists contentEncoding='gzip' so future encodings can be added without another column rename", async () => {
    const { store } = setupHarness();
    const { writeCachedSnapshot } = await import(
      "../src/services/snapshot.service"
    );

    await writeCachedSnapshot("k:enc", { v: 3 }, { isFinal: false });
    const row = store.get("k:enc");
    expect(row?.contentEncoding).toBe("gzip");
  });
});
