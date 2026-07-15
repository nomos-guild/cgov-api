/** One native-ESM boundary for the reusable CIP-179 package. */
export interface Cip179Package {
  codec: typeof import("cip-179");
  domain: typeof import("cip-179/domain");
  tally: typeof import("cip-179/tally");
  txproof: typeof import("cip-179/txproof");
  evolution: typeof import("cip-179/evolution");
}

let packagePromise: Promise<Cip179Package> | null = null;

export function loadCip179(): Promise<Cip179Package> {
  packagePromise ??= Promise.all([
    import("cip-179"),
    import("cip-179/domain"),
    import("cip-179/tally"),
    import("cip-179/txproof"),
    import("cip-179/evolution"),
  ]).then(([codec, domain, tally, txproof, evolution]) => ({
    codec,
    domain,
    tally,
    txproof,
    evolution,
  }));
  return packagePromise;
}
