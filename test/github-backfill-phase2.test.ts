describe("phase 2 backfill hardening", () => {
  const repo = {
    id: "repo_unresolved",
    owner: "owner",
    name: "missing",
    stars: 10,
  };

  class MockGitHubGraphQLError extends Error {
    readonly errors: Array<{ message: string }>;

    constructor(messages: string[]) {
      super(`GitHub GraphQL errors: ${messages.join("; ")}`);
      this.name = "GitHubGraphQLError";
      this.errors = messages.map((message) => ({ message }));
    }
  }

  function makeMockPrisma() {
    return {
      githubRepository: {
        findMany: jest.fn().mockResolvedValue([repo]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      activityHistorical: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      githubDeveloper: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      developerRepoActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
  }

  beforeEach(() => {
    jest.resetModules();
  });

  it("deactivates unresolved repos using activity-sync threshold semantics", async () => {
    const mockPrisma = makeMockPrisma();
    const mockGithubGraphQL = jest.fn().mockRejectedValue(
      new MockGitHubGraphQLError([
        "Could not resolve to a Repository with the name 'owner/missing'.",
      ])
    );
    const counterState = {
      backfillTransient: new Map<string, number>(),
      backfillUnresolved: new Map<string, number>(),
    };

    jest.doMock("../src/services/prisma", () => ({
      prisma: mockPrisma,
      withDbRead: async (
        _operation: string,
        fn: () => Promise<unknown>
      ) => fn(),
      withDbWrite: async (
        _operation: string,
        fn: () => Promise<unknown>
      ) => fn(),
    }));
    jest.doMock("../src/services/ingestion/githubSharedCoordination", () => ({
      incrementGithubRepoHealthCounter: jest.fn(
        async (kind: "backfillTransient" | "backfillUnresolved", repoId: string) => {
          const current = counterState[kind].get(repoId) ?? 0;
          const next = current + 1;
          counterState[kind].set(repoId, next);
          return next;
        }
      ),
      clearGithubRepoHealthCounters: jest.fn(
        async (
          repoId: string,
          kinds: Array<"backfillTransient" | "backfillUnresolved">
        ) => {
          for (const kind of kinds) {
            counterState[kind].delete(repoId);
          }
        }
      ),
    }));
    jest.doMock("../src/services/github-graphql", () => ({
      githubGraphQL: (...args: unknown[]) => mockGithubGraphQL(...args),
      getRateLimitState: () => ({ remaining: 5000 }),
    }));

    const backfillModule = await import(
      "../src/services/ingestion/github-backfill"
    );

    const first = await backfillModule.backfillRepositories({
      limit: 1,
      minRateLimit: 0,
    });
    const second = await backfillModule.backfillRepositories({
      limit: 1,
      minRateLimit: 0,
    });

    expect(first.failed).toBe(1);
    expect(second.failed).toBe(1);
    expect(first.errors[0]).toEqual({
      repo: repo.id,
      error: "GitHub repo unresolved (not found or inaccessible)",
    });
    expect(second.errors[0]).toEqual({
      repo: repo.id,
      error: "GitHub repo unresolved (not found or inaccessible)",
    });
    expect(mockPrisma.githubRepository.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.githubRepository.updateMany).toHaveBeenCalledWith({
      where: { id: repo.id, isActive: true },
      data: { isActive: false },
    });
  });

  it("keeps transient 503 handling and deactivates only on transient threshold", async () => {
    const transientError = new Error("GitHub GraphQL 503: Service Unavailable");
    const mockPrisma = makeMockPrisma();
    const mockGithubGraphQL = jest.fn().mockRejectedValue(transientError);
    const counterState = {
      backfillTransient: new Map<string, number>(),
      backfillUnresolved: new Map<string, number>(),
    };

    jest.doMock("../src/services/prisma", () => ({
      prisma: mockPrisma,
      withDbRead: async (
        _operation: string,
        fn: () => Promise<unknown>
      ) => fn(),
      withDbWrite: async (
        _operation: string,
        fn: () => Promise<unknown>
      ) => fn(),
    }));
    jest.doMock("../src/services/ingestion/githubSharedCoordination", () => ({
      incrementGithubRepoHealthCounter: jest.fn(
        async (kind: "backfillTransient" | "backfillUnresolved", repoId: string) => {
          const current = counterState[kind].get(repoId) ?? 0;
          const next = current + 1;
          counterState[kind].set(repoId, next);
          return next;
        }
      ),
      clearGithubRepoHealthCounters: jest.fn(
        async (
          repoId: string,
          kinds: Array<"backfillTransient" | "backfillUnresolved">
        ) => {
          for (const kind of kinds) {
            counterState[kind].delete(repoId);
          }
        }
      ),
    }));
    jest.doMock("../src/services/github-graphql", () => ({
      githubGraphQL: (...args: unknown[]) => mockGithubGraphQL(...args),
      getRateLimitState: () => ({ remaining: 5000 }),
    }));

    const backfillModule = await import(
      "../src/services/ingestion/github-backfill"
    );

    const runOne = await backfillModule.backfillRepositories({
      limit: 1,
      minRateLimit: 0,
    });
    const runTwo = await backfillModule.backfillRepositories({
      limit: 1,
      minRateLimit: 0,
    });
    const runThree = await backfillModule.backfillRepositories({
      limit: 1,
      minRateLimit: 0,
    });

    expect(runOne.errors[0]).toEqual({
      repo: repo.id,
      error: transientError.message,
    });
    expect(runTwo.errors[0]).toEqual({
      repo: repo.id,
      error: transientError.message,
    });
    expect(runThree.errors[0]).toEqual({
      repo: repo.id,
      error: transientError.message,
    });
    expect(mockPrisma.githubRepository.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.githubRepository.updateMany).toHaveBeenCalledWith({
      where: { id: repo.id, isActive: true },
      data: { isActive: false },
    });
  });
});
