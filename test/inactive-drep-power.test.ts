function epochToBlockTime(epochNo: number): number {
  const shelleyStart = 1596491091;
  const epochLength = 432000;
  const shelleyStartEpoch = 208;
  return shelleyStart + (epochNo - shelleyStartEpoch) * epochLength;
}

async function loadInactivePowerHarness() {
  jest.resetModules();

  const mockPrisma = {
    onchainVote: {
      findMany: jest.fn(),
    },
    drepLifecycleEvent: {
      findMany: jest.fn(),
    },
  };

  const mockGetDrepInfoBatch = jest.fn();
  const mockListDrepVotingPowerHistory = jest.fn();
  const mockGetDrepUpdates = jest.fn();

  jest.doMock("../src/services/prisma", () => ({
    prisma: mockPrisma,
  }));
  jest.doMock("../src/services/drep-lookup", () => ({
    getDrepInfoBatch: (...args: unknown[]) => mockGetDrepInfoBatch(...args),
  }));
  jest.doMock("../src/services/governanceProvider", () => ({
    listDrepVotingPowerHistory: (...args: unknown[]) =>
      mockListDrepVotingPowerHistory(...args),
    getDrepUpdates: (...args: unknown[]) => mockGetDrepUpdates(...args),
  }));

  const module = await import(
    "../src/services/ingestion/inactiveDrepPower.service"
  );

  return {
    ...module,
    mockPrisma,
    mockGetDrepInfoBatch,
    mockListDrepVotingPowerHistory,
    mockGetDrepUpdates,
  };
}

describe("inactiveDrepPower.service", () => {
  it("uses the run cache when the key is already present", async () => {
    const harness = await loadInactivePowerHarness();
    const runCache = new Map<string, bigint>([["inactive:600:active", BigInt(123)]]);
    const metrics = harness.createInactivePowerMetrics();

    await expect(
      harness.getInactivePowerWithCache(600, true, runCache, metrics)
    ).resolves.toBe(BigInt(123));

    expect(metrics.runCacheHits).toBe(1);
    expect(harness.mockListDrepVotingPowerHistory).not.toHaveBeenCalled();
  });

  it("hydrates the per-run cache from the process cache on repeated requests", async () => {
    const harness = await loadInactivePowerHarness();
    harness.mockListDrepVotingPowerHistory.mockResolvedValue([]);
    harness.mockGetDrepInfoBatch.mockResolvedValue([]);

    await expect(harness.getInactivePowerWithCache(600, true)).resolves.toBe(
      BigInt(0)
    );

    const metrics = harness.createInactivePowerMetrics();
    const runCache = new Map<string, bigint>();
    await expect(
      harness.getInactivePowerWithCache(600, true, runCache, metrics)
    ).resolves.toBe(BigInt(0));

    expect(metrics.processCacheHits).toBe(1);
    expect(runCache.get("inactive:600:active")).toBe(BigInt(0));
    expect(harness.mockListDrepVotingPowerHistory).toHaveBeenCalledTimes(1);
  });

  it("excludes special DRep IDs when calculating active-proposal inactive power", async () => {
    const harness = await loadInactivePowerHarness();
    harness.mockListDrepVotingPowerHistory.mockResolvedValue([
      { drep_id: "drep_always_abstain", epoch_no: 600, amount: "111" },
      { drep_id: "drep_always_no_confidence", epoch_no: 600, amount: "222" },
      { drep_id: "drep-real", epoch_no: 600, amount: "500" },
    ]);
    harness.mockGetDrepInfoBatch.mockResolvedValue([
      { drepId: "drep-real", active: false, votingPower: BigInt(500) },
    ]);

    await expect(harness.getInactivePowerWithCache(600, true)).resolves.toBe(
      BigInt(500)
    );

    expect(harness.mockGetDrepInfoBatch).toHaveBeenCalledWith(
      harness.mockPrisma,
      ["drep-real"]
    );
  });

  it("uses DB activity first and only falls back to Koios lifecycle checks for missing rows", async () => {
    const harness = await loadInactivePowerHarness();
    harness.mockListDrepVotingPowerHistory.mockResolvedValue([
      { drep_id: "drep-voted", epoch_no: 600, amount: "100" },
      { drep_id: "drep-db-lifecycle", epoch_no: 600, amount: "200" },
      { drep_id: "drep-koios-lifecycle", epoch_no: 600, amount: "300" },
      { drep_id: "drep-inactive", epoch_no: 600, amount: "400" },
      { drep_id: "drep_always_abstain", epoch_no: 600, amount: "999" },
    ]);
    harness.mockPrisma.onchainVote.findMany.mockResolvedValue([
      { drepId: "drep-voted" },
    ]);
    harness.mockPrisma.drepLifecycleEvent.findMany
      .mockResolvedValueOnce([{ drepId: "drep-db-lifecycle" }])
      .mockResolvedValueOnce([{ drepId: "drep-db-lifecycle" }]);
    harness.mockGetDrepUpdates.mockImplementation(async (drepId: string) => {
      if (drepId === "drep-koios-lifecycle") {
        return [
          {
            block_time: epochToBlockTime(590),
          },
        ];
      }
      return [];
    });

    await expect(harness.getInactivePowerWithCache(600, false)).resolves.toBe(
      BigInt(400)
    );

    expect(harness.mockGetDrepUpdates).toHaveBeenCalledTimes(2);
    expect(harness.mockGetDrepUpdates).toHaveBeenCalledWith(
      "drep-koios-lifecycle",
      {
        source: "ingestion.proposal.inactive-power.completed.drep-updates",
      }
    );
    expect(harness.mockGetDrepUpdates).toHaveBeenCalledWith("drep-inactive", {
      source: "ingestion.proposal.inactive-power.completed.drep-updates",
    });
  });

  it("does not crash when Koios lifecycle fallback fails for a DRep", async () => {
    const harness = await loadInactivePowerHarness();
    harness.mockListDrepVotingPowerHistory.mockResolvedValue([
      { drep_id: "drep-error", epoch_no: 600, amount: "250" },
    ]);
    harness.mockPrisma.onchainVote.findMany.mockResolvedValue([]);
    harness.mockPrisma.drepLifecycleEvent.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    harness.mockGetDrepUpdates.mockRejectedValue(new Error("Koios timeout"));

    await expect(harness.getInactivePowerWithCache(600, false)).resolves.toBe(
      BigInt(250)
    );
  });
});
