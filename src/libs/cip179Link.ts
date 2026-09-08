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
  expirationEpoch: number | null,
): number | null {
  return Number.isInteger(expirationEpoch) && (expirationEpoch as number) > 0
    ? (expirationEpoch as number) - 1
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Support the inline CIP-108 body-scoped context used by v5 authoring tools.
 * Remote/compound contexts require a controlled JSON-LD resolver, not guesswork.
 */
export function parseCip179Link(metadata: string | unknown): Cip179LinkResult {
  let parsed: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return {
        linked: false,
        surveyRef: null,
        errors: ["Proposal metadata is not valid JSON."],
      };
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
    return {
      linked: true,
      surveyRef: null,
      errors: ["body.cip179 must be an object."],
    };
  }

  const errors: string[] = [];
  const root = parsed["@context"];
  const body = isObject(root) && isObject(root.body) ? root.body : null;
  const bodyContext =
    body && isObject(body["@context"]) ? body["@context"] : null;
  const link =
    bodyContext && isObject(bodyContext.cip179) ? bodyContext.cip179 : null;
  const context = link && isObject(link["@context"]) ? link["@context"] : null;
  const prefixes = {
    ...(isObject(root) ? root : {}),
    ...(bodyContext ?? {}),
    ...(context ?? {}),
  };
  const expand = (value: unknown): unknown => {
    if (isObject(value)) value = value["@id"];
    if (typeof value !== "string") return null;
    const separator = value.indexOf(":");
    const prefix = prefixes[value.slice(0, separator)];
    return separator > 0 && typeof prefix === "string"
      ? prefix + value.slice(separator + 1)
      : value;
  };
  const cip =
    "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0179/README.md#";
  if (
    expand(body?.["@id"]) !==
      "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0108/README.md#body" ||
    expand(link?.["@id"]) !== cip + "link" ||
    !context ||
    ["specVersion", "kind", "surveyTxId", "surveyIndex"].some(
      (key) =>
        expand(context[key]) !== cip + key ||
        (isObject(context[key]) &&
          Object.keys(context[key]).some((term) => term !== "@id")),
    ) ||
    !body ||
    Object.keys(body).some((key) => !["@id", "@context"].includes(key)) ||
    !link ||
    Object.keys(link).some((key) => !["@id", "@context"].includes(key)) ||
    [root, bodyContext, context].some(
      (scope) =>
        isObject(scope) &&
        (Object.hasOwn(scope, "@import") ||
          Object.hasOwn(scope, "@propagate") ||
          (Object.hasOwn(scope, "@version") && scope["@version"] !== 1.1)),
    ) ||
    Object.keys(parsed.body).some((key) => key.startsWith("@")) ||
    Object.keys(candidate).some((key) => key.startsWith("@"))
  ) {
    errors.push(
      "CIP-179 link requires a supported inline body-scoped context without local overrides.",
    );
  }
  if (candidate.specVersion !== CIP179_SPEC_VERSION) {
    errors.push("body.cip179.specVersion must be 5.");
  }
  if (candidate.kind !== CIP179_LINK_KIND) {
    errors.push('body.cip179.kind must be "survey-link".');
  }
  const txId = candidate.surveyTxId;
  if (typeof txId !== "string" || !/^[0-9a-fA-F]{64}$/.test(txId)) {
    errors.push(
      "body.cip179.surveyTxId must be a 64-character hexadecimal transaction ID.",
    );
  }
  const index = candidate.surveyIndex;
  if (
    !Number.isSafeInteger(index) ||
    (index as number) < 0 ||
    (index as number) > 65535
  ) {
    errors.push("body.cip179.surveyIndex must be a uint16 integer (0..65535).");
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
