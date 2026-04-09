describe("github activity inserted-only stats updates", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("does not increment developer_repo_activity when no rows are newly inserted", async () => {
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
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
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
                    committedDate: new Date().toISOString(),
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
      buildBatchRepoQuery: jest.fn(() => "query { repo0: repository(owner:\"owner\", name:\"repo\") { stargazerCount } }"),
      getRateLimitState: jest.fn(() => ({ remaining: 5000 })),
    }));

    const activity = await import("../src/services/ingestion/github-activity");
    await activity.syncActiveRepos();

    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    const [templateStrings] = mockPrisma.$queryRaw.mock.calls[0];
    const sqlText = Array.isArray(templateStrings)
      ? templateStrings.join(" ")
      : String(templateStrings);
    expect(sqlText).toContain('WITH incoming(\n              "id"');
    expect(sqlText).toContain('INSERT INTO "activity_recent"');
    expect(mockPrisma.developerRepoActivity.upsert).not.toHaveBeenCalled();
  });
});
