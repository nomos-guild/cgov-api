const proposalUpdateMock = jest.fn();
const mockGetProposalVotingSummary = jest.fn();
const mockGetDrepEpochSummary = jest.fn();
const mockListPoolVotingPowerHistory = jest.fn();
const mockGetInactivePowerWithCache = jest.fn();

jest.mock("../src/services/prisma", () => ({
  prisma: {
    proposal: {
      update: proposalUpdateMock,
    },
  },
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

import { updateProposalVotingPower } from "../src/services/ingestion/proposalVotingPower.service";

describe("proposalVotingPower.service", () => {
  beforeEach(() => {
    proposalUpdateMock.mockReset();
    mockGetProposalVotingSummary.mockReset();
    mockGetDrepEpochSummary.mockReset();
    mockListPoolVotingPowerHistory.mockReset();
    mockGetInactivePowerWithCache.mockReset();
  });

  it("returns a failed result when Koios does not return a voting summary", async () => {
    mockGetProposalVotingSummary.mockResolvedValue(null);

    await expect(
      updateProposalVotingPower("gov_action1missing", 600, 599, 600, true)
    ).resolves.toEqual({
      success: false,
      error: "No voting summary available from Koios",
      summaryFound: false,
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
      "gov_action1before527",
      600,
      599,
      526,
      true
    );

    expect(result).toEqual({
      success: true,
      summaryFound: true,
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
});
