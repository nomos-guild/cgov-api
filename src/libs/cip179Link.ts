export const CIP179_LINK_KIND = "survey-link";
export const CIP179_SPEC_VERSION = 5;

export interface Cip179SurveyRef {
  txId: string;
  index: number;
}

export interface Cip179LinkResult {
  linked: boolean;
  surveyRef: Cip179SurveyRef | null;
  errors: string[];
}

/** Koios expiration is the first inactive epoch; CIP-179 uses the last active epoch. */
export function governanceActionEndEpoch(
  expirationEpoch: number | null
): number | null {
  return Number.isInteger(expirationEpoch) && (expirationEpoch as number) > 0
    ? (expirationEpoch as number) - 1
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the v5 link from raw CIP-108 JSON. Readers intentionally do not gate on @context. */
export function parseCip179Link(metadata: string | unknown): Cip179LinkResult {
  let parsed: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return { linked: false, surveyRef: null, errors: ["Proposal metadata is not valid JSON."] };
    }
  }
  if (!isObject(parsed) || !isObject(parsed.body)) {
    return { linked: false, surveyRef: null, errors: [] };
  }
  const candidate = parsed.body.cip179;
  if (candidate === undefined) {
    return { linked: false, surveyRef: null, errors: [] };
  }
  if (!isObject(candidate)) {
    return { linked: true, surveyRef: null, errors: ["body.cip179 must be an object."] };
  }

  const errors: string[] = [];
  if (candidate.specVersion !== CIP179_SPEC_VERSION) {
    errors.push("body.cip179.specVersion must be 5.");
  }
  if (candidate.kind !== CIP179_LINK_KIND) {
    errors.push('body.cip179.kind must be "survey-link".');
  }
  const txId = candidate.surveyTxId;
  if (typeof txId !== "string" || !/^[0-9a-fA-F]{64}$/.test(txId)) {
    errors.push("body.cip179.surveyTxId must be a 64-character hexadecimal transaction ID.");
  }
  const index = candidate.surveyIndex;
  if (!Number.isInteger(index) || (index as number) < 0) {
    errors.push("body.cip179.surveyIndex must be a non-negative integer.");
  }

  return {
    linked: true,
    surveyRef:
      errors.length === 0
        ? { txId: (txId as string).toLowerCase(), index: index as number }
        : null,
    errors,
  };
}
