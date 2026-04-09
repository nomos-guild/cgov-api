describe("github activity recent insert fallback", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("falls back to row-wise inserts and writes deterministic non-null ids", async () => {
    const nowIso = new Date().toISOString();
    const mockPrisma = {
      githubRepository: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "owner/repo",
            owner: "owner",
            name: "repo",
            syncTier: "active",
            isActive: true,
            lastSyncedAt: new Date(0),
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      repoDailySnapshot: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      githubDeveloper: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      developerRepoActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      activityRecent: {
        create: jest.fn().mockResolvedValue({
          id: "ignored-by-test",
          repoId: "owner/repo",
          eventType: "commit",
          authorLogin: "alice",
          eventDate: new Date(nowIso),
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockRejectedValue(new Error("raw insert failed")),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    jest.doMock("../src/services/prisma", () => ({
      prisma: mockPrisma,
    }));
    jest.doMock("../src/services/ingestion/dbSession", () => ({
      withIngestionDbRead: async (
        _db: unknown,
        _operation: string,
        fn: () => Promise<unknown>
      ) => fn(),
      withIngestionDbWrite: async (
        _db: unknown,
        _operation: string,
        fn: () => Promise<unknown>
      ) => fn(),
    }));
    jest.doMock("../src/services/ingestion/dbFailFast", () => ({
      shouldFailFastForDb: jest.fn(() => false),
      recordDbFailureForFailFast: jest.fn(),
    }));
    jest.doMock("../src/services/ingestion/githubSharedCoordination", () => ({
      incrementGithubRepoHealthCounter: jest.fn(async () => 1),
    }));
    jest.doMock("../src/services/github-graphql", () => ({
      githubGraphQL: jest.fn(async () => ({
        repo0: {
          defaultBranchRef: {
            target: {
              history: {
                nodes: [
                  {
                    oid: "abcdef1234567890",
                    message: "commit message",
                    committedDate: nowIso,
                    additions: 1,
                    deletions: 0,
                    author: { user: { login: "alice", avatarUrl: "x" } },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
          pullRequests: { nodes: [] },
          recentIssues: { nodes: [] },
          releases: { nodes: [] },
          stargazerCount: 1,
          forkCount: 1,
          openIssueCount: { totalCount: 0 },
          watchers: { totalCount: 1 },
        },
      })),
      buildBatchRepoQuery: jest.fn(
        () =>
          'query { repo0: repository(owner:"owner", name:"repo") { stargazerCount } }'
      ),
      getRateLimitState: jest.fn(() => ({ remaining: 5000 })),
    }));

    const activity = await import("../src/services/ingestion/github-activity");
    const result = await activity.syncActiveRepos();

    expect(result.eventsCreated).toBe(1);
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.activityRecent.create).toHaveBeenCalledTimes(1);
    const [createArg] = mockPrisma.activityRecent.create.mock.calls[0];
    expect(createArg.data.id).toMatch(/^gha_[0-9a-f]{48}$/);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("uses the same deterministic id across retries and skips duplicate fallback conflicts", async () => {
    const nowIso = new Date().toISOString();
    const seenIds: string[] = [];
    const mockPrisma = {
      githubRepository: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "owner/repo",
            owner: "owner",
            name: "repo",
            syncTier: "active",
            isActive: true,
            lastSyncedAt: new Date(0),
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      repoDailySnapshot: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      githubDeveloper: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      developerRepoActivity: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      activityRecent: {
        create: jest.fn().mockImplementation(async ({ data }: { data: { id: string } }) => {
          seenIds.push(data.id);
          if (seenIds.length === 2) {
            const duplicateError = Object.assign(new Error("duplicate"), {
              code: "P2002",
            });
            throw duplicateError;
          }
          return {
            id: data.id,
            repoId: "owner/repo",
            eventType: "commit",
            authorLogin: "alice",
            eventDate: new Date(nowIso),
          };
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockRejectedValue(new Error("raw insert failed")),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    jest.doMock("../src/services/prisma", () => ({
      prisma: mockPrisma,
    }));
    jest.doMock("../src/services/ingestion/dbSession", () => ({
      withIngestionDbRead: async (
        _db: unknown,
        _operation: string,
        fn: () => Promise<unknown>
      ) => fn(),
      withIngestionDbWrite: async (
        _db: unknown,
        _operation: string,
        fn: () => Promise<unknown>
      ) => fn(),
    }));
    jest.doMock("../src/services/ingestion/dbFailFast", () => ({
      shouldFailFastForDb: jest.fn(() => false),
      recordDbFailureForFailFast: jest.fn(),
    }));
    jest.doMock("../src/services/ingestion/githubSharedCoordination", () => ({
      incrementGithubRepoHealthCounter: jest.fn(async () => 1),
    }));
    jest.doMock("../src/services/github-graphql", () => ({
      githubGraphQL: jest.fn(async () => ({
        repo0: {
          defaultBranchRef: {
            target: {
              history: {
                nodes: [
                  {
                    oid: "abcdef1234567890",
                    message: "commit message",
                    committedDate: nowIso,
                    additions: 1,
                    deletions: 0,
                    author: { user: { login: "alice", avatarUrl: "x" } },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
          pullRequests: { nodes: [] },
          recentIssues: { nodes: [] },
          releases: { nodes: [] },
          stargazerCount: 1,
          forkCount: 1,
          openIssueCount: { totalCount: 0 },
          watchers: { totalCount: 1 },
        },
      })),
      buildBatchRepoQuery: jest.fn(
        () =>
          'query { repo0: repository(owner:"owner", name:"repo") { stargazerCount } }'
      ),
      getRateLimitState: jest.fn(() => ({ remaining: 5000 })),
    }));

    const activity = await import("../src/services/ingestion/github-activity");
    const first = await activity.syncActiveRepos();
    const second = await activity.syncActiveRepos();

    expect(first.eventsCreated).toBe(1);
    expect(second.eventsCreated).toBe(0);
    expect(seenIds).toHaveLength(2);
    expect(seenIds[0]).toBe(seenIds[1]);
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(3);
  });
});
