/**
 * Cardano governance sentinel DRep identifiers — and branded types that make
 * accidental misuse a compile error.
 *
 * The chain emits two protocol-defined "vote target" sentinels:
 *   - `drep_always_abstain`        — stake delegated here always abstains.
 *   - `drep_always_no_confidence`  — stake delegated here always votes "no".
 *
 * They are not real registered DReps; they appear in stake-delegation rows,
 * Koios voting summaries, and aggregate tables but should usually be filtered
 * out of "DRep listing" UIs and migration analyses.
 *
 * Branding strategy:
 *   `SentinelDrepId`     — narrow union of the two sentinel literals.
 *   `NonSentinelDrepId`  — opaque brand for "id that has been checked NOT to be a sentinel".
 *                          Use `requireNonSentinelDrepId()` at the point where you've ruled
 *                          sentinels out, then pass the branded value forward; downstream
 *                          functions can declare the parameter as `NonSentinelDrepId` and
 *                          the compiler refuses to accept a raw string.
 */

declare const __nonSentinelDrepIdBrand: unique symbol;

export const DREP_ALWAYS_ABSTAIN = "drep_always_abstain" as const;
export const DREP_ALWAYS_NO_CONFIDENCE = "drep_always_no_confidence" as const;

/** All sentinel DRep ids — useful for `notIn` / `IN` filters. */
export const SENTINEL_DREP_IDS: ReadonlyArray<SentinelDrepId> = [
  DREP_ALWAYS_ABSTAIN,
  DREP_ALWAYS_NO_CONFIDENCE,
];

export type SentinelDrepId =
  | typeof DREP_ALWAYS_ABSTAIN
  | typeof DREP_ALWAYS_NO_CONFIDENCE;

/**
 * Branded "DRep id, definitely not a sentinel". Construct via
 * `requireNonSentinelDrepId()` at the boundary where sentinels are filtered;
 * downstream code declares `NonSentinelDrepId` parameters and the compiler
 * rejects raw strings, catching a missed filter at type-check time.
 */
export type NonSentinelDrepId = string & {
  readonly [__nonSentinelDrepIdBrand]: true;
};

export function isSentinelDrepId(
  id: string | null | undefined
): id is SentinelDrepId {
  return id === DREP_ALWAYS_ABSTAIN || id === DREP_ALWAYS_NO_CONFIDENCE;
}

/**
 * Narrow a raw string to `NonSentinelDrepId`. Returns null when the input is
 * a sentinel; throw at the call site only where a non-sentinel is required.
 */
export function asNonSentinelDrepId(
  id: string
): NonSentinelDrepId | null {
  return isSentinelDrepId(id) ? null : (id as NonSentinelDrepId);
}

/**
 * Same as {@link asNonSentinelDrepId} but throws when the id is a sentinel.
 * Use at call sites that have already documented "sentinel rejected" — the
 * runtime check enforces what the type system claims.
 */
export function requireNonSentinelDrepId(id: string): NonSentinelDrepId {
  const branded = asNonSentinelDrepId(id);
  if (branded == null) {
    throw new Error(
      `requireNonSentinelDrepId: sentinel DRep id passed where a real DRep id was expected: ${id}`
    );
  }
  return branded;
}
