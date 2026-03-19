const mockListAllDrepIds = jest.fn();
const mockListAllDrepUpdates = jest.fn();

jest.mock("../src/services/governanceProvider", () => ({
  listAllDrepIds: (...args: unknown[]) => mockListAllDrepIds(...args),
  listAllDrepUpdates: (...args: unknown[]) => mockListAllDrepUpdates(...args),
}));

jest.mock("../src/services/ingestion/sync-utils", () => ({
  DREP_LIFECYCLE_SYNC_CONCURRENCY: 2,
}));

import { syncDrepLifecycleEvents } from "../src/services/ingestion/drep-lifecycle.service";

function createPrismaMock() {
  return {
    drepLifecycleEvent: {
      createMany: jest.fn(),
    },
  } as any;
}

describe("drep-lifecycle.service", () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockListAllDrepIds.mockReset();
    mockListAllDrepUpdates.mockReset();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("normalizes lifecycle actions and returns summary counters from prepared events", async () => {
    const prisma = createPrismaMock();
    prisma.drepLifecycleEvent.createMany.mockResolvedValue({ count: 4 });

    mockListAllDrepIds.mockResolvedValue(["drep_requested"]);
    mockListAllDrepUpdates.mockResolvedValue([
      {
        drep_id: "drep_row",
        action: "registered",
        block_time: 1596059091,
        update_tx_hash: "tx-reg",
      },
      {
        drep_id: "drep_row",
        action: "deregistered",
        block_time: 1596491091,
        update_tx_hash: "tx-dereg",
      },
      {
        drep_id: "drep_row",
        action: "updated",
        block_time: 1596923091,
        update_tx_hash: "tx-update",
      },
      {
        drep_id: "drep_row",
        action: "metadata_change",
        block_time: 1597355091,
        update_tx_hash: "tx-metadata",
      },
    ]);

    const result = await syncDrepLifecycleEvents(prisma);

    expect(prisma.drepLifecycleEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          drepId: "drep_row",
          action: "registration",
          epochNo: 208,
          blockTime: 1596059091,
          txHash: "tx-reg",
        },
        {
          drepId: "drep_row",
          action: "deregistration",
          epochNo: 209,
          blockTime: 1596491091,
          txHash: "tx-dereg",
        },
        {
          drepId: "drep_row",
          action: "update",
          epochNo: 210,
          blockTime: 1596923091,
          txHash: "tx-update",
        },
        {
          drepId: "drep_row",
          action: "update",
          epochNo: 211,
          blockTime: 1597355091,
          txHash: "tx-metadata",
        },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({
      drepsAttempted: 1,
      drepsProcessed: 1,
      drepsWithNoUpdates: 0,
      totalUpdatesFetched: 4,
      eventsIngested: 4,
      eventsByType: {
        registration: 1,
        deregistration: 1,
        update: 2,
      },
      failed: [],
    });
  });

  it("skips rows without block_time and falls back to the requested drep id", async () => {
    const prisma = createPrismaMock();
    prisma.drepLifecycleEvent.createMany.mockResolvedValue({ count: 1 });

    mockListAllDrepIds.mockResolvedValue(["drep_requested"]);
    mockListAllDrepUpdates.mockResolvedValue([
      {
        drep_id: undefined,
        action: "",
        block_time: 1596491091,
        update_tx_hash: "tx-fallback",
      },
      {
        drep_id: "drep_row",
        action: "registered",
        update_tx_hash: "tx-missing-time",
      },
    ]);

    const result = await syncDrepLifecycleEvents(prisma);

    expect(prisma.drepLifecycleEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          drepId: "drep_requested",
          action: "update",
          epochNo: 209,
          blockTime: 1596491091,
          txHash: "tx-fallback",
        },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({
      drepsAttempted: 1,
      drepsProcessed: 1,
      drepsWithNoUpdates: 0,
      totalUpdatesFetched: 2,
      eventsIngested: 1,
      eventsByType: {
        registration: 0,
        deregistration: 0,
        update: 1,
      },
      failed: [],
    });
  });
});
