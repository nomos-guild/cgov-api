const mockIngestVotesForProposal = jest.fn();
const mockUpdateProposalVotingPower = jest.fn();
const mockGetKoiosPressureState = jest.fn(() => ({
  active: false,
  remainingMs: 0,
  eventCount: 0,
  threshold: 0,
  cooldownUntil: 0,
}));

jest.mock("../src/services/prisma", () => ({
  prisma: {},
}));

jest.mock("../src/services/ingestion/vote.service", () => ({
  createVoteIngestionRunCache: () => ({}),
  ingestVotesForProposal: (...args: unknown[]) => mockIngestVotesForProposal(...args),
}));

jest.mock("../src/services/ingestion/proposalVotingPower.service", () => ({
  createProposalVotingPowerRunCache: () => ({}),
  updateProposalVotingPower: (...args: unknown[]) =>
    mockUpdateProposalVotingPower(...args),
}));

jest.mock("../src/services/koios", () => ({
  getKoiosPressureState: () => mockGetKoiosPressureState(),
}));

import { runProposalDownstreamPipeline } from "../src/services/ingestion/proposalPipeline";

describe("proposal phase 3 koios impact", () => {
  beforeEach(() => {
    mockIngestVotesForProposal.mockReset();
    mockUpdateProposalVotingPower.mockReset();
    mockGetKoiosPressureState.mockReset();
    mockGetKoiosPressureState.mockReturnValue({
      active: false,
      remainingMs: 0,
      eventCount: 0,
      threshold: 0,
      cooldownUntil: 0,
    });
    mockIngestVotesForProposal.mockResolvedValue({
      success: true,
      stats: {
        votesIngested: 1,
        votesUpserted: 1,
        votesUpdated: 0,
        votesProcessed: 1,
        votersCreated: { dreps: 0, spos: 0, ccs: 0 },
        votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
        metadata: { attempts: 0, success: 0, failed: 0, skipped: 0 },
      },
    });
  });

  it("propagates deferred-time-budget voting-power outcome", async () => {
    mockUpdateProposalVotingPower.mockResolvedValue({
      success: false,
      summaryFound: false,
      outcome: "deferred-time-budget",
      skipped: true,
      skippedReason: "deferred-time-budget",
      partial: true,
      partialReasons: ["deferred-time-budget"],
      error: "Voting summary exceeded soft time budget (35000ms)",
    });

    const result = await runProposalDownstreamPipeline({
      proposalId: "gov_action1timeout",
      currentEpoch: 600,
      koiosProposal: {
        proposal_id: "gov_action1timeout",
        expiration: 610,
      } as any,
    });

    expect(result.votingPower).toMatchObject({
      outcome: "deferred-time-budget",
      skippedReason: "deferred-time-budget",
      partial: true,
    });
  });

  it("propagates partial aggregate outcome details", async () => {
    mockUpdateProposalVotingPower.mockResolvedValue({
      success: false,
      summaryFound: true,
      outcome: "partial-aggregate",
      partial: true,
      partialReasons: ["spo-total-unavailable(epoch=599)"],
      error: "spo-total-unavailable(epoch=599)",
    });

    const result = await runProposalDownstreamPipeline({
      proposalId: "gov_action1partial",
      currentEpoch: 600,
      koiosProposal: {
        proposal_id: "gov_action1partial",
        expiration: 610,
      } as any,
    });

    expect(result.votingPower).toMatchObject({
      outcome: "partial-aggregate",
      partial: true,
      partialReasons: ["spo-total-unavailable(epoch=599)"],
    });
  });
});
