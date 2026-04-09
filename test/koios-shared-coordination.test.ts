const mockFindUnique = jest.fn();
const mockExecuteRaw = jest.fn();
const mockQueryRaw = jest.fn();
const mockUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock("../src/services/prisma", () => ({
  prisma: {
    syncStatus: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
  withDbRead: jest.fn(async (_scope: string, operation: () => Promise<unknown>) =>
    operation()
  ),
  withDbWrite: jest.fn(async (_scope: string, operation: () => Promise<unknown>) =>
    operation()
  ),
}));

import {
  getKoiosSharedCooldownSnapshot,
  mergeKoiosSharedCooldown,
} from "../src/services/koios/sharedCoordination";

describe("koios shared coordination", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockExecuteRaw.mockReset();
    mockQueryRaw.mockReset();
    mockUpdate.mockReset();
    mockTransaction.mockReset();
    mockTransaction.mockImplementation(async (callback: any) =>
      callback({
        $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
        syncStatus: {
          update: (...args: unknown[]) => mockUpdate(...args),
        },
      })
    );
  });

  it("returns empty snapshot when no row exists", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(getKoiosSharedCooldownSnapshot()).resolves.toEqual({
      backoffUntil: 0,
      pressureCooldownUntil: 0,
      timeoutCooldownUntil: 0,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it("merges cooldown timestamps using max semantics", async () => {
    mockQueryRaw.mockResolvedValue([
      {
        backfill_cursor: JSON.stringify({
          backoffUntil: 1000,
          pressureCooldownUntil: 3000,
          timeoutCooldownUntil: 1500,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      },
    ]);
    mockUpdate.mockResolvedValue({});

    const merged = await mergeKoiosSharedCooldown({
      backoffUntil: 8000,
      pressureCooldownUntil: 2000,
      timeoutCooldownUntil: 9000,
      source: "unit-test",
    });

    expect(merged.backoffUntil).toBe(8000);
    expect(merged.pressureCooldownUntil).toBe(3000);
    expect(merged.timeoutCooldownUntil).toBe(9000);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobName: "koios-shared-coordination" },
        data: expect.objectContaining({
          backfillCursor: expect.any(String),
        }),
      })
    );
  });
});
