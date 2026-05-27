/**
 * /healthz readiness probe — pins the I10 contract:
 *  - 200 on ok/fresh/skipped/starting (boot in progress, no failure)
 *  - 503 on degraded (boot recovery failed)
 *  - status field reflects the underlying boot state machine
 */

async function loadHarness() {
  jest.resetModules();
  const getStatusMock = jest.fn();
  jest.doMock("../src/services/ingestion/snapshot-builder.service", () => ({
    getSnapshotBootRecoveryStatus: () => getStatusMock(),
  }));
  const { getHealthz } = await import("../src/controllers/healthz/getHealthz");
  return { getHealthz, getStatusMock };
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

describe("GET /healthz", () => {
  it.each([
    ["ok", "ok", 200],
    ["fresh", "ok", 200],
    ["running", "starting", 200],
    ["not-started", "starting", 200],
    ["skipped", "skipped", 200],
    ["failed", "degraded", 503],
  ])(
    "boot state '%s' → status '%s' with HTTP %d",
    async (bootState, expectedStatus, expectedHttp) => {
      const h = await loadHarness();
      h.getStatusMock.mockReturnValue({
        state: bootState,
        startedAt: "2026-05-09T00:00:00.000Z",
        finishedAt: bootState === "running" || bootState === "not-started" ? null : "2026-05-09T00:00:01.000Z",
        durationMs: bootState === "running" || bootState === "not-started" ? null : 1000,
        errorMessage: bootState === "failed" ? "Koios outage" : null,
        l2Fresh: bootState === "fresh" || bootState === "ok" ? true : null,
      });

      const res = makeRes();
      h.getHealthz({} as any, res);

      expect(res.statusCode).toBe(expectedHttp);
      expect(res.body.status).toBe(expectedStatus);
      expect(res.body.snapshotBootRecovery.state).toBe(bootState);
    }
  );

  it("includes errorMessage in the body when degraded", async () => {
    const h = await loadHarness();
    h.getStatusMock.mockReturnValue({
      state: "failed",
      startedAt: "2026-05-09T00:00:00.000Z",
      finishedAt: "2026-05-09T00:00:01.000Z",
      durationMs: 1000,
      errorMessage: "Koios /tip 503",
      l2Fresh: null,
    });
    const res = makeRes();
    h.getHealthz({} as any, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.snapshotBootRecovery.errorMessage).toBe("Koios /tip 503");
  });
});
