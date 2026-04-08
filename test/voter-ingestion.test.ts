const mockKoiosGet = jest.fn();
const mockKoiosPost = jest.fn();
const mockGetCommitteeInfo = jest.fn();
const mockGetKoiosCurrentEpoch = jest.fn();
const mockFetchPoolMetadata = jest.fn();

jest.mock("../src/services/koios", () => ({
  koiosGet: (...args: unknown[]) => mockKoiosGet(...args),
  koiosPost: (...args: unknown[]) => mockKoiosPost(...args),
}));

jest.mock("../src/services/governanceProvider", () => ({
  getCommitteeInfo: (...args: unknown[]) => mockGetCommitteeInfo(...args),
}));

jest.mock("../src/services/ingestion/sync-utils", () => ({
  getKoiosCurrentEpoch: (...args: unknown[]) => mockGetKoiosCurrentEpoch(...args),
}));

jest.mock("../src/services/remoteMetadata.service", () => ({
  fetchPoolMetadata: (...args: unknown[]) => mockFetchPoolMetadata(...args),
}));

jest.mock("../src/services/committeeState.service", () => ({
  getCachedEligibleCCInfo: jest.fn(),
  getEligibleCCInfo: jest.fn(),
  syncCommitteeState: jest.fn(),
}));

import {
  clearVoterKoiosCaches,
  ensureVoterExists,
  preloadVotersForVotes,
} from "../src/services/ingestion/voterIngestion.service";

function createTxMock() {
  return {
    drep: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    sPO: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      findUnique: jest.fn(),
    },
    cC: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      findUnique: jest.fn(),
    },
  } as any;
}

describe("voterIngestion.service", () => {
  beforeEach(() => {
    clearVoterKoiosCaches();
    mockKoiosGet.mockReset();
    mockKoiosPost.mockReset();
    mockGetCommitteeInfo.mockReset();
    mockGetKoiosCurrentEpoch.mockReset();
    mockFetchPoolMetadata.mockReset();
  });

  it("handles SPO duplicate-safe inserts by returning the existing voter", async () => {
    const tx = createTxMock();
    tx.drep.findMany.mockResolvedValue([]);
    tx.sPO.findMany.mockResolvedValue([]);
    tx.cC.findMany.mockResolvedValue([]);
    mockKoiosPost.mockResolvedValue([{ pool_id_bech32: "pool1" }]);
    mockKoiosGet.mockResolvedValue([{ amount: "100" }]);
    mockFetchPoolMetadata.mockResolvedValue({
      poolName: "Pool One",
      ticker: "P1",
      iconUrl: null,
    });
    tx.sPO.createMany.mockResolvedValue({ count: 0 });
    tx.sPO.findUnique.mockResolvedValue({ poolId: "pool1" });

    await expect(ensureVoterExists("SPO", "pool1", tx)).resolves.toEqual({
      voterId: "pool1",
      created: false,
      updated: false,
    });

    expect(tx.sPO.createMany).toHaveBeenCalledTimes(1);
    expect(tx.sPO.findUnique).toHaveBeenCalledWith({
      where: { poolId: "pool1" },
    });
  });

  it("handles CC duplicate-safe inserts by returning the existing voter", async () => {
    const tx = createTxMock();
    tx.drep.findMany.mockResolvedValue([]);
    tx.sPO.findMany.mockResolvedValue([]);
    tx.cC.findMany.mockResolvedValue([]);
    mockGetCommitteeInfo.mockResolvedValue({
      members: [{ cc_hot_id: "cc_hot1", cc_cold_id: "cc_cold1", expiration_epoch: 999 }],
    });
    mockGetKoiosCurrentEpoch.mockResolvedValue(500);
    tx.cC.createMany.mockResolvedValue({ count: 0 });
    tx.cC.findUnique.mockResolvedValue({ ccId: "cc_hot1" });

    await expect(
      ensureVoterExists("ConstitutionalCommittee", "cc_hot1", tx)
    ).resolves.toEqual({
      voterId: "cc_hot1",
      created: false,
      updated: false,
    });

    expect(tx.cC.createMany).toHaveBeenCalledTimes(1);
    expect(tx.cC.findUnique).toHaveBeenCalledWith({
      where: { ccId: "cc_hot1" },
    });
  });

  it("preloads voters once per unique role/id pair", async () => {
    const tx = createTxMock();
    tx.drep.findMany.mockResolvedValue([{ drepId: "drep_existing" }]);
    tx.sPO.findMany.mockResolvedValue([{ poolId: "pool_existing" }]);
    tx.cC.findMany.mockResolvedValue([]);
    tx.cC.createMany.mockResolvedValue({ count: 1 });
    mockGetCommitteeInfo.mockResolvedValue({
      members: [{ cc_hot_id: "cc_new", cc_cold_id: "cold_new", expiration_epoch: 999 }],
    });
    mockGetKoiosCurrentEpoch.mockResolvedValue(500);

    const preloaded = await preloadVotersForVotes(
      [
        { voterRole: "DRep", voterId: "drep_existing" },
        { voterRole: "DRep", voterId: "drep_existing" },
        { voterRole: "SPO", voterId: "pool_existing" },
        { voterRole: "ConstitutionalCommittee", voterId: "cc_new" },
      ],
      tx
    );

    expect(preloaded.size).toBe(3);
    expect(preloaded.get("DRep:drep_existing")).toEqual({
      voterId: "drep_existing",
      created: false,
      updated: false,
    });
    expect(preloaded.get("SPO:pool_existing")).toEqual({
      voterId: "pool_existing",
      created: false,
      updated: false,
    });
    expect(preloaded.get("ConstitutionalCommittee:cc_new")).toEqual({
      voterId: "cc_new",
      created: true,
      updated: false,
    });
    expect(tx.cC.createMany).toHaveBeenCalledTimes(1);
  });
});
