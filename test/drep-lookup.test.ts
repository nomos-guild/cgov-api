const mockGetDrepInfoBatchFromKoios = jest.fn();

jest.mock("../src/services/governanceProvider", () => ({
  getDrepInfoBatchFromKoios: (...args: unknown[]) =>
    mockGetDrepInfoBatchFromKoios(...args),
}));

import { getDrepInfoBatch } from "../src/services/drep-lookup";

function createPrismaMock() {
  return {
    drep: {
      findMany: jest.fn(),
      createMany: jest.fn(),
    },
  } as any;
}

describe("drep-lookup", () => {
  beforeEach(() => {
    mockGetDrepInfoBatchFromKoios.mockReset();
  });

  it("uses batched createMany with skipDuplicates for missing dreps", async () => {
    const prisma = createPrismaMock();
    prisma.drep.findMany.mockResolvedValue([]);
    prisma.drep.createMany.mockResolvedValue({ count: 2 });
    mockGetDrepInfoBatchFromKoios.mockResolvedValue([
      {
        drep_id: "drep1",
        amount: "10",
        registered: true,
        active: true,
        expires_epoch_no: 200,
        meta_url: "https://example.com/1",
        meta_hash: "hash1",
      },
      {
        drep_id: "drep2",
        amount: "20",
        registered: false,
        active: false,
        expires_epoch_no: 201,
        meta_url: "https://example.com/2",
        meta_hash: "hash2",
      },
    ]);

    const results = await getDrepInfoBatch(prisma, ["drep1", "drep2"]);

    expect(prisma.drep.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.drep.createMany).toHaveBeenCalledWith({
      data: [
        {
          drepId: "drep1",
          votingPower: BigInt(10),
          registered: true,
          active: true,
          expiresEpoch: 200,
          metaUrl: "https://example.com/1",
          metaHash: "hash1",
        },
        {
          drepId: "drep2",
          votingPower: BigInt(20),
          registered: false,
          active: false,
          expiresEpoch: 201,
          metaUrl: "https://example.com/2",
          metaHash: "hash2",
        },
      ],
      skipDuplicates: true,
    });
    expect(results).toEqual([
      {
        drepId: "drep1",
        votingPower: BigInt(10),
        registered: true,
        active: true,
        expiresEpoch: 200,
        metaUrl: "https://example.com/1",
        metaHash: "hash1",
      },
      {
        drepId: "drep2",
        votingPower: BigInt(20),
        registered: false,
        active: false,
        expiresEpoch: 201,
        metaUrl: "https://example.com/2",
        metaHash: "hash2",
      },
    ]);
  });
});
