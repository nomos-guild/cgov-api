/**
 * Tests for getMigrationAggregateAccuracy — guards the C6 invariants:
 *  - Filter scoping: epochStart/epochEnd, fromDrepId/toDrepId, excludeSentinels,
 *    drepIdAllowlist must each appear in the SQL parameter list so the source
 *    distribution reflects the filtered window, NOT the global changelog.
 *  - SQL is parameterized via $queryRawUnsafe positional params (no string
 *    interpolation of caller input).
 *  - "koios-malformed" rows are reported in their own bucket (introduced in C2).
 *  - Default behaviour: excludeSentinels=true unless explicitly turned off.
 */

import type { PrismaClient } from "@prisma/client";

import {
  getMigrationAggregateAccuracy,
  type MigrationAggregateAccuracy,
} from "../src/services/ingestion/migration-aggregate.service";

function makePrismaWithRows(rows: Array<{ amount_source: string | null; n: bigint }>) {
  const queryRawUnsafe = jest.fn().mockResolvedValue(rows);
  const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaClient;
  return { prisma, queryRawUnsafe };
}

describe("getMigrationAggregateAccuracy", () => {
  it("buckets each amount_source into its own field, including koios-malformed", async () => {
    const { prisma } = makePrismaWithRows([
      { amount_source: "koios-history", n: 100n },
      { amount_source: "current-proxy", n: 7n },
      { amount_source: "unknown", n: 3n },
      { amount_source: "koios-malformed", n: 2n },
      { amount_source: null, n: 1n }, // never visited by backfill — fall-through bucket
    ]);

    const result: MigrationAggregateAccuracy =
      await getMigrationAggregateAccuracy(prisma);

    expect(result.totalChangeRows).toBe(113);
    expect(result.rowsWithKoiosHistory).toBe(100);
    expect(result.rowsWithCurrentProxy).toBe(8); // 7 explicit + 1 NULL fall-through
    expect(result.rowsUnknown).toBe(3);
    expect(result.rowsMalformed).toBe(2);
  });

  it("classifies level=koios-history when ≥99% rows are koios-history", async () => {
    const { prisma } = makePrismaWithRows([
      { amount_source: "koios-history", n: 99n },
      { amount_source: "current-proxy", n: 1n },
    ]);
    const result = await getMigrationAggregateAccuracy(prisma);
    expect(result.level).toBe("koios-history");
  });

  it("classifies level=mixed when partial koios-history coverage", async () => {
    const { prisma } = makePrismaWithRows([
      { amount_source: "koios-history", n: 50n },
      { amount_source: "current-proxy", n: 50n },
    ]);
    const result = await getMigrationAggregateAccuracy(prisma);
    expect(result.level).toBe("mixed");
  });

  it("classifies level=current when no koios-history rows exist", async () => {
    const { prisma } = makePrismaWithRows([
      { amount_source: "current-proxy", n: 100n },
    ]);
    const result = await getMigrationAggregateAccuracy(prisma);
    expect(result.level).toBe("current");
  });

  it("classifies level=current when there are zero rows at all", async () => {
    const { prisma } = makePrismaWithRows([]);
    const result = await getMigrationAggregateAccuracy(prisma);
    expect(result.level).toBe("current");
    expect(result.totalChangeRows).toBe(0);
  });

  it("scopes the query to epochStart/epochEnd via positional params (filtered, not global)", async () => {
    const { prisma, queryRawUnsafe } = makePrismaWithRows([]);

    await getMigrationAggregateAccuracy(prisma, {
      epochStart: 600,
      epochEnd: 700,
    });

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    expect(typeof sql).toBe("string");
    // Both bounds must appear as positional params (no string interpolation).
    expect(params).toEqual(expect.arrayContaining([600, 700]));
    // The SQL must reference the bounds via $N placeholders so they reach the DB
    // through binding, not the SQL text. Without these clauses the bounds would
    // be passed but never narrow the scan.
    expect(sql).toMatch(/"delegated_epoch_no"\s*>=\s*\$\d+/);
    expect(sql).toMatch(/"delegated_epoch_no"\s*<=\s*\$\d+/);
  });

  it("excludes drep_always_* sentinels by default — both as params AND as SQL predicates", async () => {
    const { prisma, queryRawUnsafe } = makePrismaWithRows([]);
    await getMigrationAggregateAccuracy(prisma);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    // Both sentinel ids must appear, twice each (from + to columns).
    const abstainCount = params.filter((p) => p === "drep_always_abstain").length;
    const nocCount = params.filter((p) => p === "drep_always_no_confidence").length;
    expect(abstainCount).toBeGreaterThanOrEqual(2);
    expect(nocCount).toBeGreaterThanOrEqual(2);
    // The SQL must actually USE the sentinel params via NOT IN clauses on both
    // columns — otherwise a regression that pushes the params but drops the
    // predicate would silently let sentinels skew the accuracy denominator.
    expect(sql).toMatch(/"from_drep_id"\s+NOT\s+IN/i);
    expect(sql).toMatch(/"to_drep_id"\s+NOT\s+IN/i);
  });

  it("includes sentinels when excludeSentinels=false (sentinel literals must not appear)", async () => {
    const { prisma, queryRawUnsafe } = makePrismaWithRows([]);
    await getMigrationAggregateAccuracy(prisma, { excludeSentinels: false });
    const [, ...params] = queryRawUnsafe.mock.calls[0];
    expect(params).not.toContain("drep_always_abstain");
    expect(params).not.toContain("drep_always_no_confidence");
  });

  it("scopes to fromDrepId / toDrepId / drepIdAllowlist via positional params AND matching SQL predicates", async () => {
    const { prisma, queryRawUnsafe } = makePrismaWithRows([]);

    await getMigrationAggregateAccuracy(prisma, {
      fromDrepId: "drep-from",
      toDrepId: "drep-to",
      drepIdAllowlist: ["drep-a", "drep-b", "drep-c"],
    });

    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    expect(params).toEqual(
      expect.arrayContaining([
        "drep-from",
        "drep-to",
        "drep-a",
        "drep-b",
        "drep-c",
      ])
    );
    // The SQL must actually narrow on these inputs — equality predicate on
    // from_drep_id and to_drep_id, plus the allowlist IN-clause on both
    // columns. Otherwise pushed params would not gate the scan.
    expect(sql).toMatch(/"from_drep_id"\s*=\s*\$\d+/);
    expect(sql).toMatch(/"to_drep_id"\s*=\s*\$\d+/);
    expect(sql).toMatch(/"from_drep_id"\s+IN\s*\(/i);
    expect(sql).toMatch(/"to_drep_id"\s+IN\s*\(/i);
  });
});
