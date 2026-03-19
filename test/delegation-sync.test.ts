const mockGetAccountUpdateHistoryBatch = jest.fn();
const mockGetTxInfoBatch = jest.fn();
const mockListAllDrepDelegators = jest.fn();
const mockSyncAllDrepsInventory = jest.fn();
const mockEnsureDrepsExist = jest.fn();
const mockRefreshDrepDelegatorCounts = jest.fn();
const mockGetKoiosCurrentEpoch = jest.fn();

jest.mock("../src/services/governanceProvider", () => ({
  getAccountUpdateHistoryBatch: (...args: unknown[]) =>
    mockGetAccountUpdateHistoryBatch(...args),
  getTxInfoBatch: (...args: unknown[]) => mockGetTxInfoBatch(...args),
  listAllDrepDelegators: (...args: unknown[]) => mockListAllDrepDelegators(...args),
}));

jest.mock("../src/services/ingestion/drep-sync.service", () => ({
  syncAllDrepsInventory: (...args: unknown[]) => mockSyncAllDrepsInventory(...args),
  ensureDrepsExist: (...args: unknown[]) => mockEnsureDrepsExist(...args),
  refreshDrepDelegatorCountsFromDelegationState: (...args: unknown[]) =>
    mockRefreshDrepDelegatorCounts(...args),
}));

jest.mock("../src/services/ingestion/sync-utils", () => ({
  DREP_DELEGATOR_MIN_VOTING_POWER: BigInt(0),
  DREP_DELEGATION_SYNC_CONCURRENCY: 2,
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
  existingStakeAddresses?: string[];
  existingStates?: Array<{
    stakeAddress: string;
    drepId: string | null;
    amount: bigint | null;
    delegatedEpoch: number | null;
  }>;
  existingChangeRows?: Array<{
    stakeAddress: string;
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
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
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
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        const requested = new Set(where?.stakeAddress?.in ?? []);
        return existingStates.filter((row) => requested.has(row.stakeAddress));
      }),
      createMany: jest.fn().mockImplementation(async ({ data }: any) => ({
        count: data.length,
      })),
      update: jest.fn().mockResolvedValue({}),
    },
    stakeDelegationChange: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        const requested = new Set(where?.stakeAddress?.in ?? []);
        return existingChangeRows.filter((row) => requested.has(row.stakeAddress));
      }),
      createMany: jest.fn().mockImplementation(async ({ data }: any) => ({
        count: data.length,
      })),
    },
    stakeDelegationSyncState: {
      upsert: jest.fn().mockResolvedValue(syncState),
      update: jest.fn().mockResolvedValue({}),
    },
    syncStatus: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        switch (where?.jobName) {
          case "drep-delegation-backfill":
            return options.backfillStatus ?? null;
          case "drep-delegation-phase3":
            return options.phase3Status ?? null;
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
    mockGetAccountUpdateHistoryBatch.mockReset();
    mockGetTxInfoBatch.mockReset();
    mockListAllDrepDelegators.mockReset();
    mockSyncAllDrepsInventory.mockReset();
    mockEnsureDrepsExist.mockReset();
    mockRefreshDrepDelegatorCounts.mockReset();
    mockGetKoiosCurrentEpoch.mockReset();
    mockGetKoiosCurrentEpoch.mockResolvedValue(602);
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

    expect(mockGetAccountUpdateHistoryBatch).not.toHaveBeenCalled();
    expect(mockGetTxInfoBatch).not.toHaveBeenCalled();
    expect(prisma.stakeDelegationState.update).toHaveBeenCalledWith({
      where: { stakeAddress: "stake_test1" },
      data: {
        drepId: "drep_new",
        amount: BigInt(100),
        delegatedEpoch: 601,
      },
    });
    expect(prisma.stakeDelegationChange.createMany).not.toHaveBeenCalled();
    expect(mockEnsureDrepsExist).not.toHaveBeenCalled();
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
});
