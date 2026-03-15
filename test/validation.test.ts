import { GovernanceType, VoterType } from "@prisma/client";
import {
  buildSurveyTally,
  SURVEY_SPEC_VERSION,
  validateLinkedSurvey,
  validateSurveyResponse,
  type SurveyDetails,
  type SurveyResponse,
  type SurveyTallyVote,
} from "../src/libs/surveyMetadata";

const baseSurveyDetails: SurveyDetails = {
  specVersion: SURVEY_SPEC_VERSION,
  title: "Preview Survey",
  description: "Checks linked survey behavior.",
  questions: [
    {
      questionId: "q1",
      question: "Choose one",
      methodType: "urn:cardano:poll-method:single-choice:v1",
      options: ["A", "B"],
    },
  ],
  roleWeighting: {
    DRep: "CredentialBased",
    Stakeholder: "StakeBased",
  },
  endEpoch: 1257,
};

describe("survey validation", () => {
  it("filters tally roles to linkedRoleWeighting for governance-linked surveys", () => {
    const payload = validateLinkedSurvey({
      specVersion: SURVEY_SPEC_VERSION,
      kind: "cardano-governance-survey-link",
      surveyTxId: "a".repeat(64),
      surveyDetails: baseSurveyDetails,
      governanceType: GovernanceType.INFO_ACTION,
      proposalTxHash: "b".repeat(64),
      certIndex: "0",
      expirationEpoch: 1257,
    });

    expect(payload.linkValidation.valid).toBe(true);
    expect(payload.linkValidation.linkedRoleWeighting).toEqual({
      DRep: "CredentialBased",
    });
  });

  it("rejects self-referential survey responses", () => {
    const response: SurveyResponse = {
      specVersion: SURVEY_SPEC_VERSION,
      surveyTxId: "c".repeat(64),
      responderRole: "DRep",
      answers: [{ questionId: "q1", selection: [0] }],
    };

    expect(
      validateSurveyResponse(
        response,
        baseSurveyDetails,
        "DRep",
        "c".repeat(64),
        1257,
        {
          allowedRoleWeighting: { DRep: "CredentialBased" },
          responseTxHash: "c".repeat(64),
        }
      )
    ).toContain(
      "surveyResponse.surveyTxId must not reference the response transaction itself."
    );
  });

  it("dedupes latest response by slot and tx-in-block ordering", () => {
    const votes: SurveyTallyVote[] = [
      {
        txHash: "vote-older",
        voterType: VoterType.DREP,
        voterId: "drep1example",
        responseCredential: "drep1example",
        absoluteSlot: 100,
        txBlockIndex: 0,
        metadataPosition: 0,
        surveyResponse: JSON.stringify({
          17: {
            surveyResponse: {
              specVersion: SURVEY_SPEC_VERSION,
              surveyTxId: "surveytx",
              responderRole: "DRep",
              answers: [{ questionId: "q1", selection: [0] }],
            },
          },
        }),
        linkedVoteEvidence: {
          valid: true,
          errors: [],
          responderRole: "DRep",
          responseCredential: "drep1example",
        },
      },
      {
        txHash: "vote-newer",
        voterType: VoterType.DREP,
        voterId: "drep1example",
        responseCredential: "drep1example",
        absoluteSlot: 100,
        txBlockIndex: 1,
        metadataPosition: 0,
        surveyResponse: JSON.stringify({
          17: {
            surveyResponse: {
              specVersion: SURVEY_SPEC_VERSION,
              surveyTxId: "surveytx",
              responderRole: "DRep",
              answers: [{ questionId: "q1", selection: [1] }],
            },
          },
        }),
        linkedVoteEvidence: {
          valid: true,
          errors: [],
          responderRole: "DRep",
          responseCredential: "drep1example",
        },
      },
    ];

    const tally = buildSurveyTally(
      "surveytx",
      {
        ...baseSurveyDetails,
        roleWeighting: { DRep: "CredentialBased" },
      },
      { DRep: "CredentialBased" },
      votes
    );

    expect(tally.roleResults).toHaveLength(1);
    const roleResult = tally.roleResults[0];
    const methodResult = roleResult.methodResults[0] as {
      optionTotals: number[];
    };

    expect(roleResult.totals.valid).toBe(1);
    expect(roleResult.totals.deduped).toBe(1);
    expect(methodResult.optionTotals).toEqual([0, 1]);
  });

  it("counts responses provisionally before finalization even without linked vote evidence", () => {
    const votes: SurveyTallyVote[] = [
      {
        txHash: "vote-provisional",
        voterType: VoterType.DREP,
        voterId: "drep1example",
        surveyResponse: JSON.stringify({
          17: {
            surveyResponse: {
              specVersion: SURVEY_SPEC_VERSION,
              surveyTxId: "surveytx",
              responderRole: "DRep",
              answers: [{ questionId: "q1", selection: [0] }],
            },
          },
        }),
        linkedVoteEvidence: {
          valid: false,
          errors: [
            "Linked vote transaction body could not be inspected for voting_procedures.",
          ],
          responderRole: "DRep",
          responseCredential: null,
        },
      },
    ];

    const tally = buildSurveyTally(
      "surveytx",
      {
        ...baseSurveyDetails,
        roleWeighting: { DRep: "CredentialBased" },
      },
      { DRep: "CredentialBased" },
      votes,
      {
        phase: "provisional",
        asOfEpoch: 1200,
        finalizationEpoch: 1257,
        enforceLinkedVoteEvidence: false,
      }
    );

    const methodResult = tally.roleResults[0].methodResults[0] as {
      optionTotals: number[];
    };

    expect(tally.phase).toBe("provisional");
    expect(tally.totals.valid).toBe(1);
    expect(tally.totals.invalid).toBe(0);
    expect(methodResult.optionTotals).toEqual([1, 0]);
  });

  it("excludes responses from finalized tallies when linked vote evidence fails", () => {
    const votes: SurveyTallyVote[] = [
      {
        txHash: "vote-finalized",
        voterType: VoterType.DREP,
        voterId: "drep1example",
        surveyResponse: JSON.stringify({
          17: {
            surveyResponse: {
              specVersion: SURVEY_SPEC_VERSION,
              surveyTxId: "surveytx",
              responderRole: "DRep",
              answers: [{ questionId: "q1", selection: [0] }],
            },
          },
        }),
        linkedVoteEvidence: {
          valid: false,
          errors: [
            "Linked vote transaction body could not be inspected for voting_procedures.",
          ],
          responderRole: "DRep",
          responseCredential: null,
        },
      },
    ];

    const tally = buildSurveyTally(
      "surveytx",
      {
        ...baseSurveyDetails,
        roleWeighting: { DRep: "CredentialBased" },
      },
      { DRep: "CredentialBased" },
      votes,
      {
        phase: "finalized",
        asOfEpoch: 1257,
        finalizationEpoch: 1257,
        enforceLinkedVoteEvidence: true,
      }
    );

    const methodResult = tally.roleResults[0].methodResults[0] as {
      optionTotals: number[];
    };

    expect(tally.phase).toBe("finalized");
    expect(tally.totals.valid).toBe(0);
    expect(tally.totals.invalid).toBe(1);
    expect(methodResult.optionTotals).toEqual([0, 0]);
  });
});
