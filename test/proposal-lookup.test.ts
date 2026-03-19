import type { KoiosProposal } from "../src/types/koios.types";
import {
  buildProposalLookup,
  findKoiosProposalForIdentifier,
  getProposalIdentifierAliases,
  parseProposalIdentifier,
} from "../src/services/proposalLookup";

function makeProposal(overrides: Partial<KoiosProposal> = {}): KoiosProposal {
  return {
    proposal_id: "gov_action1test",
    proposal_tx_hash:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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

describe("proposalLookup", () => {
  it("parses gov_action identifiers", () => {
    expect(parseProposalIdentifier("gov_action1test")).toEqual({
      raw: "gov_action1test",
      normalized: "gov_action1test",
      kind: "proposalId",
      proposalId: "gov_action1test",
    });
  });

  it("parses tx hash and cert index identifiers", () => {
    expect(
      parseProposalIdentifier(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:2"
      )
    ).toEqual({
      raw: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:2",
      normalized:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:2",
      kind: "txHashAndIndex",
      txHash:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      certIndex: "2",
    });
  });

  it("builds prisma lookups from supported identifiers", () => {
    expect(buildProposalLookup("42")).toEqual({ id: 42 });
    expect(buildProposalLookup("gov_action1test")).toEqual({
      proposalId: "gov_action1test",
    });
    expect(
      buildProposalLookup(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      )
    ).toEqual({
      txHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("finds Koios proposals by alternate aliases", () => {
    const proposal = makeProposal({ proposal_index: 3 });
    const parsed = parseProposalIdentifier(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:3"
    );

    expect(parsed).not.toBeNull();
    expect(findKoiosProposalForIdentifier([proposal], parsed!)).toEqual(proposal);
  });

  it("produces identifier aliases for sync-on-read canonicalization", () => {
    const proposal = makeProposal({ proposal_index: 7 });

    expect(getProposalIdentifierAliases(proposal)).toEqual([
      "gov_action1test",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:7",
    ]);
  });
});
