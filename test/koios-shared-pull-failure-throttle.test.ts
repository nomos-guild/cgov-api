const mockAxiosGet = jest.fn();
const mockAxiosCreate = jest.fn();
const mockGetKoiosSharedCooldownSnapshot = jest.fn();
const mockMergeKoiosSharedCooldown = jest.fn();

jest.mock("axios", () => {
  return {
    __esModule: true,
    default: {
      create: (...args: unknown[]) => mockAxiosCreate(...args),
    },
    create: (...args: unknown[]) => mockAxiosCreate(...args),
  };
});

jest.mock("../src/services/koios/sharedCoordination", () => ({
  getKoiosSharedCooldownSnapshot: (...args: unknown[]) =>
    mockGetKoiosSharedCooldownSnapshot(...args),
  mergeKoiosSharedCooldown: (...args: unknown[]) =>
    mockMergeKoiosSharedCooldown(...args),
}));

describe("koios shared cooldown pull failure throttling", () => {
  beforeEach(() => {
    jest.resetModules();
    mockAxiosGet.mockReset();
    mockAxiosCreate.mockReset();
    mockGetKoiosSharedCooldownSnapshot.mockReset();
    mockMergeKoiosSharedCooldown.mockReset();

    mockAxiosGet.mockResolvedValue({ data: [], headers: {} });
    mockAxiosCreate.mockReturnValue({
      get: (...args: unknown[]) => mockAxiosGet(...args),
      post: jest.fn(),
      interceptors: {
        response: {
          use: jest.fn(),
        },
      },
    });
    mockGetKoiosSharedCooldownSnapshot.mockRejectedValue(
      new Error("db-read-failed")
    );
    mockMergeKoiosSharedCooldown.mockResolvedValue({
      backoffUntil: 0,
      pressureCooldownUntil: 0,
      timeoutCooldownUntil: 0,
      updatedAt: new Date().toISOString(),
    });
  });

  it("backs off shared pull attempts after a pull failure", async () => {
    const { koiosGet } = await import("../src/services/koios");

    await koiosGet("/tip", undefined, { source: "test.koios.pull.1" });
    await koiosGet("/tip", undefined, { source: "test.koios.pull.2" });

    expect(mockGetKoiosSharedCooldownSnapshot).toHaveBeenCalledTimes(1);
  });
});
