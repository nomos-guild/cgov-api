/**
 * Shared query-param parsers for public API endpoints.
 *
 * The original `parseInt(req.query.x)` pattern returned NaN for bad input
 * and let the caller silently fall through to a default — meaning a typo
 * (`?epochStart=abc`) would silently return the default-window response
 * instead of telling the client they sent garbage. These helpers reject
 * non-integer / out-of-range values so the controller can return 400.
 */

export type ParseError = {
  ok: false;
  status: 400;
  error: string;
  message: string;
};

export type ParseOk<T> = { ok: true; value: T };

export type ParseResult<T> = ParseOk<T> | ParseError;

export interface ParseIntegerOptions {
  /** Lower bound (inclusive). */
  min?: number;
  /** Upper bound (inclusive). */
  max?: number;
  /** Returned when the param is omitted or empty. If absent, omitted params are an error. */
  default?: number;
}

/**
 * Parse a query-param value as an integer with strict validation.
 * Returns a discriminated result so the caller can short-circuit on
 * `result.ok === false` with `res.status(result.status).json(...)`.
 *
 * Behaviour:
 *   - Missing / empty: returns `default` if provided, else error.
 *   - Non-integer string ("abc", "3.14", "1e5"): error.
 *   - Out of [min, max] range: error.
 *   - Otherwise: parsed integer.
 */
export function parseIntegerQuery(
  raw: unknown,
  name: string,
  opts: ParseIntegerOptions = {}
): ParseResult<number> {
  if (raw === undefined || raw === null || raw === "") {
    if (opts.default !== undefined) {
      return { ok: true, value: opts.default };
    }
    return {
      ok: false,
      status: 400,
      error: "Missing query parameter",
      message: `Required query parameter '${name}' was not provided`,
    };
  }

  if (typeof raw !== "string") {
    return {
      ok: false,
      status: 400,
      error: "Invalid query parameter",
      message: `Query parameter '${name}' must be a single value, got ${typeof raw}`,
    };
  }

  // Strict integer-shape check: optional sign + digits, no decimals/exponents.
  if (!/^-?\d+$/.test(raw.trim())) {
    return {
      ok: false,
      status: 400,
      error: "Invalid query parameter",
      message: `Query parameter '${name}' must be an integer, got '${raw}'`,
    };
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      status: 400,
      error: "Invalid query parameter",
      message: `Query parameter '${name}' could not be parsed as an integer`,
    };
  }

  // Always reject values outside the JS safe-integer window — `parseInt` will
  // happily return imprecise Numbers above 2^53, and downstream Prisma calls
  // would either throw or silently truncate. Callers that legitimately need
  // string-typed BigInts should use a different helper.
  if (!Number.isSafeInteger(value)) {
    return {
      ok: false,
      status: 400,
      error: "Invalid query parameter",
      message: `Query parameter '${name}' is outside the safe integer range`,
    };
  }

  if (opts.min !== undefined && value < opts.min) {
    return {
      ok: false,
      status: 400,
      error: "Invalid query parameter",
      message: `Query parameter '${name}' must be ≥ ${opts.min}, got ${value}`,
    };
  }
  if (opts.max !== undefined && value > opts.max) {
    return {
      ok: false,
      status: 400,
      error: "Invalid query parameter",
      message: `Query parameter '${name}' must be ≤ ${opts.max}, got ${value}`,
    };
  }

  return { ok: true, value };
}

/**
 * Parse an optional integer query param. Returns `undefined` for omitted
 * values; rejects malformed input the same way as `parseIntegerQuery`.
 */
export function parseIntegerQueryOpt(
  raw: unknown,
  name: string,
  opts: Omit<ParseIntegerOptions, "default"> = {}
): ParseResult<number | undefined> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }
  const result = parseIntegerQuery(raw, name, opts);
  if (!result.ok) return result;
  return { ok: true, value: result.value };
}
