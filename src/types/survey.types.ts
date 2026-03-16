import type { VoterType } from "@prisma/client";

export type ResponderRole = "DRep" | "SPO" | "CC" | "Stakeholder";
export type WeightingMode =
  | "CredentialBased"
  | "StakeBased"
  | "PledgeBased";

export interface SurveyQuestion {
  questionId: string;
  question: string;
  methodType: string;
  options?: string[];
  maxSelections?: number;
  numericConstraints?: {
    minValue: number;
    maxValue: number;
    step?: number;
  };
  methodSchemaUri?: string;
  methodSchemaHash?: string;
}

export interface SurveyDetails {
  specVersion: string;
  title: string;
  description: string;
  questions: SurveyQuestion[];
  roleWeighting: Partial<Record<ResponderRole, WeightingMode>>;
  endEpoch: number;
}

export interface SurveyAnswer {
  questionId: string;
  selection?: number[];
  numericValue?: number;
  customValue?: unknown;
}

export interface SurveyResponse {
  specVersion: string;
  surveyTxId: string;
  responderRole: ResponderRole;
  answers: SurveyAnswer[];
}

export interface SurveyLinkedActionId {
  txId: string;
  govActionIx: number;
}

export interface ProposalSurveyResponse {
  linked: boolean;
  surveyTxId: string | null;
  linkValidation: {
    valid: boolean;
    errors: string[];
    actionEligibility?: ResponderRole[];
    linkedRoleWeighting?: Partial<Record<ResponderRole, WeightingMode>> | null;
    linkedActionId?: SurveyLinkedActionId;
  };
  surveyDetails: SurveyDetails | null;
  surveyDetailsValidation: {
    valid: boolean;
    errors: string[];
  };
}

export interface SurveyLinkedVoteEvidence {
  valid: boolean;
  errors: string[];
  warnings?: string[];
  responderRole?: ResponderRole | null;
  responseCredential?: string | null;
  linkedActionId?: SurveyLinkedActionId | null;
}

export type ProposalSurveyTallyPhase =
  | "provisional"
  | "finalization_pending"
  | "finalized";

export interface ProposalSurveyTallyRoleResult {
  responderRole: ResponderRole;
  weightingMode: WeightingMode;
  totals: {
    totalSeen: number;
    valid: number;
    invalid: number;
    deduped: number;
    uniqueResponders: number;
  };
  methodResults: Record<string, unknown>[];
}

export interface ProposalSurveyTallyResponse {
  surveyTxId: string | null;
  phase: ProposalSurveyTallyPhase;
  asOfEpoch: number | null;
  finalizationEpoch: number | null;
  totals: {
    totalSeen: number;
    valid: number;
    invalid: number;
    deduped: number;
    uniqueResponders: number;
  };
  roleResults: ProposalSurveyTallyRoleResult[];
  errors: string[];
  warnings: string[];
}

export interface SurveyTallyVote {
  txHash: string;
  voterType: VoterType;
  voterId: string;
  votingPower?: bigint | null;
  responseEpoch?: number | null;
  votedAt?: Date | null;
  surveyResponse?: string | null;
  surveyResponseSurveyTxId?: string | null;
  surveyResponseResponderRole?: string | null;
  absoluteSlot?: number | null;
  txBlockIndex?: number | null;
  metadataPosition?: number | null;
  responseCredential?: string | null;
  linkedVoteEvidence?: SurveyLinkedVoteEvidence | null;
  snapshotWeight?: number | null;
  snapshotWeightError?: string | null;
}
