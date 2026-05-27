/**
 * Tests for the strict integer query-param parser introduced for I4.
 * Guards: NaN/silent-default avoidance, range bounds, opt vs required
 * presence, and clear 400 messages.
 */

import {
  parseIntegerQuery,
  parseIntegerQueryOpt,
} from "../src/utils/query-params";

describe("parseIntegerQuery", () => {
  it("accepts a clean integer string within range", () => {
    expect(parseIntegerQuery("42", "x", { min: 0, max: 100 })).toEqual({
      ok: true,
      value: 42,
    });
  });

  it("accepts a leading-sign integer string", () => {
    expect(parseIntegerQuery("-5", "x", { min: -10 })).toEqual({
      ok: true,
      value: -5,
    });
  });

  it("returns the default when the value is omitted", () => {
    expect(parseIntegerQuery(undefined, "x", { default: 7 })).toEqual({
      ok: true,
      value: 7,
    });
  });

  it("returns the default when the value is empty string", () => {
    expect(parseIntegerQuery("", "x", { default: 9 })).toEqual({
      ok: true,
      value: 9,
    });
  });

  it("rejects a non-integer string with 400 (was a NaN→default landmine before)", () => {
    const r = parseIntegerQuery("abc", "epochStart", { default: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.message).toContain("epochStart");
    }
  });

  it("rejects floats — '3.14' would silently become 3 with parseInt", () => {
    const r = parseIntegerQuery("3.14", "x", { default: 0 });
    expect(r.ok).toBe(false);
  });

  it("rejects exponential notation — '1e5' would silently become 1 with parseInt", () => {
    const r = parseIntegerQuery("1e5", "x", { default: 0 });
    expect(r.ok).toBe(false);
  });

  it("rejects whitespace-padded values that lead with non-digits", () => {
    const r = parseIntegerQuery("  abc12 ", "x", { default: 0 });
    expect(r.ok).toBe(false);
  });

  it("rejects values below min", () => {
    const r = parseIntegerQuery("-1", "x", { min: 0, default: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("≥ 0");
  });

  it("rejects values above max", () => {
    const r = parseIntegerQuery("9999", "x", { max: 100, default: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("≤ 100");
  });

  it("rejects a missing param when no default is provided", () => {
    const r = parseIntegerQuery(undefined, "x");
    expect(r.ok).toBe(false);
  });

  it("rejects array-shaped values (Express duplicate query keys)", () => {
    const r = parseIntegerQuery(["1", "2"], "x", { default: 0 });
    expect(r.ok).toBe(false);
  });
});

describe("parseIntegerQueryOpt", () => {
  it("returns undefined for missing values", () => {
    expect(parseIntegerQueryOpt(undefined, "x")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("rejects garbage even when optional", () => {
    const r = parseIntegerQueryOpt("abc", "x");
    expect(r.ok).toBe(false);
  });

  it("validates ranges when value is provided", () => {
    const r = parseIntegerQueryOpt("-1", "x", { min: 0 });
    expect(r.ok).toBe(false);
  });

  it("returns parsed value for valid input", () => {
    expect(parseIntegerQueryOpt("42", "x", { min: 0 })).toEqual({
      ok: true,
      value: 42,
    });
  });
});

describe("toAdaString (precision-preserving conversion)", () => {
  it("formats small values with 6 decimals", async () => {
    const { toAdaString } = await import("../src/responses/lovelace");
    expect(toAdaString(1_234_567_890n)).toBe("1234.567890");
    expect(toAdaString(1n)).toBe("0.000001");
    expect(toAdaString(0n)).toBe("0.000000");
  });

  it("preserves precision above Number.MAX_SAFE_INTEGER (≥ 9 PADA)", async () => {
    const { toAdaString } = await import("../src/responses/lovelace");
    // 100 PADA = 100 * 1e15 lovelace = 1e17. Number(1e17) loses the ones digit;
    // the BigInt path must keep it intact.
    const oneHundredPada = 100_000_000_000_000_000n; // 1e17 lovelace
    expect(toAdaString(oneHundredPada)).toBe("100000000000.000000");
    // Add one lovelace: 1e17 + 1 — the ".000001" tail must still appear.
    expect(toAdaString(oneHundredPada + 1n)).toBe("100000000000.000001");
  });

  it("handles negative values", async () => {
    const { toAdaString } = await import("../src/responses/lovelace");
    expect(toAdaString(-1_234_567n)).toBe("-1.234567");
  });
});
