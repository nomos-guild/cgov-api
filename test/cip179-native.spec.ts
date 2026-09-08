import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  Transaction,
  TransactionBody,
  AuxiliaryData,
} from "@evolution-sdk/evolution";
import { encodePayload, type SurveyDefinition } from "cip-179";
import {
  decodeNativeTransaction,
  verifyAnchorDocument,
} from "../src/libs/cip179Package.mts";
import { blake2b } from "@noble/hashes/blake2.js";
import { eligibleAt } from "../src/services/cip179/membership.service";
import { assertPublicAddress } from "../src/services/cip179/anchor.service";
const cbor = readFileSync("test/fixtures/native-vote.hex", "utf8").trim();
const fixture = JSON.parse(
  readFileSync("test/fixtures/native-vote.json", "utf8"),
);

describe("Native ledger metadata and anchors", () => {
  it("reads the independent CSL-signed Mesh transaction and its DRep proof", async () => {
    const result = await decodeNativeTransaction(cbor, fixture.txHash);
    expect(result.payload?.type).toBe("responses");
    expect(result.proof?.votes).toHaveLength(1);
  });
  it("rejects a substituted transaction body", async () => {
    await expect(
      decodeNativeTransaction(cbor, "00".repeat(32)),
    ).rejects.toThrow("different transaction");
  });
  it("rejects modified auxiliary bytes even when the body hash is unchanged", async () => {
    const changed = cbor.slice(0, -2) + (cbor.endsWith("00") ? "01" : "00");
    await expect(
      decodeNativeTransaction(changed, fixture.txHash),
    ).rejects.toThrow();
  });
  it("retains full int64 constraints and text that resembles JSON hex bytes", async () => {
    const definition: SurveyDefinition = {
      specVersion: 5,
      owner: { type: "key", keyHash: new Uint8Array(28) },
      title: "0x00",
      description: "Exact",
      eligibleRoles: [4],
      endEpoch: 600,
      submissionMode: { type: "public" },
      questions: [
        {
          type: "numericRange",
          prompt: "0x00",
          constraints: {
            min: -9223372036854775808n,
            max: 9223372036854775807n,
          },
        },
      ],
    };
    const old = Transaction.fromCBORHex(cbor);
    const auxiliaryData = AuxiliaryData.conway({
      metadata: new Map([
        [
          17n,
          encodePayload({
            type: "definitions",
            definitions: [definition],
          }) as any,
        ],
      ]),
    });
    const body = new TransactionBody.TransactionBody({
      ...old.body,
      auxiliaryDataHash: AuxiliaryData.toHash(auxiliaryData),
    });
    const tx = new Transaction.Transaction({ ...old, body, auxiliaryData });
    const encoded = Transaction.toCBORHex(tx);
    const hash = Buffer.from(
      TransactionBody.toHashFromBytes(
        Transaction.extractBodyBytes(Buffer.from(encoded, "hex")),
      ).hash,
    ).toString("hex");
    expect((await decodeNativeTransaction(encoded, hash)).payload).toEqual({
      type: "definitions",
      definitions: [definition],
    });
  });
  it("verifies raw anchor bytes, not a JSON reserialization", async () => {
    const bytes = new TextEncoder().encode('{ "body": {} }\n');
    const hash = Buffer.from(blake2b(bytes, { dkLen: 32 })).toString("hex");
    expect(await verifyAnchorDocument(bytes, hash)).toEqual({ body: {} });
    await expect(
      verifyAnchorDocument(new TextEncoder().encode('{"body":{}}'), hash),
    ).rejects.toThrow("hash mismatch");
  });
  it("rejects private, loopback, mapped and link-local connection addresses", () => {
    for (const value of [
      "127.0.0.1",
      "10.2.3.4",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fe80::1",
      "fc00::1",
    ])
      expect(() => assertPublicAddress(value)).toThrow();
    expect(() => assertPublicAddress("1.1.1.1")).not.toThrow();
  });
});

describe("Membership at precise inclusion and snapshot boundaries", () => {
  const event = (action: string, slot: number, index = 0, certIndex = 0) => ({
    action,
    slot,
    index,
    certIndex,
    epoch: 500,
    txHash: "11".repeat(32),
  });
  it("distinguishes transactions within the same slot", () => {
    const history = [event("registered", 10, 2)];
    expect(eligibleAt(history, 0, 500, { slot: 10, index: 1 })).toBe(false);
    expect(eligibleAt(history, 0, 500, { slot: 10, index: 2 })).toBe(true);
  });
  it("does not use a future registration to legitimize an earlier response", () => {
    const history = [
      event("registered", 10),
      event("deregistered", 20),
      event("registered", 30),
    ];
    expect(eligibleAt(history, 0, 500, { slot: 25, index: 0 })).toBe(false);
    expect(eligibleAt(history, 0, 500)).toBe(true);
  });
  it("requires delegated stake and clears it on deregistration", () => {
    expect(eligibleAt([event("registration", 10)], 3, 500)).toBe(false);
    expect(
      eligibleAt(
        [event("registration", 10), event("delegation_pool", 11)],
        3,
        500,
      ),
    ).toBe(true);
    expect(
      eligibleAt(
        [
          event("registration", 10),
          event("delegation_pool", 11),
          event("deregistration", 12),
          event("registration", 13),
        ],
        3,
        500,
      ),
    ).toBe(false);
  });
});
