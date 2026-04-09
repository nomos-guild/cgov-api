const proposalUpdateMock = jest.fn();
const mockGetProposalVotingSummary = jest.fn();
const mockGetDrepEpochSummary = jest.fn();
const mockListPoolVotingPowerHistory = jest.fn();
const mockGetInactivePowerWithCache = jest.fn();
const mockGetKoiosPressureState = jest.fn(() => ({
  active: false,
  remainingMs: 0,
  eventCount: 0,
  threshold: 0,
  cooldownUntil: 0,
}));

jest.mock("../src/services/prisma", () => ({
  prisma: {
    proposal: {
      update: proposalUpdateMock,
    },
  },
  withDbRead: jest.fn(async (_scope: string, operation: () => Promise<unknown>) =>
    operation()
  ),
  withDbWrite: jest.fn(async (_scope: string, operation: () => Promise<unknown>) =>
    operation()
  ),
}));

jest.mock("../src/services/governanceProvider", () => ({
  getProposalVotingSummary: (...args: unknown[]) =>
    mockGetProposalVotingSummary(...args),
  getDrepEpochSummary: (...args: unknown[]) =>
    mockGetDrepEpochSummary(...args),
  listPoolVotingPowerHistory: (...args: unknown[]) =>
    mockListPoolVotingPowerHistory(...args),
}));

jest.mock("../src/services/ingestion/inactiveDrepPower.service", () => ({
  DREP_INACTIVITY_START_EPOCH: 527,
  getInactivePowerWithCache: (...args: unknown[]) =>
    mockGetInactivePowerWithCache(...args),
}));

jest.mock("../src/services/koios", () => ({
  getKoiosPressureState: () => mockGetKoiosPressureState(),
}));

import { updateProposalVotingPower } from "../src/services/ingestion/proposalVotingPower.service";
import { prisma } from "../src/services/prisma";

describe("proposalVotingPower.service", () => {
  beforeEach(() => {
    jest.useRealTimers();
    proposalUpdateMock.mockReset();
    mockGetProposalVotingSummary.mockReset();
    mockGetDrepEpochSummary.mockReset();
    mockListPoolVotingPowerHistory.mockReset();
    mockGetInactivePowerWithCache.mockReset();
    mockGetKoiosPressureState.mockReset();
    mockGetKoiosPressureState.mockReturnValue({
      active: false,
      remainingMs: 0,
      eventCount: 0,
      threshold: 0,
      cooldownUntil: 0,
    });
  });

  it("returns a failed result when Koios does not return a voting summary", async () => {
    mockGetProposalVotingSummary.mockResolvedValue(null);

    await expect(
      updateProposalVotingPower(prisma as any, "gov_action1missing", 600, 599, 600, true)
    ).resolves.toEqual({
      success: false,
      error: "No voting summary available from Koios",
      summaryFound: false,
      outcome: "missing-summary",
      skipped: true,
      skippedReason: "missing-summary",
      partial: true,
      partialReasons: ["missing-summary"],
      retryAttempts: 0,
      summaryDurationMs: expect.any(Number),
    });

    expect(proposalUpdateMock).not.toHaveBeenCalled();
  });

  it("skips inactive DRep calculation before epoch 527", async () => {
    mockGetProposalVotingSummary.mockResolvedValue({
      drep_active_yes_vote_power: "10",
      drep_active_no_vote_power: "20",
      drep_active_abstain_vote_power: "30",
      drep_always_abstain_vote_power: "40",
      drep_always_no_confidence_vote_power: "50",
      pool_active_yes_vote_power: "60",
      pool_active_no_vote_power: "70",
      pool_active_abstain_vote_power: "80",
      pool_passive_always_abstain_vote_power: "90",
      pool_passive_always_no_confidence_vote_power: "100",
      pool_no_vote_power: "110",
    });
    mockGetDrepEpochSummary.mockResolvedValue({ amount: "999" });
    mockListPoolVotingPowerHistory.mockResolvedValue([]);

    const result = await updateProposalVotingPower(
      prisma as any,
      "gov_action1before527",
      600,
      599,
      526,
      true
    );

    expect(result).toEqual({
      success: true,
      summaryFound: true,
      outcome: "updated",
      retryAttempts: 0,
      summaryDurationMs: expect.any(Number),
    });
    expect(mockGetInactivePowerWithCache).not.toHaveBeenCalled();
    expect(proposalUpdateMock).toHaveBeenCalledWith({
      where: { proposalId: "gov_action1before527" },
      data: expect.objectContaining({
        drepInactiveVotePower: BigInt(0),
      }),
    });
  });

  it("writes the expected proposal voting power payload", async () => {
    mockGetProposalVotingSummary.mockResolvedValue({
      drep_active_yes_vote_power: "101",
      drep_active_no_vote_power: "102",
      drep_active_abstain_vote_power: "103",
      drep_always_abstain_vote_power: "104",
      drep_always_no_confidence_vote_power: "105",
      pool_active_yes_vote_power: "201",
      pool_active_no_vote_power: "202",
      pool_active_abstain_vote_power: "203",
      pool_passive_always_abstain_vote_power: "204",
      pool_passive_always_no_confidence_vote_power: "205",
      pool_no_vote_power: "206",
    });
    mockGetDrepEpochSummary.mockResolvedValue({ amount: "900" });
    mockListPoolVotingPowerHistory.mockResolvedValue([
      {
        pool_id_bech32: "pool1",
        epoch_no: 599,
        amount: "300",
      },
      {
        pool_id_bech32: "pool2",
        epoch_no: 599,
        amount: "200",
      },
    ]);
    mockGetInactivePowerWithCache.mockResolvedValue(BigInt(77));

    const result = await updateProposalVotingPower(
      prisma as any,
      "gov_action1payload",
      600,
      599,
      600,
      false,
      new Map(),
      undefined
    );

    expect(result).toEqual({
      success: true,
      summaryFound: true,
      outcome: "updated",
      retryAttempts: 0,
      summaryDurationMs: expect.any(Number),
    });
    expect(mockGetInactivePowerWithCache).toHaveBeenCalledWith(
      600,
      false,
      expect.any(Map),
      undefined
    );
    expect(proposalUpdateMock).toHaveBeenCalledWith({
      where: { proposalId: "gov_action1payload" },
      data: {
        drepTotalVotePower: BigInt(900),
        drepActiveYesVotePower: BigInt(101),
        drepActiveNoVotePower: BigInt(102),
        drepActiveAbstainVotePower: BigInt(103),
        drepAlwaysAbstainVotePower: BigInt(104),
        drepAlwaysNoConfidencePower: BigInt(105),
        drepInactiveVotePower: BigInt(77),
        spoTotalVotePower: BigInt(500),
        spoActiveYesVotePower: BigInt(201),
        spoActiveNoVotePower: BigInt(202),
        spoActiveAbstainVotePower: BigInt(203),
        spoAlwaysAbstainVotePower: BigInt(204),
        spoAlwaysNoConfidencePower: BigInt(205),
        spoNoVotePower: BigInt(206),
      },
    });
  });

  it("skips voting power updates during Koios degraded state", async () => {
    mockGetKoiosPressureState.mockReturnValue({
      active: true,
      remainingMs: 42000,
      eventCount: 5,
      threshold: 3,
      cooldownUntil: Date.now() + 42000,
    });

    await expect(
      updateProposalVotingPower(prisma as any, "gov_action1degraded", 600, 599, 600, true)
    ).resolves.toEqual({
      success: true,
      summaryFound: false,
      outcome: "degraded-skip",
      skipped: true,
      skippedReason: "koios-degraded",
    });
    expect(mockGetProposalVotingSummary).not.toHaveBeenCalled();
    expect(proposalUpdateMock).not.toHaveBeenCalled();
  });

  it("classifies retry-fail when summary fetch fails after retries", async () => {
    mockGetProposalVotingSummary.mockImplementation(
      async (
        _proposalId: string,
        options?: { onRetryAttempt?: () => void; signal?: AbortSignal }
      ) => {
        options?.onRetryAttempt?.();
        throw new Error("socket hang up");
      }
    );

    await expect(
      updateProposalVotingPower(prisma as any, "gov_action1retryfail", 600, 599, 600, true)
    ).resolves.toEqual({
      success: false,
      error: "socket hang up",
      summaryFound: false,
      outcome: "retry-fail",
      skipped: true,
      skippedReason: "summary-fetch-failed",
      partial: true,
      partialReasons: ["summary-fetch-failed"],
      retryAttempts: 1,
      summaryDurationMs: expect.any(Number),
    });
  });

  it("classifies deferred-time-budget when summary fetch exceeds soft timeout", async () => {
    jest.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    mockGetProposalVotingSummary.mockImplementation(
      (_proposalId: string, options?: { onRetryAttempt?: () => void; signal?: AbortSignal }) =>
        new Promise((resolve) => {
          observedSignal = options?.signal;
          const delayedRetry = setTimeout(() => {
            options?.onRetryAttempt?.();
          }, 35500);
          const delayedResolve = setTimeout(() => resolve(null), 36000);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(delayedRetry);
              clearTimeout(delayedResolve);
              resolve(null);
            },
            { once: true }
          );
        })
    );

    const resultPromise = updateProposalVotingPower(
      prisma as any,
      "gov_action1timeout",
      600,
      599,
      600,
      true
    );
    await jest.advanceTimersByTimeAsync(35050);

    await expect(resultPromise).resolves.toEqual({
      success: false,
      error: "Voting summary exceeded soft time budget (35000ms)",
      summaryFound: false,
      outcome: "deferred-time-budget",
      skipped: true,
      skippedReason: "deferred-time-budget",
      partial: true,
      partialReasons: ["deferred-time-budget"],
      retryAttempts: 0,
      summaryDurationMs: expect.any(Number),
    });
    expect(observedSignal?.aborted).toBe(true);

    await jest.advanceTimersByTimeAsync(1000);
  });
});
