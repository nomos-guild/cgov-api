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

/** Decode exact ledger metadata; JSON from tx_metadata loses integer and map-key types. */
export async function decodeNativeTransaction(
  cbor: string,
  expectedHash: string,
) {
  const { Transaction, TransactionBody, CBOR } = await import(
    "@evolution-sdk/evolution"
  );
  const { blake2b } = await import("@noble/hashes/blake2.js");
  if (!/^(?:[a-fA-F0-9]{2})+$/.test(cbor) || cbor.length > 131072)
    throw new Error("Invalid or oversized transaction CBOR");
  const bytes = Buffer.from(cbor, "hex");
  const body = Transaction.extractBodyBytes(bytes);
  const hash = Buffer.from(TransactionBody.toHashFromBytes(body).hash).toString(
    "hex",
  );
  if (hash !== expectedHash)
    throw new Error("Provider returned a different transaction body");
  const tx = Transaction.fromCBORHex(cbor);
  if (!tx.isValid) return { payload: null, proof: null };
  let offset = body.byteOffset - bytes.byteOffset + body.length;
  offset = CBOR.decodeItemWithOffset(bytes, offset).newOffset; // witnesses
  offset = CBOR.decodeItemWithOffset(bytes, offset).newOffset; // validity flag
  const end = CBOR.decodeItemWithOffset(bytes, offset).newOffset;
  if (end !== bytes.length) throw new Error("Trailing transaction CBOR");
  if (
    !tx.auxiliaryData ||
    !tx.body.auxiliaryDataHash ||
    Buffer.from(blake2b(bytes.subarray(offset, end), { dkLen: 32 })).toString(
      "hex",
    ) !== Buffer.from(tx.body.auxiliaryDataHash.bytes).toString("hex")
  ) {
    throw new Error("Transaction metadata does not match the body anchor");
  }
  const { codec, txproof, evolution } = await loadCip179();
  const raw = tx.auxiliaryData.metadata?.get(17n);
  const proof = txproof.decodeTxProof(evolution.evolutionCodec, cbor);
  // A syntactically invalid CIP payload is terminal; missing/corrupt native bytes are retryable.
  try {
    return {
      payload: raw === undefined ? null : codec.decodePayload(raw),
      proof,
    };
  } catch {
    return { payload: null, proof };
  }
}

export async function verifyAnchorDocument(
  bytes: Uint8Array,
  expectedHash: string,
): Promise<unknown> {
  const { blake2b } = await import("@noble/hashes/blake2.js");
  if (
    Buffer.from(blake2b(bytes, { dkLen: 32 })).toString("hex") !==
    expectedHash.toLowerCase()
  )
    throw new Error("Governance anchor hash mismatch");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
