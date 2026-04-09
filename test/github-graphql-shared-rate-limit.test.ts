const getGithubSharedRateLimitSnapshot = jest.fn();
const mergeGithubSharedRateLimitCooldown = jest.fn();

jest.mock("../src/services/ingestion/githubSharedCoordination", () => ({
  getGithubSharedRateLimitSnapshot: (...args: unknown[]) =>
    getGithubSharedRateLimitSnapshot(...args),
  mergeGithubSharedRateLimitCooldown: (...args: unknown[]) =>
    mergeGithubSharedRateLimitCooldown(...args),
}));

jest.mock("../src/services/ingestion/utils", () => ({
  withRetry: async <T>(operation: () => Promise<T>) => operation(),
}));

describe("github graphql shared rate-limit coordination", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.GH_API_TOKEN = "test-token";
    getGithubSharedRateLimitSnapshot.mockResolvedValue({
      cooldownUntilMs: 0,
      updatedAt: new Date(0).toISOString(),
    });
    mergeGithubSharedRateLimitCooldown.mockResolvedValue({
      cooldownUntilMs: 0,
      updatedAt: new Date().toISOString(),
    });
  });

  it("publishes shared cooldown when local rate-limit becomes constrained", async () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          viewer: { login: "test" },
          rateLimit: { cost: 1, remaining: 10, resetAt },
        },
      }),
      headers: new Headers(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = fetchMock;

    const module = await import("../src/services/github-graphql");
    const result = await module.githubGraphQL<{ viewer: { login: string } }>(
      "query { viewer { login } }"
    );

    expect(result.viewer.login).toBe("test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getGithubSharedRateLimitSnapshot).toHaveBeenCalledTimes(1);
    expect(mergeGithubSharedRateLimitCooldown).toHaveBeenCalledTimes(1);
    expect(mergeGithubSharedRateLimitCooldown.mock.calls[0][0]).toBeGreaterThan(
      Date.now()
    );
  });
});
