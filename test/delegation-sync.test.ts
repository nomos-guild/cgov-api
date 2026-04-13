const mockGetAccountInfoBatch = jest.fn();
const mockGetAccountUpdateHistoryBatch = jest.fn();
const mockGetTxInfoBatch = jest.fn();
const mockListAllDrepDelegators = jest.fn();
const mockSyncAllDrepsInventory = jest.fn();
const mockEnsureDrepsExist = jest.fn();
const mockRefreshDrepDelegatorCounts = jest.fn();
const mockGetKoiosCurrentEpoch = jest.fn();

jest.mock("../src/services/ingestion/delegation-writer-lock", () => ({
  tryAcquireDelegationWriterLock: jest.fn().mockResolvedValue(true),
  releaseDelegationWriterLock: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/services/governanceProvider", () => ({
  getAccountInfoBatch: (...args: unknown[]) => mockGetAccountInfoBatch(...args),
  getAccountUpdateHistoryBatch: (...args: unknown[]) =>
    mockGetAccountUpdateHistoryBatch(...args),
  getTxInfoBatch: (...args: unknown[]) => mockGetTxInfoBatch(...args),
  listAllDrepDelegators: (...args: unknown[]) => mockListAllDrepDelegators(...args),
}));

jest.mock("../src/services/ingestion/drep-sync.service", () => {
  const actual = jest.requireActual(
    "../src/services/ingestion/drep-sync.service"
  ) as typeof import("../src/services/ingestion/drep-sync.service");
  return {
    ...actual,
    syncAllDrepsInventory: (...args: unknown[]) => mockSyncAllDrepsInventory(...args),
    ensureDrepsExist: (...args: unknown[]) => mockEnsureDrepsExist(...args),
    refreshDrepDelegatorCountsForDrepIds: (...args: unknown[]) =>
      mockRefreshDrepDelegatorCounts(...args),
  };
});

jest.mock("../src/services/ingestion/sync-utils", () => ({
  DREP_DELEGATOR_MIN_VOTING_POWER: BigInt(0),
  DREP_DELEGATION_SYNC_CONCURRENCY: 4,
  DREP_DELEGATION_SHARD_COUNT: 8,
  DREP_DELEGATION_ACCOUNT_INFO_MAX_STAKES_PER_RUN: 2500,
  DREP_DELEGATION_FULL_ALL_DREPS_MIN_INTERVAL_DAYS: 7,
  DREP_DELEGATION_DB_UPDATE_CONCURRENCY: 2,
  STAKE_DELEGATION_SYNC_STATE_ID: "stake-delegation-sync",
  DREP_DELEGATION_BACKFILL_JOB_NAME: "drep-delegation-backfill",
  FORCE_DREP_DELEGATION_BACKFILL_JOB_NAME: "drep-delegation-backfill-force",
  DREP_DELEGATION_PHASE3_JOB_NAME: "drep-delegation-phase3",
  KOIOS_ACCOUNT_UPDATE_HISTORY_BATCH_SIZE: 1000,
  chunkArray: <T>(items: T[], size: number) => {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  },
  getKoiosCurrentEpoch: (...args: unknown[]) => mockGetKoiosCurrentEpoch(...args),
}));

import { syncDrepDelegationChanges } from "../src/services/ingestion/delegation-sync.service";

type PrismaMockOptions = {
  backfillStatus?: any;
  phase3Status?: any;
  clearGuardStatus?: any;
  existingStakeAddresses?: string[];
  existingStates?: Array<{
    stakeAddress: string;
    drepId: string | null;
    amount: bigint | null;
    delegatedEpoch: number | null;
  }>;
  existingChangeRows?: Array<{
    stakeAddress: string;
    fromDrepId: string;
    toDrepId: string;
    delegatedEpoch: number;
  }>;
  drepRows?: Array<{ drepId: string }>;
  syncState?: { lastProcessedEpoch: number | null };
  recentDrepSync?: any;
};

function createPrismaMock(options: PrismaMockOptions = {}) {
  const existingStakeAddresses = new Set(options.existingStakeAddresses ?? []);
  const existingStates = options.existingStates ?? [];
  const existingChangeRows = options.existingChangeRows ?? [];
  const drepRows = options.drepRows ?? [{ drepId: "drep_target" }];
  const syncState = options.syncState ?? { lastProcessedEpoch: 600 };

  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]),
    $transaction: undefined as any,
    drep: {
      findMany: jest.fn().mockResolvedValue(drepRows),
    },
    epochAnalyticsSync: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.recentDrepSync ?? { epoch: 600, drepsSyncedAt: new Date() }
        ),
    },
    stakeAddress: {
      findMany: jest.fn().mockImplementation(async (args: any) => {
        const where = args?.where;
        if (where?.stakeAddress?.gt !== undefined) {
          return [];
        }
        const requested = where?.stakeAddress?.in ?? [];
        return requested
          .filter((stakeAddress: string) => existingStakeAddresses.has(stakeAddress))
          .map((stakeAddress: string) => ({ stakeAddress }));
      }),
      createMany: jest.fn().mockImplementation(async ({ data }: any) => ({
        count: data.length,
      })),
    },
    stakeDelegationState: {
      count: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where?.drepId?.not === null) {
          return existingStates.filter((row) => row.drepId !== null).length;
        }
        return 0;
      }),
      findMany: jest.fn().mockImplementation(async (args: any) => {
        const where = args?.where;
        if (where?.drepId?.not === null) {
          let rows = existingStates
            .filter((row) => row.drepId !== null)
            .map((row) => ({ stakeAddress: row.stakeAddress }))
            .sort((a, b) => a.stakeAddress.localeCompare(b.stakeAddress));
          if (args?.cursor?.stakeAddress) {
            const idx = rows.findIndex((r) => r.stakeAddress === args.cursor.stakeAddress);
            if (idx >= 0) {
              const skip = args.skip ?? 0;
              rows = rows.slice(idx + skip);
            }
          }
          const take = args.take;
          if (typeof take === "number") {
            rows = rows.slice(0, take);
          }
          return rows;
        }
        const requested = new Set(where?.stakeAddress?.in ?? []);
        return existingStates.filter((row) => requested.has(row.stakeAddress));
      }),
      createMany: jest.fn().mockImplementation(async ({ data }: any) => ({
        count: data.length,
      })),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const row = existingStates.find((state) => state.stakeAddress === where?.stakeAddress);
        if (row) {
          row.drepId = data?.drepId ?? row.drepId;
          row.amount = data?.amount ?? row.amount;
          row.delegatedEpoch = data?.delegatedEpoch ?? row.delegatedEpoch;
        }
        return {};
      }),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const requested = new Set(where?.stakeAddress?.in ?? []);
        let count = 0;
        for (const row of existingStates) {
          if (requested.has(row.stakeAddress) && row.drepId !== null) {
            row.drepId = data?.drepId ?? null;
            row.amount = data?.amount ?? null;
            row.delegatedEpoch = data?.delegatedEpoch ?? null;
            count += 1;
          }
        }
        return { count };
      }),
    },
    stakeDelegationChange: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        const orFilters = where?.OR;
        if (Array.isArray(orFilters) && orFilters.length > 0) {
          return existingChangeRows.filter((row) =>
            orFilters.some(
              (entry: any) =>
                entry?.stakeAddress === row.stakeAddress &&
                entry?.fromDrepId === row.fromDrepId &&
                entry?.toDrepId === row.toDrepId &&
                entry?.delegatedEpoch === row.delegatedEpoch
            )
          );
        }
        const requested = new Set(where?.stakeAddress?.in ?? []);
        return existingChangeRows.filter((row) => requested.has(row.stakeAddress));
      }),
      createMany: jest.fn().mockImplementation(async ({ data, skipDuplicates }: any) => {
        if (!skipDuplicates) {
          return { count: data.length };
        }
        let inserted = 0;
        for (const row of data) {
          const exists = existingChangeRows.some(
            (e) =>
              e.stakeAddress === row.stakeAddress &&
              e.fromDrepId === row.fromDrepId &&
              e.toDrepId === row.toDrepId &&
              e.delegatedEpoch === row.delegatedEpoch
          );
          if (!exists) {
            inserted += 1;
            existingChangeRows.push({
              stakeAddress: row.stakeAddress,
              fromDrepId: row.fromDrepId,
              toDrepId: row.toDrepId,
              delegatedEpoch: row.delegatedEpoch,
            });
          }
        }
        return { count: inserted };
      }),
    },
    stakeDelegationSyncState: {
      upsert: jest.fn().mockResolvedValue(syncState),
      update: jest.fn().mockResolvedValue({}),
    },
    delegationSyncCheckpoint: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({
        id: "default",
        accountInfoStakeCursor: null,
        drepShardIndex: 0,
        phase3CheckpointJson: null,
        lastFullAllDrepsScanAt: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    stakeDelegationStaging: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    syncStatus: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        switch (where?.jobName) {
          case "drep-delegation-backfill":
            return options.backfillStatus ?? null;
          case "drep-delegation-phase3":
            return options.phase3Status ?? null;
          case "drep-delegation-clear-guard":
            return options.clearGuardStatus ?? null;
          case "drep-delegation-backfill-force":
            return null;
          default:
            return null;
        }
      }),
      upsert: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where?.jobName === "drep-delegation-backfill") {
          return {
            backfillCursor: options.backfillStatus?.backfillCursor ?? null,
            backfillItemsProcessed:
              options.backfillStatus?.backfillItemsProcessed ?? 0,
          };
        }

        return {};
      }),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;

  return prisma;
}

describe("delegation-sync.service", () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGetAccountInfoBatch.mockReset();
    mockGetAccountUpdateHistoryBatch.mockReset();
    mockGetTxInfoBatch.mockReset();
    mockListAllDrepDelegators.mockReset();
    mockSyncAllDrepsInventory.mockReset();
    mockEnsureDrepsExist.mockReset();
    mockRefreshDrepDelegatorCounts.mockReset();
    mockGetKoiosCurrentEpoch.mockReset();
    mockGetKoiosCurrentEpoch.mockResolvedValue(602);
    mockGetAccountInfoBatch.mockResolvedValue([]);
    mockGetAccountUpdateHistoryBatch.mockResolvedValue([]);
    mockGetTxInfoBatch.mockResolvedValue([]);
    mockRefreshDrepDelegatorCounts.mockResolvedValue({ updated: 0 });
    mockEnsureDrepsExist.mockResolvedValue({ created: 0 });
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("backfills missing drep ids through tx info and creates current state rows for new stake addresses", async () => {
    const prisma = createPrismaMock({
      existingStakeAddresses: [],
      existingStates: [],
      backfillStatus: null,
      drepRows: [{ drepId: "drep_target" }],
    });

    mockListAllDrepDelegators.mockResolvedValue([
      {
        stake_address: "stake_test1",
        amount: "100",
        epoch_no: 602,
      },
    ]);
    mockGetAccountUpdateHistoryBatch.mockResolvedValue([
      {
        stake_address: "stake_test1",
        action_type: "delegation_drep",
        tx_hash: "tx-history-1",
        epoch_no: 600,
        absolute_slot: 123,
      },
    ]);
    mockGetTxInfoBatch.mockResolvedValue([
      {
        tx_hash: "tx-history-1",
        certificates: [
          {
            type: "vote_delegation",
            info: {
              stake_address: "stake_test1",
              drep_id: "drep_target",
            },
          },
        ],
      },
    ]);

    const result = await syncDrepDelegationChanges(prisma);

    expect(mockGetTxInfoBatch).toHaveBeenCalledWith(
      ["tx-history-1"],
      expect.objectContaining({
        includeCerts: true,
        source: "ingestion.delegation-sync.tx-info",
      })
    );
    expect(prisma.stakeDelegationChange.createMany).toHaveBeenCalledWith({
      data: [
        {
          stakeAddress: "stake_test1",
          fromDrepId: "",
          toDrepId: "drep_target",
          delegatedEpoch: 600,
        },
      ],
      skipDuplicates: true,
    });
    expect(prisma.stakeDelegationState.createMany).toHaveBeenCalledWith({
      data: [
        {
          stakeAddress: "stake_test1",
          drepId: "drep_target",
          amount: BigInt(100),
          delegatedEpoch: 602,
        },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({
      currentEpoch: 602,
      lastProcessedEpoch: 600,
      maxDelegationEpoch: 602,
      drepsProcessed: 1,
      delegatorsProcessed: 1,
      statesUpdated: 1,
      changesInserted: 0,
      failed: [],
    });
    expect(mockSyncAllDrepsInventory).not.toHaveBeenCalled();
  });

  it("counts phase 3 changesInserted from rows inserted (skipDuplicates)", async () => {
    const prisma = createPrismaMock({
      backfillStatus: { backfillCompletedAt: new Date() },
      existingStakeAddresses: ["stake_test1"],
      existingStates: [
        {
          stakeAddress: "stake_test1",
          drepId: "drep_old",
          amount: BigInt(50),
          delegatedEpoch: 600,
        },
      ],
      existingChangeRows: [],
      drepRows: [{ drepId: "drep_new" }],
    });
    mockListAllDrepDelegators.mockResolvedValue([
      { stake_address: "stake_test1", amount: "100", epoch_no: 601 },
    ]);
    const result = await syncDrepDelegationChanges(prisma);
    expect(result.changesInserted).toBe(1);
  });

  it("updates existing states without inserting duplicate phase-3 change rows", async () => {
    const prisma = createPrismaMock({
      backfillStatus: {
        backfillCompletedAt: new Date(),
      },
      existingStakeAddresses: ["stake_test1"],
      existingStates: [
        {
          stakeAddress: "stake_test1",
          drepId: "drep_old",
          amount: BigInt(50),
          delegatedEpoch: 600,
        },
      ],
      existingChangeRows: [
        {
          stakeAddress: "stake_test1",
          fromDrepId: "drep_old",
          toDrepId: "drep_new",
          delegatedEpoch: 601,
        },
      ],
      drepRows: [{ drepId: "drep_new" }],
    });

    mockListAllDrepDelegators.mockResolvedValue([
      {
        stake_address: "stake_test1",
        amount: "100",
        epoch_no: 601,
      },
    ]);

    const result = await syncDrepDelegationChanges(prisma);

    expect(mockGetAccountUpdateHistoryBatch).toHaveBeenCalledTimes(1);
    expect(mockGetTxInfoBatch).toHaveBeenCalledTimes(0);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.stakeDelegationChange.createMany).toHaveBeenCalledWith({
      data: [
        {
          stakeAddress: "stake_test1",
          fromDrepId: "drep_old",
          toDrepId: "drep_new",
          delegatedEpoch: 601,
        },
      ],
      skipDuplicates: true,
    });
    expect(mockEnsureDrepsExist).toHaveBeenCalledWith(
      prisma,
      expect.arrayContaining(["drep_old", "drep_new"])
    );
    expect(result).toEqual({
      currentEpoch: 602,
      lastProcessedEpoch: 600,
      maxDelegationEpoch: 601,
      drepsProcessed: 1,
      delegatorsProcessed: 1,
      statesUpdated: 1,
      changesInserted: 0,
      failed: [],
    });
  });

  it("selects all non-special dreps without voting power gating", async () => {
    const prisma = createPrismaMock({
      drepRows: [{ drepId: "drep_target" }],
    });
    mockListAllDrepDelegators.mockResolvedValue([]);

    await syncDrepDelegationChanges(prisma);

    expect(prisma.drep.findMany).toHaveBeenCalledWith({
      select: { drepId: true },
      where: {
        drepId: { notIn: ["drep_always_abstain", "drep_always_no_confidence"] },
      },
      orderBy: { drepId: "asc" },
    });
  });

  it("reconciles stale delegated stake states absent from Koios snapshot", async () => {
    const prisma = createPrismaMock({
      existingStakeAddresses: ["stake_kept", "stake_stale"],
      existingStates: [
        {
          stakeAddress: "stake_kept",
          drepId: "drep_target",
          amount: BigInt(100),
          delegatedEpoch: 601,
        },
        {
          stakeAddress: "stake_stale",
          drepId: "drep_old",
          amount: BigInt(55),
          delegatedEpoch: 600,
        },
      ],
      drepRows: [{ drepId: "drep_target" }],
    });
    mockListAllDrepDelegators.mockResolvedValue([
      {
        stake_address: "stake_kept",
        amount: "100",
        epoch_no: 601,
      },
    ]);

    const result = await syncDrepDelegationChanges(prisma);

    expect(prisma.stakeDelegationState.updateMany).toHaveBeenCalledWith({
      where: {
        stakeAddress: { in: ["stake_stale"] },
        drepId: { not: null },
      },
      data: {
        drepId: null,
        amount: null,
        delegatedEpoch: null,
      },
    });
    expect(result.statesUpdated).toBe(1);
  });

  it("resolves duplicate stake conflicts deterministically using account history", async () => {
    const prisma = createPrismaMock({
      backfillStatus: {
        backfillCompletedAt: new Date(),
      },
      existingStakeAddresses: ["stake_dupe"],
      existingStates: [],
      drepRows: [{ drepId: "drep_a" }, { drepId: "drep_b" }],
    });

    mockListAllDrepDelegators.mockImplementation(async ({ drepId }: any) => {
      if (drepId === "drep_a") {
        return [{ stake_address: "stake_dupe", amount: "100", epoch_no: 601 }];
      }
      return [{ stake_address: "stake_dupe", amount: "100", epoch_no: 601 }];
    });
    mockGetAccountUpdateHistoryBatch.mockResolvedValue([
      {
        stake_address: "stake_dupe",
        action_type: "delegation_drep",
        epoch_no: 601,
        epoch_slot: 200,
        block_time: 1_700_000_000,
        delegated_drep: "drep_b",
      },
    ]);

    await syncDrepDelegationChanges(prisma);

    expect(prisma.stakeDelegationState.createMany).toHaveBeenCalledWith({
      data: [
        {
          stakeAddress: "stake_dupe",
          drepId: "drep_b",
          amount: BigInt(100),
          delegatedEpoch: 601,
        },
      ],
      skipDuplicates: true,
    });
  });

  it("blocks destructive clears on low-coverage snapshots until confirmation", async () => {
    const existingStates = Array.from({ length: 300 }, (_, index) => ({
      stakeAddress: `stake_${index}`,
      drepId: "drep_old",
      amount: BigInt(10),
      delegatedEpoch: 600,
    }));
    const prisma = createPrismaMock({
      backfillStatus: { backfillCompletedAt: new Date() },
      existingStakeAddresses: existingStates.map((row) => row.stakeAddress),
      existingStates,
      drepRows: [{ drepId: "drep_target" }],
    });

    mockListAllDrepDelegators.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        stake_address: `stake_${index}`,
        amount: "100",
        epoch_no: 601,
      }))
    );

    const result = await syncDrepDelegationChanges(prisma);

    expect(prisma.stakeDelegationState.updateMany).not.toHaveBeenCalled();
    expect(prisma.syncStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobName: "drep-delegation-clear-guard" },
        update: expect.objectContaining({
          lastResult: "error",
        }),
      })
    );
    expect(result.statesUpdated).toBe(10);
  });

  it("allows destructive clears after repeated suspicious snapshot confirmation", async () => {
    const existingStates = Array.from({ length: 300 }, (_, index) => ({
      stakeAddress: `stake_${index}`,
      drepId: "drep_old",
      amount: BigInt(10),
      delegatedEpoch: 600,
    }));
    const prisma = createPrismaMock({
      backfillStatus: { backfillCompletedAt: new Date() },
      clearGuardStatus: {
        errorMessage: JSON.stringify({
          pendingConfirmation: true,
          fingerprint: "300|10|290",
        }),
      },
      existingStakeAddresses: existingStates.map((row) => row.stakeAddress),
      existingStates,
      drepRows: [{ drepId: "drep_target" }],
    });

    mockListAllDrepDelegators.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        stake_address: `stake_${index}`,
        amount: "100",
        epoch_no: 601,
      }))
    );

    await syncDrepDelegationChanges(prisma);

    const expectedClear = new Set(
      Array.from({ length: 290 }, (_, index) => `stake_${index + 10}`)
    );
    const updateCall = prisma.stakeDelegationState.updateMany.mock.calls[0]?.[0];
    expect(updateCall?.where?.drepId).toEqual({ not: null });
    expect(updateCall?.data).toEqual({
      drepId: null,
      amount: null,
      delegatedEpoch: null,
    });
    expect(new Set(updateCall?.where?.stakeAddress?.in ?? [])).toEqual(expectedClear);
  });

  it("skips delegator count refresh when no DRep counts change", async () => {
    const prisma = createPrismaMock({
      existingStakeAddresses: ["stake_kept"],
      existingStates: [
        {
          stakeAddress: "stake_kept",
          drepId: "drep_target",
          amount: BigInt(100),
          delegatedEpoch: 601,
        },
      ],
      drepRows: [{ drepId: "drep_target" }],
    });
    mockListAllDrepDelegators.mockResolvedValue([
      {
        stake_address: "stake_kept",
        amount: "100",
        epoch_no: 601,
      },
    ]);

    const result = await syncDrepDelegationChanges(prisma);

    expect(mockRefreshDrepDelegatorCounts).not.toHaveBeenCalled();
    expect(result.statesUpdated).toBe(0);
  });

  it("fails closed and skips writes when fetch failures exceed fixed threshold", async () => {
    // maxFetchFailures = min(DREP_DELEGATION_MAX_FETCH_FAILURES, max(1, drepIds.length)).
    // With default cap 10, need more than 10 failures while still having enough dreps (e.g. 12 dreps, 11 fail).
    const drepRows = [
      { drepId: "drep_ok" },
      ...Array.from({ length: 11 }, (_, i) => ({ drepId: `drep_fail_${i}` })),
    ];
    const prisma = createPrismaMock({ drepRows });
    mockListAllDrepDelegators.mockImplementation(async ({ drepId }: any) => {
      if (drepId.startsWith("drep_fail")) {
        throw new Error("koios failure");
      }
      return [
        {
          stake_address: "stake_ok",
          amount: "100",
          epoch_no: 601,
        },
      ];
    });

    const result = await syncDrepDelegationChanges(prisma);

    expect(prisma.stakeDelegationState.createMany).not.toHaveBeenCalled();
    expect(prisma.stakeDelegationState.update).not.toHaveBeenCalled();
    expect(prisma.stakeDelegationState.updateMany).not.toHaveBeenCalled();
    expect(prisma.stakeDelegationChange.createMany).not.toHaveBeenCalled();
    expect(mockRefreshDrepDelegatorCounts).not.toHaveBeenCalled();
    expect(result.statesUpdated).toBe(0);
    expect(result.failed).toHaveLength(11);
  });

  it("continues with partial fetch failures under threshold and skips stale clears", async () => {
    const prisma = createPrismaMock({
      drepRows: [{ drepId: "drep_ok" }, { drepId: "drep_fail" }],
      existingStates: [
        {
          stakeAddress: "stake_stale",
          drepId: "drep_old",
          amount: BigInt(10),
          delegatedEpoch: 600,
        },
      ],
    });
    mockListAllDrepDelegators.mockImplementation(async ({ drepId }: any) => {
      if (drepId === "drep_fail") {
        throw new Error("koios failure");
      }
      return [
        {
          stake_address: "stake_ok",
          amount: "100",
          epoch_no: 601,
        },
      ];
    });

    const result = await syncDrepDelegationChanges(prisma);

    expect(prisma.stakeDelegationState.createMany).toHaveBeenCalled();
    expect(prisma.stakeDelegationState.updateMany).not.toHaveBeenCalled();
    expect(mockRefreshDrepDelegatorCounts).toHaveBeenCalledTimes(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.drepId).toBe("drep_fail");
  });
});
