import type { Request, Response } from "express";
import { GITHUB_LOCK_KEYS } from "../src/services/ingestion/githubLockKeys";

const acquireJobLock = jest.fn();
const releaseJobLock = jest.fn();

jest.mock("../src/services/ingestion/syncLock", () => ({
  acquireJobLock: (...args: unknown[]) => acquireJobLock(...args),
  releaseJobLock: (...args: unknown[]) => releaseJobLock(...args),
}));

jest.mock("../src/services/ingestion/github-discovery", () => ({
  discoverRepositories: jest.fn(async () => ({
    total: 0,
    newRepos: 0,
    updatedRepos: 0,
    errors: [],
  })),
}));
jest.mock("../src/services/ingestion/github-activity", () => ({
  syncActiveRepos: jest.fn(async () => ({
    total: 0,
    success: 0,
    failed: 0,
    eventsCreated: 0,
    developersUpserted: 0,
    snapshotsTaken: 0,
    errors: [],
  })),
  syncModerateRepos: jest.fn(async () => ({
    total: 0,
    success: 0,
    failed: 0,
    eventsCreated: 0,
    developersUpserted: 0,
    snapshotsTaken: 0,
    errors: [],
  })),
  syncDormantRepos: jest.fn(async () => ({
    total: 0,
    success: 0,
    failed: 0,
    eventsCreated: 0,
    developersUpserted: 0,
    snapshotsTaken: 0,
    errors: [],
  })),
  snapshotAllRepos: jest.fn(async () => ({
    total: 0,
    success: 0,
    failed: 0,
    errors: [],
  })),
}));
jest.mock("../src/services/ingestion/github-backfill", () => ({
  backfillRepositories: jest.fn(async () => ({
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  })),
}));
jest.mock("../src/services/ingestion/github-aggregation", () => ({
  aggregateRecentToHistorical: jest.fn(async () => ({
    daysRolledUp: 0,
    rowsDeleted: 0,
    developersUpdated: 0,
  })),
  precomputeNetworkGraphs: jest.fn(async () => undefined),
}));
jest.mock("../src/services/cache", () => ({
  cacheInvalidatePrefix: jest.fn(),
}));

function createResponse(): Response {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { status } as unknown as Response;
}

describe("github trigger lock key parity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    acquireJobLock.mockResolvedValue(true);
    releaseJobLock.mockResolvedValue(undefined);
  });

  it("uses normalized lock keys across discovery/backfill/snapshot/aggregate", async () => {
    const trigger = await import("../src/controllers/data/triggerGithub");

    await trigger.postTriggerGithubDiscovery({} as Request, createResponse());
    await trigger.postTriggerGithubBackfill(
      { query: {} } as Request,
      createResponse()
    );
    await trigger.postTriggerGithubSnapshot({} as Request, createResponse());
    await trigger.postTriggerGithubAggregate({} as Request, createResponse());

    expect(acquireJobLock).toHaveBeenCalledWith(
      GITHUB_LOCK_KEYS.discovery,
      expect.any(String),
      expect.any(Object)
    );
    expect(acquireJobLock).toHaveBeenCalledWith(
      GITHUB_LOCK_KEYS.backfill,
      expect.any(String),
      expect.any(Object)
    );
    expect(acquireJobLock).toHaveBeenCalledWith(
      GITHUB_LOCK_KEYS.snapshot,
      expect.any(String),
      expect.any(Object)
    );
    expect(acquireJobLock).toHaveBeenCalledWith(
      GITHUB_LOCK_KEYS.aggregation,
      expect.any(String),
      expect.any(Object)
    );
  });

  it("uses one shared activity lock key for all sync tiers", async () => {
    const trigger = await import("../src/controllers/data/triggerGithub");
    const tiers = ["active", "moderate", "dormant", "all"];
    for (const tier of tiers) {
      await trigger.postTriggerGithubSync(
        { query: { tier } } as unknown as Request,
        createResponse()
      );
    }
    const activityCalls = acquireJobLock.mock.calls.filter(
      (call) => call[0] === GITHUB_LOCK_KEYS.activity
    );
    expect(activityCalls).toHaveLength(4);
  });
});
