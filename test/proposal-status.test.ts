import { ProposalStatus } from "@prisma/client";
import type { KoiosProposal } from "../src/types/koios.types";

const updateMock = jest.fn();

jest.mock("../src/services/prisma", () => ({
  prisma: {
    proposal: {
      update: updateMock,
    },
  },
}));

import {
  finalizeProposalStatusAfterVoteSync,
  isProposalStatusLocallyRetryable,
  resolveDeferredProposalStatus,
  selectProposalsForBulkSync,
  type ProposalIngestionResult,
} from "../src/services/ingestion/proposal.service";
import { extractTreasuryWithdrawalAmountFromProposalLike } from "../src/services/ingestion/proposalStatus.policy";

function makeKoiosProposal(
  proposalId: string,
  overrides: Partial<KoiosProposal> = {}
): KoiosProposal {
  return {
    proposal_id: proposalId,
    proposal_tx_hash: `${proposalId}-tx`,
    proposal_index: 0,
    proposal_type: "InfoAction",
    proposed_epoch: 100,
    ratified_epoch: null,
    enacted_epoch: null,
    dropped_epoch: null,
    expired_epoch: null,
    expiration: 120,
    ...overrides,
  };
}

describe("proposal status deferral", () => {
  beforeEach(() => {
    updateMock.mockReset();
  });

  it("keeps new completed proposals ACTIVE until downstream sync finalizes", () => {
    expect(
      resolveDeferredProposalStatus(ProposalStatus.RATIFIED, undefined, true)
    ).toEqual({
      status: ProposalStatus.ACTIVE,
      intendedStatus: ProposalStatus.RATIFIED,
    });
  });

  it("preserves the current stored status when a later status is derived", () => {
    expect(
      resolveDeferredProposalStatus(
        ProposalStatus.ENACTED,
        ProposalStatus.RATIFIED,
        true
      )
    ).toEqual({
      status: ProposalStatus.RATIFIED,
      intendedStatus: ProposalStatus.ENACTED,
    });
  });

  it("does not defer when the derived status matches the stored status", () => {
    expect(
      resolveDeferredProposalStatus(
        ProposalStatus.ACTIVE,
        ProposalStatus.ACTIVE,
        true
      )
    ).toEqual({
      status: ProposalStatus.ACTIVE,
    });
  });

  it("treats only ACTIVE proposals as locally retryable", () => {
    expect(isProposalStatusLocallyRetryable(undefined)).toBe(true);
    expect(isProposalStatusLocallyRetryable(null)).toBe(true);
    expect(isProposalStatusLocallyRetryable(ProposalStatus.ACTIVE)).toBe(true);
    expect(isProposalStatusLocallyRetryable(ProposalStatus.RATIFIED)).toBe(false);
    expect(isProposalStatusLocallyRetryable(ProposalStatus.ENACTED)).toBe(false);
    expect(isProposalStatusLocallyRetryable(ProposalStatus.EXPIRED)).toBe(false);
  });

  it("selects only new and locally retryable proposals for bulk sync", () => {
    const selected = selectProposalsForBulkSync(
      [
        makeKoiosProposal("gov_action1new"),
        makeKoiosProposal("gov_action1active"),
        makeKoiosProposal("gov_action1ratified"),
      ],
      [
        { proposalId: "gov_action1active", status: ProposalStatus.ACTIVE },
        { proposalId: "gov_action1ratified", status: ProposalStatus.RATIFIED },
      ]
    );

    expect(selected.map((proposal) => proposal.proposal_id)).toEqual([
      "gov_action1new",
      "gov_action1active",
    ]);
  });

  it("deduplicates Koios proposal rows so each proposal is attempted once per trigger", () => {
    const selected = selectProposalsForBulkSync(
      [
        makeKoiosProposal("gov_action1active", { proposal_tx_hash: "old-hash" }),
        makeKoiosProposal("gov_action1active", { proposal_tx_hash: "new-hash" }),
      ],
      [{ proposalId: "gov_action1active", status: ProposalStatus.ACTIVE }]
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.proposal_tx_hash).toBe("new-hash");
  });

  it("skips finalization on partial failures", async () => {
    const result: ProposalIngestionResult = {
      success: false,
      downstream: {
        votes: { success: false, error: "vote sync failed" },
        votingPower: { success: true, summaryFound: true },
      },
      proposal: {
        id: 1,
        proposalId: "gov_action1test",
        status: ProposalStatus.ACTIVE,
      },
      stats: {
        votesProcessed: 0,
        votesIngested: 0,
        votesUpdated: 0,
        votersCreated: { dreps: 0, spos: 0, ccs: 0 },
        votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
        metadata: {
          attempts: 0,
          success: 0,
          failed: 0,
          skipped: 0,
        },
      },
      intendedStatus: ProposalStatus.RATIFIED,
    };

    const finalized = await finalizeProposalStatusAfterVoteSync(
      result,
      "[Test]"
    );

    expect(updateMock).not.toHaveBeenCalled();
    expect(finalized).toBe(result);
  });

  it("commits the deferred status after successful downstream sync", async () => {
    updateMock.mockResolvedValue({
      proposalId: "gov_action1test",
      status: ProposalStatus.ENACTED,
    });

    const result: ProposalIngestionResult = {
      success: true,
      downstream: {
        votes: { success: true },
        votingPower: { success: true, summaryFound: true },
      },
      proposal: {
        id: 1,
        proposalId: "gov_action1test",
        status: ProposalStatus.RATIFIED,
      },
      stats: {
        votesProcessed: 10,
        votesIngested: 8,
        votesUpdated: 2,
        votersCreated: { dreps: 0, spos: 0, ccs: 0 },
        votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
        metadata: {
          attempts: 0,
          success: 0,
          failed: 0,
          skipped: 0,
        },
      },
      intendedStatus: ProposalStatus.ENACTED,
    };

    const finalized = await finalizeProposalStatusAfterVoteSync(
      result,
      "[Test]"
    );

    expect(updateMock).toHaveBeenCalledWith({
      where: { proposalId: "gov_action1test" },
      data: { status: ProposalStatus.ENACTED },
    });
    expect(finalized.proposal.status).toBe(ProposalStatus.ENACTED);
  });
});

describe("treasury withdrawal aggregation", () => {
  it("sums multiple withdrawal entries", () => {
    const amount = extractTreasuryWithdrawalAmountFromProposalLike({
      proposal_type: "TreasuryWithdrawals",
      withdrawal: [
        { amount: "1450000000000", stake_address: "stake1..." },
        { amount: "1160000000000", stake_address: "stake1..." },
        { amount: "2575000000000", stake_address: "stake1..." },
      ],
    });

    expect(amount?.toString()).toBe("5185000000000");
  });

  it("handles a single withdrawal entry", () => {
    const amount = extractTreasuryWithdrawalAmountFromProposalLike({
      proposal_type: "TreasuryWithdrawals",
      withdrawal: [{ amount: "6900000000000", stake_address: "stake1..." }],
    });

    expect(amount?.toString()).toBe("6900000000000");
  });

  it("falls back to nested proposal_description contents when withdrawal is absent", () => {
    const amount = extractTreasuryWithdrawalAmountFromProposalLike({
      proposal_type: "TreasuryWithdrawals",
      proposal_description: {
        contents: [
          [
            [
              {
                network: "Mainnet",
                credential: {
                  scriptHash: "abc123",
                },
              },
              "900000000000",
            ],
            [
              {
                network: "Mainnet",
                credential: {
                  scriptHash: "def456",
                },
              },
              6900000000000,
            ],
          ],
          "some-anchor-hash",
        ],
      },
    });

    expect(amount?.toString()).toBe("7800000000000");
  });

  it("returns null for non-treasury proposals", () => {
    const amount = extractTreasuryWithdrawalAmountFromProposalLike({
      proposal_type: "InfoAction",
      withdrawal: [{ amount: "5000", stake_address: "stake1..." }],
    });

    expect(amount).toBeNull();
  });
});
