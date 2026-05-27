/**
 * GET /dreps controller — guards the I11 invariants:
 *  - Hot path (all DReps have denormalized firstSeenEpoch + proposalParticipationPercent
 *    columns populated): no on-fly groupBy fallback, response uses the column values.
 *  - Cold-start fallback (at least one DRep missing a denorm column): the on-fly
 *    groupBy path runs and the response merges denorm + computed values.
 *  - Response shape carries the two new optional fields with correct precision.
 *  - Strict query-param validation (I4) returns 400 on garbage input.
 */

async function loadHarness() {
  jest.resetModules();

  const drepCountMock = jest.fn();
  const drepFindManyMock = jest.fn();
  const onchainVoteGroupByMock = jest.fn();
  const drepLifecycleGroupByMock = jest.fn();
  const proposalCountMock = jest.fn();

  jest.doMock("../src/services", () => ({
    prisma: {
      drep: {
        count: drepCountMock,
        findMany: drepFindManyMock,
      },
      onchainVote: { groupBy: onchainVoteGroupByMock },
      drepLifecycleEvent: { groupBy: drepLifecycleGroupByMock },
      proposal: { count: proposalCountMock },
    },
  }));

  const { getDReps } = await import("../src/controllers/drep/getDReps");
  return {
    getDReps,
    drepCountMock,
    drepFindManyMock,
    onchainVoteGroupByMock,
    drepLifecycleGroupByMock,
    proposalCountMock,
  };
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe("GET /dreps", () => {
  it("hot path: when ALL DReps have denorm columns populated, skips the on-fly groupBy fallback", async () => {
    const h = await loadHarness();
    h.drepCountMock.mockResolvedValue(2);
    h.drepFindManyMock.mockResolvedValue([
      {
        drepId: "drep1aaa",
        name: "Alpha",
        iconUrl: null,
        votingPower: 5_000_000_000n,
        delegatorCount: 10,
        firstSeenEpoch: 600,
        proposalParticipationPercent: 42.5,
      },
      {
        drepId: "drep1bbb",
        name: "Beta",
        iconUrl: null,
        votingPower: 1_000_000_000n,
        delegatorCount: 3,
        firstSeenEpoch: 605,
        proposalParticipationPercent: 12.34,
      },
    ]);
    // Vote counts always queried, regardless of denorm state.
    h.onchainVoteGroupByMock.mockResolvedValue([
      { drepId: "drep1aaa", _count: { id: 5 } },
      { drepId: "drep1bbb", _count: { id: 1 } },
    ]);

    const res = makeRes();
    await h.getDReps({ query: {} } as any, res);

    expect(res.statusCode).toBe(200);
    // Cold-start groupBy paths must NOT have been called.
    expect(h.drepLifecycleGroupByMock).not.toHaveBeenCalled();
    expect(h.proposalCountMock).not.toHaveBeenCalled();
    // The denorm columns are echoed straight through.
    expect(res.body.dreps[0]).toMatchObject({
      drepId: "drep1aaa",
      firstSeenEpoch: 600,
      proposalParticipationPercent: 42.5,
      votingPower: "5000000000",
      votingPowerAda: "5000.000000",
      totalVotesCast: 5,
    });
    expect(res.body.dreps[1]).toMatchObject({
      drepId: "drep1bbb",
      firstSeenEpoch: 605,
      proposalParticipationPercent: 12.34,
    });
  });

  it("cold-start fallback: when at least one DRep is missing a denorm column, the on-fly groupBy fills the gap", async () => {
    const h = await loadHarness();
    h.drepCountMock.mockResolvedValue(2);
    h.drepFindManyMock.mockResolvedValue([
      {
        drepId: "drep1aaa",
        name: null,
        iconUrl: null,
        votingPower: 1n,
        delegatorCount: 0,
        firstSeenEpoch: null, // ← missing
        proposalParticipationPercent: null, // ← missing
      },
      {
        drepId: "drep1bbb",
        name: null,
        iconUrl: null,
        votingPower: 2n,
        delegatorCount: 0,
        firstSeenEpoch: 700,
        proposalParticipationPercent: 50,
      },
    ]);
    h.onchainVoteGroupByMock
      // First call: total vote counts (always)
      .mockResolvedValueOnce([
        { drepId: "drep1aaa", _count: { id: 0 } },
        { drepId: "drep1bbb", _count: { id: 7 } },
      ])
      // Second call: distinct (drepId, proposalId) pairs (cold-start branch)
      .mockResolvedValueOnce([
        { drepId: "drep1bbb", proposalId: "p1" },
        { drepId: "drep1bbb", proposalId: "p2" },
      ]);
    h.drepLifecycleGroupByMock.mockResolvedValue([
      { drepId: "drep1aaa", _min: { epochNo: 690 } },
    ]);
    h.proposalCountMock.mockResolvedValue(4);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = makeRes();
      await h.getDReps({ query: {} } as any, res);

      expect(res.statusCode).toBe(200);
      // Cold-start groupBy paths must HAVE been called.
      expect(h.drepLifecycleGroupByMock).toHaveBeenCalledTimes(1);
      expect(h.proposalCountMock).toHaveBeenCalledTimes(1);
      // For drep1aaa (no denorm): firstSeenEpoch came from drepLifecycleEvent groupBy
      // and proposalParticipationPercent came from on-fly compute (0/4 = 0).
      const aaa = res.body.dreps.find((d: any) => d.drepId === "drep1aaa");
      expect(aaa.firstSeenEpoch).toBe(690);
      expect(aaa.proposalParticipationPercent).toBe(0);
      // drep1bbb keeps its denorm values even though we ran the fallback.
      const bbb = res.body.dreps.find((d: any) => d.drepId === "drep1bbb");
      expect(bbb.firstSeenEpoch).toBe(700);
      expect(bbb.proposalParticipationPercent).toBe(50);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects garbage page query param with 400 (was a NaN→default landmine before I4)", async () => {
    const h = await loadHarness();
    const res = makeRes();
    await h.getDReps({ query: { page: "abc" } } as any, res);
    expect(res.statusCode).toBe(400);
    expect(h.drepFindManyMock).not.toHaveBeenCalled();
  });

  it("rejects out-of-range pageSize with 400", async () => {
    const h = await loadHarness();
    const res = makeRes();
    await h.getDReps({ query: { pageSize: "99999" } } as any, res);
    expect(res.statusCode).toBe(400);
  });

  it("clamps and accepts a valid pageSize within bounds", async () => {
    const h = await loadHarness();
    h.drepCountMock.mockResolvedValue(0);
    h.drepFindManyMock.mockResolvedValue([]);
    h.onchainVoteGroupByMock.mockResolvedValue([]);
    const res = makeRes();
    await h.getDReps({ query: { pageSize: "50" } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.pagination.pageSize).toBe(50);
  });
});
