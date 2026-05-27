/**
 * Lovelace serialization conventions.
 *
 * Cardano stake amounts are integer lovelace (1 ADA = 1e6 lovelace, 1 kADA = 1e9
 * lovelace). Mainnet whale stakes routinely exceed `Number.MAX_SAFE_INTEGER`
 * (2^53 ≈ 9 PADA), so naive `Number(bigint)` is lossy. Different endpoints in
 * this API made different precision/ergonomics trade-offs; this file pins the
 * contract so callers (and reviewers) can tell which is which from the type.
 *
 * The branding is purely TypeScript — over the wire each branded type
 * serialises as `string` or `number`. The brand exists so internal code that
 * accepts a "Lovelace amount" can refuse a raw `string`/`number` of the wrong
 * shape at compile time, and so the response files self-document.
 *
 * ─── Conventions ───────────────────────────────────────────────────────
 *
 *   `LovelaceString`  precision: exact   wire: string  used in: /migrations, /dreps (auth'd)
 *   `Kada`            precision: float64 wire: number  used in: /snapshot/dreps (`power`)
 *   `Ada`             precision: float64 wire: number  used in: /snapshot/chunks (`MIGRATIONS[].ada`)
 *   `AdaString`       precision: 6dp str wire: string  used in: /migrations (`ada`), /dreps (`votingPowerAda`)
 *
 * Drep-lens consumes the kADA/ADA numbers because it does its own clustering
 * arithmetic in client-side JS where BigInt is awkward; the precision loss is
 * accepted (visualisation, not accounting). Authenticated endpoints keep
 * `LovelaceString` because callers there are typically off-line pipelines
 * that need exact totals.
 */

declare const __lovelaceStringBrand: unique symbol;
declare const __kadaBrand: unique symbol;
declare const __adaBrand: unique symbol;
declare const __adaStringBrand: unique symbol;

/** Integer lovelace as a base-10 string. Precision-preserving for whale stakes. */
export type LovelaceString = string & { readonly [__lovelaceStringBrand]: true };

/** Lovelace converted to kADA (× 1e-9) as a JS number. Lossy ≥ 9 PADA. */
export type Kada = number & { readonly [__kadaBrand]: true };

/** Lovelace converted to ADA (× 1e-6) as a JS number. Lossy ≥ 9 EADA (basically never in practice). */
export type Ada = number & { readonly [__adaBrand]: true };

/** Lovelace converted to ADA as a fixed-6dp string ("123.456789"). Lossy at the 7th decimal. */
export type AdaString = string & { readonly [__adaStringBrand]: true };

export function toLovelaceString(value: bigint): LovelaceString {
  return value.toString() as LovelaceString;
}

export function toKada(lovelace: bigint): Kada {
  return (Number(lovelace) / 1_000_000_000) as Kada;
}

export function toAda(lovelace: bigint): Ada {
  return (Number(lovelace) / 1_000_000) as Ada;
}

export function toAdaString(lovelace: bigint): AdaString {
  // Compute the 6-decimal ADA string directly from the BigInt — going through
  // `Number(lovelace) / 1e6` rounds for amounts above 2^53 (whale stakes), which
  // would silently lose precision before `.toFixed(6)`.
  const negative = lovelace < 0n;
  const abs = negative ? -lovelace : lovelace;
  const integerPart = abs / 1_000_000n;
  const fractionalPart = abs % 1_000_000n;
  const sixDp = fractionalPart.toString().padStart(6, "0");
  return ((negative ? "-" : "") + integerPart.toString() + "." + sixDp) as AdaString;
}
