/**
 * Tests for backfillAmountAtSwitch — idempotency + Koios-malformed handling.
 *
 * Specifically guards the C2 invariants:
 *  - Malformed `active_stake` values (not parseable as a non-negative integer)
 *    are tagged "koios-malformed" with amount_at_switch left NULL, NOT silently
 *    coerced to 0n + "unknown".
 *  - Numbers are rejected (mainnet whales > MAX_SAFE_INTEGER).
 *  - Hex / negative / blank strings are rejected.
 *  - "unknown" rows (Koios returned no entry for the (addr, epoch)) get 0n + "unknown".
 *  - The candidate query excludes already-tagged "koios-malformed" rows by default
 *    (so chronic-malformed rows can't pin the head of the queue).
 */

interface MockChange {
  id: number;
  stakeAddress: string;
  delegatedEpoch: number;
  amountAtSwitch: bigint | null;
  amountSource: string | null;
}

async function loadHarness() {
  jest.resetModules();

  const findManyMock = jest.fn();
  const updateMock = jest.fn();
  const updateManyMock = jest.fn().mockResolvedValue({ count: 0 });
  const executeRawUnsafeMock = jest.fn().mockResolvedValue(0);
  const getAccountHistoryBatchMock = jest.fn();

  jest.doMock("../src/services/prisma", () => ({
    prisma: {
      stakeDelegationChange: {
        findMany: findManyMock,
        update: updateMock,
        updateMany: updateManyMock,
      },
      $executeRawUnsafe: executeRawUnsafeMock,
    },
  }));
  jest.doMock("../src/services/governanceProvider", () => ({
    getAccountHistoryBatch: (...args: unknown[]) =>
      getAccountHistoryBatchMock(...args),
  }));

  const mod = await import(
    "../src/services/ingestion/migration-amount-backfill.service"
  );
  return {
    ...mod,
    findManyMock,
    updateMock,
    updateManyMock,
    executeRawUnsafeMock,
    getAccountHistoryBatchMock,
  };
}

describe("backfillAmountAtSwitch", () => {
  it("tags rows as 'koios-history' via a single batched UPDATE...FROM(VALUES) when Koios returns valid integers", async () => {
    const h = await loadHarness();
    h.findManyMock.mockResolvedValue([
      { id: 1, stakeAddress: "stake1abc", delegatedEpoch: 600 },
      { id: 2, stakeAddress: "stake1def", delegatedEpoch: 600 },
    ]);
    h.getAccountHistoryBatchMock.mockResolvedValue([
      { stake_address: "stake1abc", history: [{ epoch_no: 600, active_stake: "1234567890" }] },
      { stake_address: "stake1def", history: [{ epoch_no: 600, active_stake: "9999999999" }] },
    ]);

    const result = await h.backfillAmountAtSwitch();

    expect(result.rowsUpdated).toBe(2);
    expect(result.rowsUnknown).toBe(0);
    expect(result.rowsMalformed).toBe(0);
    // The history bucket flushes through a single $executeRawUnsafe call carrying
    // every (id, amount) pair; the per-row prisma.update path is no longer used.
    expect(h.executeRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(h.updateMock).not.toHaveBeenCalled();
    const [sql, ...params] = h.executeRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE\s+"stake_delegation_change"/i);
    expect(sql).toMatch(/'koios-history'/);
    expect(params).toEqual([1, "1234567890", 2, "9999999999"]);
  });

  it("tags rows as 'unknown' with amount_at_switch=0n via a single updateMany when Koios returns no /account_history entry", async () => {
    const h = await loadHarness();
    h.findManyMock.mockResolvedValue([
      { id: 5, stakeAddress: "stake1aaa", delegatedEpoch: 601 },
      { id: 6, stakeAddress: "stake1bbb", delegatedEpoch: 601 },
    ]);
    h.getAccountHistoryBatchMock.mockResolvedValue([
      { stake_address: "stake1aaa", history: [] },
      { stake_address: "stake1bbb", history: [] },
    ]);

    const result = await h.backfillAmountAtSwitch();

    expect(result.rowsUnknown).toBe(2);
    expect(result.rowsUpdated).toBe(0);
    expect(result.rowsMalformed).toBe(0);
    expect(h.updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: [5, 6] } },
      data: { amountAtSwitch: 0n, amountSource: "unknown" },
    });
    expect(h.updateMock).not.toHaveBeenCalled();
  });

  it("tags rows as 'koios-malformed' via a single updateMany on parse failures (and never as 'koios-history')", async () => {
    const h = await loadHarness();
    h.findManyMock.mockResolvedValue([
      { id: 3, stakeAddress: "stake1ghi", delegatedEpoch: 602 }, // empty string
      { id: 4, stakeAddress: "stake1jkl", delegatedEpoch: 602 }, // hex
      { id: 5, stakeAddress: "stake1mno", delegatedEpoch: 602 }, // negative
      { id: 6, stakeAddress: "stake1pqr", delegatedEpoch: 602 }, // number type (rejected for whale safety)
      { id: 7, stakeAddress: "stake1stu", delegatedEpoch: 602 }, // null
    ]);
    h.getAccountHistoryBatchMock.mockResolvedValue([
      { stake_address: "stake1ghi", history: [{ epoch_no: 602, active_stake: "" }] },
      { stake_address: "stake1jkl", history: [{ epoch_no: 602, active_stake: "0xff" }] },
      { stake_address: "stake1mno", history: [{ epoch_no: 602, active_stake: "-5" }] },
      { stake_address: "stake1pqr", history: [{ epoch_no: 602, active_stake: 12345 as unknown as string }] },
      { stake_address: "stake1stu", history: [{ epoch_no: 602, active_stake: null as unknown as string }] },
    ]);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await h.backfillAmountAtSwitch();

      expect(result.rowsMalformed).toBe(5);
      expect(result.rowsUpdated).toBe(0);
      expect(result.rowsUnknown).toBe(0);
      // Single batched updateMany tags every malformed row in one round-trip;
      // amount_at_switch is NOT touched (stays NULL) — verify by ensuring data
      // omits it.
      expect(h.updateManyMock).toHaveBeenCalledWith({
        where: { id: { in: [3, 4, 5, 6, 7] } },
        data: { amountSource: "koios-malformed" },
      });
      // Per-row warn-log still fires so ops gets the (addr, epoch, raw) tuples.
      expect(warnSpy).toHaveBeenCalledTimes(5);
      expect(h.updateMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("issues at most three SQL statements per epoch regardless of row count (no N+1)", async () => {
    const h = await loadHarness();
    // 60 candidates in a single epoch — mix of buckets.
    const candidates = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      stakeAddress: `stake${i}`,
      delegatedEpoch: 600,
    }));
    h.findManyMock.mockResolvedValue(candidates);
    // 20 with valid amounts, 20 unknown (no entry), 20 malformed.
    const entries = candidates.map((c, i) => ({
      stake_address: c.stakeAddress,
      history:
        i < 20
          ? [{ epoch_no: 600, active_stake: `${(i + 1) * 1000}` }]
          : i < 40
            ? []
            : [{ epoch_no: 600, active_stake: "garbage" }],
    }));
    h.getAccountHistoryBatchMock.mockResolvedValue(entries);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await h.backfillAmountAtSwitch();
      expect(result.rowsUpdated).toBe(20);
      expect(result.rowsUnknown).toBe(20);
      expect(result.rowsMalformed).toBe(20);

      // Exactly one $executeRawUnsafe (history bucket) + two updateMany
      // (unknown + malformed), regardless of 60 input rows.
      expect(h.executeRawUnsafeMock).toHaveBeenCalledTimes(1);
      expect(h.updateManyMock).toHaveBeenCalledTimes(2);
      expect(h.updateMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("default candidate query excludes rows already tagged 'koios-malformed' (no head-stuck)", async () => {
    const h = await loadHarness();
    h.findManyMock.mockResolvedValue([]);

    await h.backfillAmountAtSwitch();

    expect(h.findManyMock).toHaveBeenCalledTimes(1);
    const args = h.findManyMock.mock.calls[0][0];
    // Default excludeMalformed=true should add a clause that filters out koios-malformed.
    expect(JSON.stringify(args.where)).toContain("koios-malformed");
  });

  it("excludeMalformed=false includes koios-malformed rows so an operator-driven retry path can drain them", async () => {
    const h = await loadHarness();
    h.findManyMock.mockResolvedValue([]);

    await h.backfillAmountAtSwitch({ excludeMalformed: false });

    const args = h.findManyMock.mock.calls[0][0];
    // The exclusion clause should NOT be present.
    expect(JSON.stringify(args.where)).not.toContain("koios-malformed");
  });

  it("returns an empty/zero result without any updates when there are no candidates", async () => {
    const h = await loadHarness();
    h.findManyMock.mockResolvedValue([]);

    const result = await h.backfillAmountAtSwitch();

    expect(result).toEqual({
      durationMs: expect.any(Number),
      rowsScanned: 0,
      rowsUpdated: 0,
      rowsUnknown: 0,
      rowsMalformed: 0,
      epochsProcessed: 0,
      epochSpan: null,
    });
    expect(h.updateMock).not.toHaveBeenCalled();
    expect(h.getAccountHistoryBatchMock).not.toHaveBeenCalled();
  });
});
