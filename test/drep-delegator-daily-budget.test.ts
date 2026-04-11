import type { PrismaClient } from "@prisma/client";
import {
  DREP_DELEGATOR_DAILY_MAX_ATTEMPTS,
  DREP_DELEGATOR_SYNC_JOB_NAME,
  drepDelegatorBudgetUtcDay,
  isDrepDelegatorDailyBudgetExhausted,
  parseDrepDelegatorDailyBudget,
  runDrepDelegatorSyncWithDailyRetry,
  serializeDrepDelegatorDailyBudget,
  type DrepDailyBudgetV1,
} from "../src/services/ingestion/drep-delegator-sync-run";

const mockSync = jest.fn();
jest.mock("../src/services/ingestion/delegation-sync.service", () => ({
  syncDrepDelegationChanges: (...args: unknown[]) => mockSync(...args),
}));

jest.mock("../src/services/prisma", () => ({
  prisma: {},
  withDbRead: (_n: string, fn: () => Promise<unknown>) => fn(),
  withDbWrite: (_n: string, fn: () => Promise<unknown>) => fn(),
}));

function baseResult(
  overrides: Partial<{
    skipped: boolean;
    skipReason: string;
    failed: Array<{ drepId: string; error: string }>;
    statesUpdated: number;
    changesInserted: number;
  }> = {}
) {
  return {
    currentEpoch: 500,
    lastProcessedEpoch: 400,
    maxDelegationEpoch: 499,
    drepsProcessed: 3,
    delegatorsProcessed: 10,
    statesUpdated: 1,
    changesInserted: 2,
    failed: [] as Array<{ drepId: string; error: string }>,
    ...overrides,
  };
}

describe("drep delegator daily budget parse / exhaust", () => {
  it("parse null as no state", () => {
    expect(parseDrepDelegatorDailyBudget(null)).toBeNull();
    expect(parseDrepDelegatorDailyBudget("")).toBeNull();
  });

  it("roundtrips serialize", () => {
    const s: DrepDailyBudgetV1 = {
      day: "2026-04-11",
      attempts: 1,
      sealed: false,
    };
    const raw = serializeDrepDelegatorDailyBudget(s);
    expect(parseDrepDelegatorDailyBudget(raw)).toEqual(s);
  });

  it("treats wrong prefix as invalid (exhausted)", () => {
    expect(parseDrepDelegatorDailyBudget("{}")).toBe("invalid");
    expect(isDrepDelegatorDailyBudgetExhausted("{}")).toBe(true);
  });

  it("exhausted when sealed same UTC day", () => {
    const today = drepDelegatorBudgetUtcDay(new Date("2026-04-11T12:00:00.000Z"));
    const raw = serializeDrepDelegatorDailyBudget({
      day: today,
      attempts: 1,
      sealed: true,
    });
    expect(
      isDrepDelegatorDailyBudgetExhausted(raw, new Date("2026-04-11T20:00:00.000Z"))
    ).toBe(true);
  });

  it("not exhausted when day rolled over UTC", () => {
    const raw = serializeDrepDelegatorDailyBudget({
      day: "2026-04-10",
      attempts: 2,
      sealed: true,
    });
    expect(
      isDrepDelegatorDailyBudgetExhausted(raw, new Date("2026-04-11T01:00:00.000Z"))
    ).toBe(false);
  });

  it("exhausted when attempts at cap even if sealed false (defensive)", () => {
    const today = drepDelegatorBudgetUtcDay(new Date("2026-06-01T00:00:00.000Z"));
    const raw = serializeDrepDelegatorDailyBudget({
      day: today,
      attempts: DREP_DELEGATOR_DAILY_MAX_ATTEMPTS,
      sealed: false,
    });
    expect(
      isDrepDelegatorDailyBudgetExhausted(raw, new Date("2026-06-01T12:00:00.000Z"))
    ).toBe(true);
  });
});

describe("runDrepDelegatorSyncWithDailyRetry", () => {
  beforeEach(() => {
    mockSync.mockReset();
  });

  function createDbWithCursor(initial: string | null) {
    let cursor = initial;
    return {
      syncStatus: {
        findUnique: jest.fn().mockImplementation(() =>
          Promise.resolve({
            backfillCursor: cursor,
          })
        ),
        update: jest.fn().mockImplementation(({ data }: { data: { backfillCursor: string } }) => {
          cursor = data.backfillCursor;
          return Promise.resolve({});
        }),
      },
    } as unknown as PrismaClient;
  }

  it("returns skipped without calling persist side effects on sync", async () => {
    const db = createDbWithCursor(null);
    mockSync.mockResolvedValueOnce(
      baseResult({ skipped: true, skipReason: "full-scan-throttle-window" })
    );

    const out = await runDrepDelegatorSyncWithDailyRetry(db);

    expect(out.kind).toBe("skipped");
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(db.syncStatus.update).not.toHaveBeenCalled();
  });

  it("runs second sync when prior=0 and first pass partial", async () => {
    const db = createDbWithCursor(null);
    mockSync
      .mockResolvedValueOnce(baseResult({ failed: [{ drepId: "x", error: "e" }] }))
      .mockResolvedValueOnce(baseResult({ failed: [] }));

    const out = await runDrepDelegatorSyncWithDailyRetry(db);

    expect(out.kind).toBe("completed");
    if (out.kind === "completed") {
      expect(out.lockResult).toBe("success");
      expect(out.itemsProcessed).toBe(6);
    }
    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(db.syncStatus.update).toHaveBeenCalled();
  });

  it("does not run second sync when prior=1 and first pass partial", async () => {
    const priorBlob = serializeDrepDelegatorDailyBudget({
      day: drepDelegatorBudgetUtcDay(),
      attempts: 1,
      sealed: false,
    });
    const db = createDbWithCursor(priorBlob);
    mockSync.mockResolvedValueOnce(
      baseResult({ failed: [{ drepId: "x", error: "e" }] })
    );

    const out = await runDrepDelegatorSyncWithDailyRetry(db);

    expect(out.kind).toBe("completed");
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it("uses job row for prior attempts", () => {
    expect(DREP_DELEGATOR_SYNC_JOB_NAME).toBe("drep-delegator-sync");
  });
});
