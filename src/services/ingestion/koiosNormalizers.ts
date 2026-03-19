export function extractStringField(value: unknown): string | undefined {
  if (value == null) return undefined;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    const withValue = value as { [key: string]: unknown };
    const candidate = (withValue["@value"] ?? withValue["value"]) as unknown;

    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return undefined;
}

export function extractBooleanField(value: unknown): boolean | undefined {
  if (value == null) return undefined;

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (normalised === "true") return true;
    if (normalised === "false") return false;
    return undefined;
  }

  if (typeof value === "object") {
    const withValue = value as { [key: string]: unknown };
    const candidate = withValue["@value"] ?? withValue["value"];
    return extractBooleanField(candidate);
  }

  return undefined;
}
