const mockGetTxInfoBatch = jest.fn();
const mockBlockfrostGet = jest.fn();
const mockDeserializeTxCbor = jest.fn();

jest.mock("../src/services/governanceProvider", () => ({
  getTxInfoBatch: (...args: unknown[]) => mockGetTxInfoBatch(...args),
}));

jest.mock("../src/services/blockfrost", () => ({
  getBlockfrostService: () => ({
    get: (...args: unknown[]) => mockBlockfrostGet(...args),
  }),
}));

jest.mock("@meshsdk/core-cst", () => {
  const txCborFactory = Object.assign((value: string) => value, {
    deserialize: (...args: unknown[]) => mockDeserializeTxCbor(...args),
  });

  return {
    DRepID: {
      toCip105DRepID: (value: string) => value,
    },
    PoolId: {
      fromKeyHash: (value: string) => value,
    },
    TxCBOR: txCborFactory,
  };
});

import { VoterType } from "@prisma/client";
import type { SurveyLinkedActionId, SurveyTallyVote } from "../src/libs/surveyMetadata";
import { enrichSurveyTallyVotes } from "../src/services/proposalSurveyTally.service";

function makeVote(overrides: Partial<SurveyTallyVote> = {}): SurveyTallyVote {
  return {
    txHash: "vote-tx-1",
    voterType: VoterType.DREP,
    voterId: "drep_test1",
    metadataPosition: 3,
    ...overrides,
  };
}

describe("proposalSurveyTally.service", () => {
  const linkedActionId: SurveyLinkedActionId = {
    txId: "gov-action-tx",
    govActionIx: 2,
  };

  beforeEach(() => {
    mockGetTxInfoBatch.mockReset();
    mockBlockfrostGet.mockReset();
    mockDeserializeTxCbor.mockReset();
  });

  it("enriches votes with tx slot/index data and linked evidence from Koios tx info", async () => {
    mockGetTxInfoBatch.mockResolvedValue([
      {
        tx_hash: "vote-tx-1",
        absolute_slot: 123456,
        tx_block_index: 7,
        voting_procedures: [
          {
            voter: {
              type: "DRep",
              drepId: "drep_test1",
            },
            procedures: [
              {
                govActionId: {
                  txHash: "gov-action-tx",
                  txIndex: 2,
                },
              },
            ],
          },
        ],
      },
    ]);

    const [enrichedVote] = await enrichSurveyTallyVotes(
      [makeVote({ txHash: "vote-tx-1", metadataPosition: 5 })],
      linkedActionId
    );

    expect(enrichedVote).toEqual(
      expect.objectContaining({
        txHash: "vote-tx-1",
        voterId: "drep_test1",
        absoluteSlot: 123456,
        txBlockIndex: 7,
        metadataPosition: 5,
        responseCredential: "drep_test1",
        linkedVoteEvidence: {
          valid: true,
          errors: [],
          responderRole: "DRep",
          responseCredential: "drep_test1",
          linkedActionId,
        },
      })
    );
  });

  it("falls back to Blockfrost CBOR when Koios tx info has no usable voting procedures", async () => {
    mockGetTxInfoBatch.mockResolvedValue([
      {
        tx_hash: "vote-tx-fallback",
        absolute_slot: 999,
        tx_block_index: 2,
        voting_procedures: null,
      },
    ]);
    mockBlockfrostGet.mockResolvedValue({
      data: { cbor: "84a40081825820deadbeef" },
    });
    mockDeserializeTxCbor.mockReturnValue({
      body: {
        votingProcedures: [
          {
            voter: {
              type: "DRep",
              drepId: "drep_test1",
            },
            govActionId: {
              txHash: "gov-action-tx",
              txIndex: 2,
            },
          },
        ],
      },
    });

    const [enrichedVote] = await enrichSurveyTallyVotes(
      [makeVote({ txHash: "vote-tx-fallback" })],
      linkedActionId
    );

    expect(mockBlockfrostGet).toHaveBeenCalledWith("/txs/vote-tx-fallback/cbor");
    expect(enrichedVote).toEqual(
      expect.objectContaining({
        absoluteSlot: 999,
        txBlockIndex: 2,
        linkedVoteEvidence: {
          valid: true,
          errors: [],
          responderRole: "DRep",
          responseCredential: "drep_test1",
          linkedActionId,
        },
      })
    );
  });

  it("returns a warning-bearing evidence object when neither Koios nor Blockfrost is inspectable", async () => {
    mockGetTxInfoBatch.mockResolvedValue([
      {
        tx_hash: "vote-tx-warning",
        absolute_slot: null,
        tx_block_index: null,
        voting_procedures: [],
      },
    ]);
    mockBlockfrostGet.mockRejectedValue(new Error("missing cbor"));

    const [enrichedVote] = await enrichSurveyTallyVotes(
      [
        makeVote({
          txHash: "vote-tx-warning",
          voterId: "drep_vote_list",
          metadataPosition: undefined,
        }),
      ],
      linkedActionId
    );

    expect(enrichedVote).toEqual(
      expect.objectContaining({
        metadataPosition: 0,
        responseCredential: "drep_vote_list",
        linkedVoteEvidence: {
          valid: true,
          errors: [],
          warnings: [
            "Linked vote transaction body could not be inspected for voting_procedures; cgov-api fell back to Koios vote_list identity for this response.",
          ],
          responderRole: "DRep",
          responseCredential: "drep_vote_list",
          linkedActionId: null,
        },
      })
    );
  });

  it("keeps voter identity mismatch failures when tx-body voter disagrees with Koios vote_list", async () => {
    mockGetTxInfoBatch.mockResolvedValue([
      {
        tx_hash: "vote-tx-mismatch",
        voting_procedures: [
          {
            voter: {
              type: "DRep",
              drepId: "drep_tx_body",
            },
            govActionId: {
              txHash: "gov-action-tx",
              txIndex: 2,
            },
          },
        ],
      },
    ]);

    const [enrichedVote] = await enrichSurveyTallyVotes(
      [
        makeVote({
          txHash: "vote-tx-mismatch",
          voterId: "drep_vote_list",
        }),
      ],
      linkedActionId
    );

    expect(enrichedVote.linkedVoteEvidence).toEqual({
      valid: false,
      errors: [
        "Koios vote_list identity does not match the transaction voting_procedures voter.",
      ],
      responderRole: "DRep",
      responseCredential: "drep_tx_body",
      linkedActionId,
    });
    expect(enrichedVote.responseCredential).toBe("drep_tx_body");
  });
});
