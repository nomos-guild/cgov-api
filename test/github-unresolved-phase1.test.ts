import { withRetry } from "../src/services/ingestion/utils";

describe("phase 1 unresolved repo hardening", () => {
  it("fails fast for deterministic GitHub unresolved errors", async () => {
    const unresolvedError = new Error(
      "GitHub GraphQL errors: Could not resolve to a Repository with the name 'owner/missing'"
    ) as Error & {
      name: string;
      errors: Array<{ message: string }>;
    };
    unresolvedError.name = "GitHubGraphQLError";
    unresolvedError.errors = [
      {
        message:
          "Could not resolve to a Repository with the name 'owner/missing'.",
      },
    ];

    const operation = jest.fn(async () => {
      throw unresolvedError;
    });

    await expect(
      withRetry(operation, {
        maxRetries: 4,
        baseDelay: 0,
        maxDelay: 0,
      })
    ).rejects.toBe(unresolvedError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("rethrows the original error after retry exhaustion", async () => {
    const transientError = new Error("socket hang up") as Error & {
      code: string;
    };
    transientError.code = "ECONNRESET";

    const operation = jest.fn(async () => {
      throw transientError;
    });

    await expect(
      withRetry(operation, {
        maxRetries: 1,
        baseDelay: 0,
        maxDelay: 0,
      })
    ).rejects.toBe(transientError);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("continues snapshot batch after removing unresolved repositories", async () => {
    jest.resetModules();

    const mockGithubGraphQL = jest.fn();
    const mockBuildBatchRepoQuery = jest.fn(
      (repos: Array<{ owner: string; name: string }>, _fragment: string) =>
        repos.map((repo) => `${repo.owner}/${repo.name}`).join(",")
    );
    const mockGetRateLimitState = jest.fn(() => ({ remaining: 4999 }));

    class MockGitHubGraphQLError extends Error {
      readonly errors: Array<{ message: string }>;

      constructor(messages: string[]) {
        super(`GitHub GraphQL errors: ${messages.join("; ")}`);
        this.name = "GitHubGraphQLError";
        this.errors = messages.map((message) => ({ message }));
      }
    }

    const mockPrisma = {
      githubRepository: {
        findMany: jest.fn().mockResolvedValue([
          { id: "repo_unresolved", owner: "owner", name: "missing" },
          { id: "repo_healthy", owner: "owner", name: "healthy" },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      repoDailySnapshot: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };

    const healthyRepoData = {
      stargazerCount: 5,
      forkCount: 1,
      openIssueCount: { totalCount: 2 },
      watchers: { totalCount: 3 },
    };

    mockGithubGraphQL
      .mockRejectedValueOnce(
        new MockGitHubGraphQLError([
          "Could not resolve to a Repository with the name 'owner/missing'.",
        ])
      )
      .mockResolvedValueOnce({ repo0: healthyRepoData });

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
    jest.doMock("../src/services/ingestion/dbFailFast", () => ({
      shouldFailFastForDb: jest.fn(() => false),
      recordDbFailureForFailFast: jest.fn(),
    }));
    jest.doMock("../src/services/ingestion/githubSharedCoordination", () => ({
      incrementGithubRepoHealthCounter: jest.fn(async () => 1),
    }));
    jest.doMock("../src/services/github-graphql", () => ({
      githubGraphQL: (...args: unknown[]) => mockGithubGraphQL(...args),
      buildBatchRepoQuery: (
        repos: Array<{ owner: string; name: string }>,
        fragment: string
      ) => mockBuildBatchRepoQuery(repos, fragment),
      getRateLimitState: () => mockGetRateLimitState(),
      GitHubGraphQLError: MockGitHubGraphQLError,
    }));

    const activityModule = await import("../src/services/ingestion/github-activity");
    const result = await activityModule.snapshotAllRepos();

    expect(result.success).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toContainEqual({
      repo: "repo_unresolved",
      error: "GitHub repo unresolved (not found or inaccessible)",
    });
    expect(mockGithubGraphQL).toHaveBeenCalledTimes(2);
    expect(mockBuildBatchRepoQuery).toHaveBeenNthCalledWith(
      1,
      [
        { owner: "owner", name: "missing" },
        { owner: "owner", name: "healthy" },
      ],
      expect.any(String)
    );
    expect(mockBuildBatchRepoQuery).toHaveBeenNthCalledWith(
      2,
      [{ owner: "owner", name: "healthy" }],
      expect.any(String)
    );
  });
});
