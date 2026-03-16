import { GovernanceType, VoterType } from "@prisma/client";
import { getVotingThreshold } from "./proposalMapper";
import type {
  ProposalSurveyResponse as ProposalSurveyPayload,
  ProposalSurveyTallyPhase,
  ProposalSurveyTallyRoleResult,
  ProposalSurveyTallyResponse,
  ResponderRole,
  SurveyAnswer,
  SurveyDetails,
  SurveyLinkedActionId,
  SurveyLinkedVoteEvidence,
  SurveyQuestion,
  SurveyResponse,
  SurveyTallyVote,
  WeightingMode,
} from "../types/survey.types";

export const SURVEY_SPEC_VERSION = "1.0.0";
export const GOVERNANCE_SURVEY_LINK_KIND = "cardano-governance-survey-link";
export type {
  ProposalSurveyPayload,
  ProposalSurveyTallyPhase,
  ProposalSurveyTallyRoleResult,
  ProposalSurveyTallyResponse,
  ResponderRole,
  SurveyAnswer,
  SurveyDetails,
  SurveyLinkedActionId,
  SurveyLinkedVoteEvidence,
  SurveyQuestion,
  SurveyResponse,
  SurveyTallyVote,
  WeightingMode,
};

const BUILTIN_METHODS = {
  singleChoice: "urn:cardano:poll-method:single-choice:v1",
  multiSelect: "urn:cardano:poll-method:multi-select:v1",
  numericRange: "urn:cardano:poll-method:numeric-range:v1",
} as const;

const ROLE_WEIGHTING_COMPATIBILITY: Record<ResponderRole, WeightingMode[]> = {
  CC: ["CredentialBased"],
  DRep: ["CredentialBased", "StakeBased"],
  SPO: ["CredentialBased", "StakeBased", "PledgeBased"],
  Stakeholder: ["StakeBased"],
};

const EMPTY_SURVEY_PAYLOAD: ProposalSurveyPayload = {
  linked: false,
  surveyTxId: null,
  linkValidation: {
    valid: false,
    errors: ["No survey link found for this proposal."],
  },
  surveyDetails: null,
  surveyDetailsValidation: {
    valid: false,
    errors: [],
  },
};

export function emptySurveyPayload(): ProposalSurveyPayload {
  return JSON.parse(JSON.stringify(EMPTY_SURVEY_PAYLOAD)) as ProposalSurveyPayload;
}

export function emptySurveyTally(): ProposalSurveyTallyResponse {
  return {
    surveyTxId: null,
    phase: "provisional",
    asOfEpoch: null,
    finalizationEpoch: null,
    totals: {
      totalSeen: 0,
      valid: 0,
      invalid: 0,
      deduped: 0,
      uniqueResponders: 0,
    },
    roleResults: [],
    errors: ["No survey tally available for this proposal."],
    warnings: [],
  };
}

export function getActionEligibility(
  governanceType: GovernanceType | null | undefined
): ResponderRole[] {
  const threshold = getVotingThreshold(governanceType);
  const roles: ResponderRole[] = [];

  if (threshold.drepThreshold !== null) {
    roles.push("DRep");
  }
  if (threshold.spoThreshold !== null) {
    roles.push("SPO");
  }
  if (threshold.ccThreshold !== null) {
    roles.push("CC");
  }

  return roles;
}

export function parseGovernanceSurveyLink(metadata: string | null | undefined): {
  specVersion: string | null;
  kind: string | null;
  surveyTxId: string | null;
} {
  if (!metadata) {
    return { specVersion: null, kind: null, surveyTxId: null };
  }

  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return {
      specVersion:
        typeof parsed.specVersion === "string" ? parsed.specVersion : null,
      kind: typeof parsed.kind === "string" ? parsed.kind : null,
      surveyTxId:
        typeof parsed.surveyTxId === "string" ? parsed.surveyTxId : null,
    };
  } catch {
    return { specVersion: null, kind: null, surveyTxId: null };
  }
}

function normalizeMetadataText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join("");
  }

  return null;
}

function normalizeSurveyQuestion(question: unknown): SurveyQuestion | null {
  if (!isObject(question)) {
    return null;
  }

  const questionId = normalizeMetadataText(question.questionId);
  const prompt = normalizeMetadataText(question.question);
  const methodType = normalizeMetadataText(question.methodType);
  if (!questionId || !prompt || !methodType) {
    return null;
  }

  let options: string[] | undefined;
  if (question.options !== undefined) {
    if (!Array.isArray(question.options)) {
      return null;
    }

    options = [];
    for (const option of question.options) {
      const normalizedOption = normalizeMetadataText(option);
      if (normalizedOption === null) {
        return null;
      }
      options.push(normalizedOption);
    }
  }

  let numericConstraints: SurveyQuestion["numericConstraints"] | undefined;
  if (question.numericConstraints !== undefined) {
    if (!isObject(question.numericConstraints)) {
      return null;
    }

    const minValue = question.numericConstraints.minValue;
    const maxValue = question.numericConstraints.maxValue;
    const step = question.numericConstraints.step;
    if (
      typeof minValue !== "number" ||
      typeof maxValue !== "number" ||
      !Number.isInteger(minValue) ||
      !Number.isInteger(maxValue)
    ) {
      return null;
    }
    if (step !== undefined && (typeof step !== "number" || !Number.isInteger(step))) {
      return null;
    }

    numericConstraints = {
      minValue,
      maxValue,
      ...(step !== undefined ? { step } : {}),
    };
  }

  const methodSchemaUri = normalizeMetadataText(question.methodSchemaUri);
  const methodSchemaHash = normalizeMetadataText(question.methodSchemaHash);

  return {
    questionId,
    question: prompt,
    methodType,
    ...(options !== undefined ? { options } : {}),
    ...(Number.isInteger(question.maxSelections)
      ? { maxSelections: question.maxSelections as number }
      : {}),
    ...(numericConstraints ? { numericConstraints } : {}),
    ...(methodSchemaUri ? { methodSchemaUri } : {}),
    ...(methodSchemaHash ? { methodSchemaHash } : {}),
  };
}

function normalizeSurveyAnswer(answer: unknown): SurveyAnswer | null {
  if (!isObject(answer)) {
    return null;
  }

  const questionId = normalizeMetadataText(answer.questionId);
  if (!questionId) {
    return null;
  }

  if (answer.selection !== undefined) {
    if (
      !Array.isArray(answer.selection) ||
      !answer.selection.every(
        (value) => typeof value === "number" && Number.isInteger(value)
      )
    ) {
      return null;
    }
  }

  if (
    answer.numericValue !== undefined &&
    (typeof answer.numericValue !== "number" || !Number.isFinite(answer.numericValue))
  ) {
    return null;
  }

  return {
    questionId,
    ...(answer.selection !== undefined
      ? { selection: answer.selection as number[] }
      : {}),
    ...(answer.numericValue !== undefined
      ? { numericValue: answer.numericValue as number }
      : {}),
    ...(answer.customValue !== undefined ? { customValue: answer.customValue } : {}),
  };
}

function normalizeSurveyResponse(response: unknown): SurveyResponse | null {
  if (!isObject(response)) {
    return null;
  }

  const specVersion = normalizeMetadataText(response.specVersion);
  const surveyTxId = normalizeMetadataText(response.surveyTxId);
  const responderRole = normalizeMetadataText(response.responderRole);
  if (
    !specVersion ||
    !surveyTxId ||
    (responderRole !== "DRep" &&
      responderRole !== "SPO" &&
      responderRole !== "CC" &&
      responderRole !== "Stakeholder")
  ) {
    return null;
  }

  if (!Array.isArray(response.answers)) {
    return null;
  }

  const answers: SurveyAnswer[] = [];
  for (const answer of response.answers) {
    const normalized = normalizeSurveyAnswer(answer);
    if (!normalized) {
      return null;
    }
    answers.push(normalized);
  }

  return {
    specVersion,
    surveyTxId,
    responderRole,
    answers,
  };
}

export function normalizeSurveyDetails(
  surveyDetails: unknown
): SurveyDetails | null {
  if (!isObject(surveyDetails)) {
    return null;
  }

  const specVersion = normalizeMetadataText(surveyDetails.specVersion);
  const title = normalizeMetadataText(surveyDetails.title);
  const description = normalizeMetadataText(surveyDetails.description);
  if (!specVersion || !title || !description) {
    return null;
  }

  if (!Array.isArray(surveyDetails.questions)) {
    return null;
  }

  const questions: SurveyQuestion[] = [];
  for (const question of surveyDetails.questions) {
    const normalizedQuestion = normalizeSurveyQuestion(question);
    if (!normalizedQuestion) {
      return null;
    }
    questions.push(normalizedQuestion);
  }

  if (!isObject(surveyDetails.roleWeighting)) {
    return null;
  }

  const roleWeighting: Partial<Record<ResponderRole, WeightingMode>> = {};
  for (const [role, mode] of Object.entries(surveyDetails.roleWeighting)) {
    const normalizedMode = normalizeMetadataText(mode);
    if (
      (role === "DRep" ||
        role === "SPO" ||
        role === "CC" ||
        role === "Stakeholder") &&
      (normalizedMode === "CredentialBased" ||
        normalizedMode === "StakeBased" ||
        normalizedMode === "PledgeBased")
    ) {
      roleWeighting[role] = normalizedMode;
    } else {
      return null;
    }
  }

  const endEpoch = surveyDetails.endEpoch;
  if (typeof endEpoch !== "number" || !Number.isInteger(endEpoch)) {
    return null;
  }

  return {
    specVersion,
    title,
    description,
    questions,
    roleWeighting,
    endEpoch,
  };
}

export function extractSurveyDetails(metadata: unknown): SurveyDetails | null {
  const label17 = extractLabel17(metadata);
  if (!label17 || typeof label17 !== "object") {
    return null;
  }

  const surveyDetails = (label17 as Record<string, unknown>).surveyDetails;
  return normalizeSurveyDetails(surveyDetails);
}

export function extractSurveyResponse(metadata: unknown): SurveyResponse | null {
  const label17 = extractLabel17(metadata);
  if (!label17 || typeof label17 !== "object") {
    return null;
  }

  const surveyResponse = (label17 as Record<string, unknown>).surveyResponse;
  return normalizeSurveyResponse(surveyResponse);
}

export function validateLinkedSurvey(
  params: {
    specVersion: string | null;
    kind: string | null;
    surveyTxId: string | null;
    surveyDetails: SurveyDetails | null;
    governanceType: GovernanceType | null | undefined;
    proposalTxHash: string;
    certIndex: string;
    expirationEpoch: number | null | undefined;
  }
): ProposalSurveyPayload {
  const payload = emptySurveyPayload();
  payload.linked = params.surveyTxId !== null;
  payload.surveyTxId = params.surveyTxId;
  const normalizedSurveyDetails = normalizeSurveyDetails(params.surveyDetails);

  const actionEligibility = getActionEligibility(params.governanceType);
  const linkErrors: string[] = [];

  if (params.kind !== GOVERNANCE_SURVEY_LINK_KIND) {
    linkErrors.push(
      "Anchor metadata kind is not cardano-governance-survey-link."
    );
  }

  if (params.specVersion !== SURVEY_SPEC_VERSION) {
    linkErrors.push(
      `Anchor metadata specVersion must be ${SURVEY_SPEC_VERSION}.`
    );
  }

  if (!params.surveyTxId) {
    linkErrors.push("Missing surveyTxId in anchor metadata.");
  }

  if (params.surveyTxId && !normalizedSurveyDetails) {
    linkErrors.push(
      "Referenced surveyTxId has no label 17 surveyDetails payload."
    );
  }

  const parsedGovActionIx = Number(params.certIndex);
  if (!Number.isInteger(parsedGovActionIx) || parsedGovActionIx < 0) {
    linkErrors.push("certIndex must be a non-negative integer.");
  }

  const surveyDetailsValidation = validateSurveyDetails(
    normalizedSurveyDetails,
    actionEligibility,
    params.expirationEpoch
  );

  payload.surveyDetails = normalizedSurveyDetails;
  payload.surveyDetailsValidation = surveyDetailsValidation;

  const linkedRoleWeighting = filterLinkedRoleWeighting(
    normalizedSurveyDetails?.roleWeighting,
    actionEligibility
  );

  if (
    normalizedSurveyDetails &&
    Object.keys(linkedRoleWeighting ?? {}).length === 0
  ) {
    linkErrors.push(
      "Linked survey has no eligible roles after governance action filtering."
    );
  }

  payload.linkValidation = {
    valid: linkErrors.length === 0,
    errors: linkErrors,
    actionEligibility,
    linkedRoleWeighting,
    ...(Number.isInteger(parsedGovActionIx) && parsedGovActionIx >= 0
      ? {
          linkedActionId: {
            txId: params.proposalTxHash,
            govActionIx: parsedGovActionIx,
          },
        }
      : {}),
  };

  return payload;
}

export function validateSurveyDetails(
  surveyDetails: SurveyDetails | null,
  actionEligibility?: ResponderRole[],
  expirationEpoch?: number | null
): ProposalSurveyPayload["surveyDetailsValidation"] {
  const errors: string[] = [];
  const normalizedSurveyDetails = normalizeSurveyDetails(surveyDetails);

  if (!normalizedSurveyDetails) {
    return {
      valid: false,
      errors: ["Missing surveyDetails payload."],
    };
  }

  if (normalizedSurveyDetails.specVersion !== SURVEY_SPEC_VERSION) {
    errors.push(`surveyDetails.specVersion must be ${SURVEY_SPEC_VERSION}.`);
  }

  if (!normalizedSurveyDetails.title || !normalizedSurveyDetails.description) {
    errors.push("surveyDetails.title and surveyDetails.description are required.");
  }

  if (!Array.isArray(normalizedSurveyDetails.questions) || normalizedSurveyDetails.questions.length === 0) {
    errors.push("surveyDetails.questions must be a non-empty array.");
  }

  const seenQuestionIds = new Set<string>();
  for (const question of normalizedSurveyDetails.questions ?? []) {
    if (!question.questionId || !question.question) {
      errors.push("Every survey question must include questionId and question.");
      continue;
    }

    if (seenQuestionIds.has(question.questionId)) {
      errors.push(`Duplicate questionId '${question.questionId}' in surveyDetails.questions.`);
    }
    seenQuestionIds.add(question.questionId);

    errors.push(...validateQuestion(question));
  }

  if (
    !normalizedSurveyDetails.roleWeighting ||
    typeof normalizedSurveyDetails.roleWeighting !== "object" ||
    Object.keys(normalizedSurveyDetails.roleWeighting).length === 0
  ) {
    errors.push("surveyDetails.roleWeighting must be a non-empty object.");
  } else {
    for (const [role, mode] of Object.entries(normalizedSurveyDetails.roleWeighting)) {
      const typedRole = role as ResponderRole;
      if (!ROLE_WEIGHTING_COMPATIBILITY[typedRole]) {
        errors.push(`Unsupported responder role '${role}' in roleWeighting.`);
        continue;
      }

      if (!mode || !ROLE_WEIGHTING_COMPATIBILITY[typedRole].includes(mode)) {
        errors.push(`Role '${role}' cannot use weighting mode '${mode}'.`);
      }
    }
  }

  if (!Number.isInteger(normalizedSurveyDetails.endEpoch)) {
    errors.push("surveyDetails.endEpoch is required.");
  }

  if (
    typeof expirationEpoch === "number" &&
    Number.isInteger(normalizedSurveyDetails.endEpoch) &&
    normalizedSurveyDetails.endEpoch !== expirationEpoch
  ) {
    errors.push(
      "surveyDetails.endEpoch must exactly match the governance action expiration epoch."
    );
  }

  if (actionEligibility && actionEligibility.length > 0) {
    const linkedRoleWeighting = filterLinkedRoleWeighting(
      normalizedSurveyDetails.roleWeighting,
      actionEligibility
    );
    if (Object.keys(linkedRoleWeighting ?? {}).length === 0) {
      errors.push(
        "Linked survey has no eligible roles after governance action filtering."
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateSurveyResponse(
  surveyResponse: SurveyResponse | null,
  surveyDetails: SurveyDetails | null,
  derivedRole: ResponderRole,
  linkedSurveyTxId: string,
  responseEpoch?: number | null,
  options?: {
    allowedRoleWeighting?: Partial<Record<ResponderRole, WeightingMode>> | null;
    responseTxHash?: string;
    linkedVoteEvidence?: SurveyLinkedVoteEvidence | null;
  }
): string[] {
  const errors: string[] = [];

  if (!surveyResponse) {
    return ["Missing surveyResponse payload."];
  }

  if (surveyResponse.specVersion !== SURVEY_SPEC_VERSION) {
    errors.push(`surveyResponse.specVersion must be ${SURVEY_SPEC_VERSION}.`);
  }

  if (surveyResponse.surveyTxId !== linkedSurveyTxId) {
    errors.push("surveyResponse.surveyTxId does not match the linked survey.");
  }

  if (options?.responseTxHash && surveyResponse.surveyTxId === options.responseTxHash) {
    errors.push("surveyResponse.surveyTxId must not reference the response transaction itself.");
  }

  if (surveyResponse.responderRole !== derivedRole) {
    errors.push("surveyResponse.responderRole does not match the linked vote role.");
  }

  if (options?.linkedVoteEvidence) {
    errors.push(...options.linkedVoteEvidence.errors);

    if (
      options.linkedVoteEvidence.responderRole &&
      surveyResponse.responderRole !== options.linkedVoteEvidence.responderRole
    ) {
      errors.push(
        "surveyResponse.responderRole does not match the transaction voting_procedures role."
      );
    }

    if (!options.linkedVoteEvidence.responseCredential) {
      errors.push(
        "Could not derive exactly one eligible response credential from the linked vote transaction."
      );
    }
  }

  if (!surveyDetails) {
    errors.push("Missing linked surveyDetails for surveyResponse validation.");
    return errors;
  }

  const allowedRoleWeighting =
    options?.allowedRoleWeighting ?? surveyDetails.roleWeighting;
  const weightingMode = allowedRoleWeighting?.[derivedRole];
  if (!weightingMode) {
    errors.push(`Responder role '${derivedRole}' is not eligible for this survey.`);
  }

  if (
    typeof responseEpoch === "number" &&
    Number.isInteger(surveyDetails.endEpoch) &&
    responseEpoch > surveyDetails.endEpoch
  ) {
    errors.push("surveyResponse was submitted after surveyDetails.endEpoch.");
  }

  if (!Array.isArray(surveyResponse.answers) || surveyResponse.answers.length === 0) {
    errors.push("surveyResponse.answers must be a non-empty array.");
    return errors;
  }

  const questionMap = new Map(
    (surveyDetails.questions ?? []).map((question) => [question.questionId, question])
  );
  const seenQuestionIds = new Set<string>();

  for (const answer of surveyResponse.answers) {
    if (!answer.questionId) {
      errors.push("Every survey answer must include questionId.");
      continue;
    }

    if (seenQuestionIds.has(answer.questionId)) {
      errors.push(`Duplicate answer questionId '${answer.questionId}'.`);
    }
    seenQuestionIds.add(answer.questionId);

    const question = questionMap.get(answer.questionId);
    if (!question) {
      errors.push(`Unknown answer questionId '${answer.questionId}'.`);
      continue;
    }

    const valueKeys = [
      Array.isArray(answer.selection) ? "selection" : null,
      typeof answer.numericValue === "number" ? "numericValue" : null,
      answer.customValue !== undefined ? "customValue" : null,
    ].filter(Boolean);

    if (valueKeys.length !== 1) {
      errors.push(
        `Answer '${answer.questionId}' must include exactly one of selection, numericValue, or customValue.`
      );
      continue;
    }

    errors.push(...validateAnswer(question, answer));
  }

  return errors;
}

export function buildSurveyTally(
  surveyTxId: string,
  surveyDetails: SurveyDetails,
  allowedRoleWeighting: Partial<Record<ResponderRole, WeightingMode>>,
  votes: SurveyTallyVote[],
  options?: {
    phase?: ProposalSurveyTallyPhase;
    asOfEpoch?: number | null;
    finalizationEpoch?: number | null;
    warnings?: string[];
    enforceLinkedVoteEvidence?: boolean;
  }
): ProposalSurveyTallyResponse {
  const topLevelErrors = new Set<string>();
  const topLevelWarnings = new Set(options?.warnings ?? []);

  const groupedByRole = new Map<ResponderRole, SurveyTallyVote[]>();
  const roleStats = new Map<
    ResponderRole,
    { totalSeen: number; invalidValidation: number }
  >();
  let totalSeen = 0;
  let totalInvalid = 0;
  let totalValid = 0;
  let totalDeduped = 0;

  for (const vote of votes) {
    totalSeen++;
    const derivedRole = mapVoterTypeToResponderRole(vote.voterType);
    if (allowedRoleWeighting[derivedRole]) {
      const currentRoleStats = roleStats.get(derivedRole) ?? {
        totalSeen: 0,
        invalidValidation: 0,
      };
      currentRoleStats.totalSeen += 1;
      roleStats.set(derivedRole, currentRoleStats);
    }
    const rawResponse = safeParseJson(vote.surveyResponse);
    const surveyResponse = rawResponse
      ? extractSurveyResponse(rawResponse) ??
        (rawResponse as unknown as SurveyResponse)
      : null;
    const responseErrors = validateSurveyResponse(
      surveyResponse,
      surveyDetails,
      derivedRole,
      surveyTxId,
      vote.responseEpoch,
      {
        allowedRoleWeighting,
        responseTxHash: vote.txHash,
        linkedVoteEvidence: options?.enforceLinkedVoteEvidence
          ? vote.linkedVoteEvidence
          : null,
      }
    );

    if (responseErrors.length > 0) {
      totalInvalid++;
      const currentRoleStats = roleStats.get(derivedRole);
      if (currentRoleStats) {
        currentRoleStats.invalidValidation += 1;
        roleStats.set(derivedRole, currentRoleStats);
      }
      continue;
    }

    const roleVotes = groupedByRole.get(derivedRole) ?? [];
    roleVotes.push(vote);
    groupedByRole.set(derivedRole, roleVotes);
  }

  const roleResults: ProposalSurveyTallyRoleResult[] = [];

  for (const role of Object.keys(allowedRoleWeighting) as ResponderRole[]) {
    const weightingMode = allowedRoleWeighting[role];
    if (!weightingMode) {
      continue;
    }

    const roleVotes = groupedByRole.get(role) ?? [];
    const dedupedVotes = dedupeVotes(roleVotes);
    const invalid = roleVotes.length - dedupedVotes.length;
    totalDeduped += invalid;
    totalValid += dedupedVotes.length;
    const currentRoleStats = roleStats.get(role) ?? {
      totalSeen: roleVotes.length,
      invalidValidation: 0,
    };

    const methodResults = buildMethodResults(
      role,
      weightingMode,
      surveyDetails,
      dedupedVotes,
      topLevelErrors
    );

    roleResults.push({
      responderRole: role,
      weightingMode,
      totals: {
        totalSeen: currentRoleStats.totalSeen,
        valid: dedupedVotes.length,
        invalid: currentRoleStats.invalidValidation + invalid,
        deduped: invalid,
        uniqueResponders: dedupedVotes.length,
      },
      methodResults,
    });
  }

  return {
      surveyTxId,
      phase: options?.phase ?? "provisional",
      asOfEpoch: options?.asOfEpoch ?? null,
      finalizationEpoch: options?.finalizationEpoch ?? surveyDetails.endEpoch,
      totals: {
        totalSeen,
        valid: totalValid,
      invalid: totalInvalid + totalDeduped,
      deduped: totalDeduped,
      uniqueResponders: roleResults.reduce(
        (count, roleResult) => count + roleResult.totals.uniqueResponders,
        0
      ),
      },
      roleResults,
      errors: Array.from(topLevelErrors),
      warnings: Array.from(topLevelWarnings),
    };
}

function buildMethodResults(
  role: ResponderRole,
  weightingMode: WeightingMode,
  surveyDetails: SurveyDetails,
  votes: SurveyTallyVote[],
  errors: Set<string>
): Record<string, unknown>[] {
  return surveyDetails.questions.map((question) => {
    if (
      question.methodType === BUILTIN_METHODS.singleChoice ||
      question.methodType === BUILTIN_METHODS.multiSelect
    ) {
      const optionTotals = new Array(question.options?.length ?? 0).fill(0);

      for (const vote of votes) {
        const response = safeParseSurveyResponse(vote.surveyResponse);
        const answer = response?.answers.find(
          (candidate) => candidate.questionId === question.questionId
        );
        if (!answer?.selection) {
          continue;
        }

        const weight = getVoteWeight(role, weightingMode, vote, errors);
        for (const selection of answer.selection) {
          if (selection >= 0 && selection < optionTotals.length) {
            optionTotals[selection] += weight;
          }
        }
      }

      return {
        questionId: question.questionId,
        question: question.question,
        options: question.options ?? [],
        optionTotals,
      };
    }

    if (question.methodType === BUILTIN_METHODS.numericRange) {
      const values: number[] = [];
      let weightedTotal = 0;
      let totalWeight = 0;

      for (const vote of votes) {
        const response = safeParseSurveyResponse(vote.surveyResponse);
        const answer = response?.answers.find(
          (candidate) => candidate.questionId === question.questionId
        );
        if (typeof answer?.numericValue === "number") {
          values.push(answer.numericValue);
          const weight = getVoteWeight(role, weightingMode, vote, errors);
          weightedTotal += answer.numericValue * weight;
          totalWeight += weight;
        }
      }

      const count = values.length;
      return {
        questionId: question.questionId,
        question: question.question,
        count,
        min: count > 0 ? Math.min(...values) : null,
        max: count > 0 ? Math.max(...values) : null,
        mean: count > 0 && totalWeight > 0 ? weightedTotal / totalWeight : null,
      };
    }

    const customValueTotals: Record<string, number> = {};
    for (const vote of votes) {
      const response = safeParseSurveyResponse(vote.surveyResponse);
      const answer = response?.answers.find(
        (candidate) => candidate.questionId === question.questionId
      );
      if (answer?.customValue === undefined) {
        continue;
      }
      const key = JSON.stringify(answer.customValue);
      customValueTotals[key] =
        (customValueTotals[key] ?? 0) +
        getVoteWeight(role, weightingMode, vote, errors);
    }

    return {
      questionId: question.questionId,
      question: question.question,
      customValueTotals,
      unsupportedMethodType: question.methodType,
    };
  });
}

function getVoteWeight(
  role: ResponderRole,
  weightingMode: WeightingMode,
  vote: SurveyTallyVote,
  errors: Set<string>
): number {
  if (weightingMode === "CredentialBased") {
    return 1;
  }

  if (weightingMode === "PledgeBased") {
    if (vote.snapshotWeightError) {
      errors.add(vote.snapshotWeightError);
    }
    return vote.snapshotWeight ?? 0;
  }

  if (vote.snapshotWeightError) {
    errors.add(vote.snapshotWeightError);
  }

  if (typeof vote.snapshotWeight === "number") {
    return vote.snapshotWeight;
  }

  if (!vote.votingPower) {
    errors.add(
      `Missing voting power for ${role} ${weightingMode} response weighting.`
    );
    return 0;
  }

  return Number(vote.votingPower) / 1_000_000;
}

function dedupeVotes(votes: SurveyTallyVote[]): SurveyTallyVote[] {
  const latestByVoter = new Map<string, SurveyTallyVote>();

  for (const vote of votes) {
    const voterKey = vote.responseCredential ?? `${vote.voterType}:${vote.voterId}`;
    const current = latestByVoter.get(voterKey);
    if (!current || compareVotes(vote, current) > 0) {
      latestByVoter.set(voterKey, vote);
    }
  }

  return Array.from(latestByVoter.values());
}

function compareVotes(left: SurveyTallyVote, right: SurveyTallyVote): number {
  const leftSlot = left.absoluteSlot ?? -1;
  const rightSlot = right.absoluteSlot ?? -1;
  if (leftSlot !== rightSlot) {
    return leftSlot - rightSlot;
  }

  const leftIndex = left.txBlockIndex ?? -1;
  const rightIndex = right.txBlockIndex ?? -1;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }

  const leftMetadataPosition = left.metadataPosition ?? 0;
  const rightMetadataPosition = right.metadataPosition ?? 0;
  if (leftMetadataPosition !== rightMetadataPosition) {
    return leftMetadataPosition - rightMetadataPosition;
  }

  const leftTime = left.votedAt?.getTime() ?? 0;
  const rightTime = right.votedAt?.getTime() ?? 0;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.txHash.localeCompare(right.txHash);
}

function validateQuestion(question: SurveyQuestion): string[] {
  const errors: string[] = [];
  const isSingleChoice = question.methodType === BUILTIN_METHODS.singleChoice;
  const isMultiSelect = question.methodType === BUILTIN_METHODS.multiSelect;
  const isNumericRange = question.methodType === BUILTIN_METHODS.numericRange;
  const isBuiltin = isSingleChoice || isMultiSelect || isNumericRange;

  if (!isBuiltin) {
    if (!question.methodSchemaUri || !question.methodSchemaHash) {
      errors.push(
        `Custom method question '${question.questionId}' must include methodSchemaUri and methodSchemaHash.`
      );
    }
    return errors;
  }

  if (isSingleChoice || isMultiSelect) {
    if (!Array.isArray(question.options) || question.options.length < 2) {
      errors.push(
        `Question '${question.questionId}' must include at least two options.`
      );
    }
  }

  if (isSingleChoice) {
    if (
      question.maxSelections !== undefined &&
      question.maxSelections !== 1
    ) {
      errors.push(
        `Question '${question.questionId}' single-choice maxSelections must be absent or 1.`
      );
    }
  }

  if (isMultiSelect) {
    if (
      !Number.isInteger(question.maxSelections) ||
      (question.maxSelections ?? 0) < 1 ||
      (question.options && (question.maxSelections ?? 0) > question.options.length)
    ) {
      errors.push(
        `Question '${question.questionId}' multi-select maxSelections must be between 1 and the number of options.`
      );
    }
  }

  if (isNumericRange) {
    const constraints = question.numericConstraints;
    if (!constraints) {
      errors.push(
        `Question '${question.questionId}' numeric-range requires numericConstraints.`
      );
    } else {
      if (
        !Number.isInteger(constraints.minValue) ||
        !Number.isInteger(constraints.maxValue) ||
        constraints.minValue > constraints.maxValue
      ) {
        errors.push(
          `Question '${question.questionId}' numeric-range requires valid minValue and maxValue.`
        );
      }
      if (
        constraints.step !== undefined &&
        (!Number.isInteger(constraints.step) || constraints.step <= 0)
      ) {
        errors.push(
          `Question '${question.questionId}' numeric-range step must be a positive integer.`
        );
      }
    }

    if (question.options !== undefined || question.maxSelections !== undefined) {
      errors.push(
        `Question '${question.questionId}' numeric-range must not define options or maxSelections.`
      );
    }
  }

  return errors;
}

function validateAnswer(question: SurveyQuestion, answer: SurveyAnswer): string[] {
  const errors: string[] = [];
  const selection = answer.selection;
  const numericValue = answer.numericValue;

  if (question.methodType === BUILTIN_METHODS.singleChoice) {
    if (!Array.isArray(selection) || selection.length !== 1) {
      errors.push(
        `Answer '${question.questionId}' must contain exactly one selected option.`
      );
    } else if (!isSelectionValid(selection, question.options ?? [])) {
      errors.push(`Answer '${question.questionId}' contains an invalid option index.`);
    }
  }

  if (question.methodType === BUILTIN_METHODS.multiSelect) {
    if (!Array.isArray(selection)) {
      errors.push(`Answer '${question.questionId}' must include selection[].`);
    } else {
      if ((question.maxSelections ?? 0) > 0 && selection.length > (question.maxSelections ?? 0)) {
        errors.push(
          `Answer '${question.questionId}' exceeds maxSelections.`
        );
      }
      if (!isSelectionValid(selection, question.options ?? [])) {
        errors.push(`Answer '${question.questionId}' contains an invalid option index.`);
      }
    }
  }

  if (question.methodType === BUILTIN_METHODS.numericRange) {
    const constraints = question.numericConstraints;
    if (
      !constraints ||
      typeof numericValue !== "number" ||
      !Number.isInteger(numericValue)
    ) {
      errors.push(`Answer '${question.questionId}' must include numericValue.`);
    } else {
      if (
        numericValue < constraints.minValue ||
        numericValue > constraints.maxValue
      ) {
        errors.push(
          `Answer '${question.questionId}' numericValue is outside the allowed range.`
        );
      }
      if (
        constraints.step &&
        (numericValue - constraints.minValue) % constraints.step !== 0
      ) {
        errors.push(
          `Answer '${question.questionId}' numericValue does not satisfy the configured step.`
        );
      }
    }
  }

  return errors;
}

function isSelectionValid(selection: number[], options: string[]): boolean {
  return selection.every(
    (index) => Number.isInteger(index) && index >= 0 && index < options.length
  );
}

function filterLinkedRoleWeighting(
  roleWeighting: Partial<Record<ResponderRole, WeightingMode>> | undefined,
  actionEligibility: ResponderRole[]
): Partial<Record<ResponderRole, WeightingMode>> | null {
  if (!roleWeighting) {
    return null;
  }

  const filteredEntries = Object.entries(roleWeighting).filter(([role]) =>
    actionEligibility.includes(role as ResponderRole)
  );

  return Object.fromEntries(filteredEntries) as Partial<
    Record<ResponderRole, WeightingMode>
  >;
}

function extractLabel17(metadata: unknown): unknown {
  if (!metadata) {
    return null;
  }

  if (Array.isArray(metadata)) {
    for (const item of metadata) {
      if (!isObject(item)) {
        continue;
      }

      const label =
        item.label ??
        item.key ??
        item.metadata_label ??
        item.tx_metadata_label;

      if (String(label) !== "17") {
        continue;
      }

      const payload =
        item.json ??
        item.json_metadata ??
        item.metadata ??
        item.value;

      return payload ?? null;
    }

    return null;
  }

  if (isObject(metadata)) {
    const record = metadata as Record<string, unknown>;
    if (record["17"] !== undefined) {
      return record["17"];
    }
  }

  return null;
}

function mapVoterTypeToResponderRole(voterType: VoterType): ResponderRole {
  if (voterType === VoterType.DREP) {
    return "DRep";
  }
  if (voterType === VoterType.SPO) {
    return "SPO";
  }
  return "CC";
}

function safeParseSurveyResponse(
  surveyResponse: string | null | undefined
): SurveyResponse | null {
  const parsed = safeParseJson(surveyResponse);
  if (!parsed) {
    return null;
  }

  return extractSurveyResponse(parsed);
}

function safeParseJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
