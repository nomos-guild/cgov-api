import {
  governanceActionEndEpoch,
  parseCip179Link,
} from "../src/libs/cip179Link";
import { koiosJsonToMetadatum } from "../src/services/cip179/metadatum";

import anchor from "./fixtures/cip179-anchor.json";
const TX_ID = "ab".repeat(32);

describe("CIP-179 v5 governance links", () => {
  it("reads a v5 link from the CIP-108 body", () => {
    expect(
      parseCip179Link({
        "@context": anchor["@context"],
        body: {
          cip179: {
            specVersion: 5,
            kind: "survey-link",
            surveyTxId: TX_ID.toUpperCase(),
            surveyIndex: 7,
          },
        },
      })
    ).toEqual({
      linked: true,
      surveyRef: { txId: TX_ID, index: 7 },
      errors: [],
    });
  });

  it("distinguishes no link from a malformed link", () => {
    expect(parseCip179Link({ body: { title: "No survey" } }).linked).toBe(false);
    const malformed = parseCip179Link({
        "@context": anchor["@context"],
      body: {
        cip179: {
          specVersion: "5",
          kind: "cardano-governance-survey-link",
          surveyTxId: "short",
        },
      },
    });
    expect(malformed.linked).toBe(true);
    expect(malformed.surveyRef).toBeNull();
    expect(malformed.errors).toHaveLength(4);
  });

  it("rejects invalid survey indices using the CIP uint16 upper bound", () => {
    for (const surveyIndex of [-1, 1.5, 65536, Number.MAX_SAFE_INTEGER]) {
      expect(
        parseCip179Link({
        "@context": anchor["@context"],
          body: {
            cip179: {
              specVersion: 5,
              kind: "survey-link",
              surveyTxId: TX_ID,
              surveyIndex,
            },
          },
        }).surveyRef
      ).toBeNull();
    }
    expect(
      parseCip179Link({
        "@context": anchor["@context"],
        body: {
          cip179: {
            specVersion: 5,
            kind: "survey-link",
            surveyTxId: TX_ID,
            surveyIndex: 65536,
          },
        },
      }).surveyRef?.index
    ).toBeUndefined();
  });

  it("converts Koios expiration to the action's last active epoch", () => {
    expect(governanceActionEndEpoch(700)).toBe(699);
    expect(governanceActionEndEpoch(null)).toBeNull();
  });
});

describe("Koios CIP-179 metadatum conversion", () => {
  it("preserves integer keys, bytes, arrays, and integers", () => {
    const result = koiosJsonToMetadatum({
      "0": 5,
      "1": ["0x00ff", "text"],
    });
    expect(result).toBeInstanceOf(Map);
    const map = result as Map<unknown, unknown>;
    expect(map.get(BigInt(0))).toBe(BigInt(5));
    expect(map.get(BigInt(1))).toEqual([new Uint8Array([0, 255]), "text"]);
  });

  it("rejects unsafe integers and excessive nesting", () => {
    expect(() => koiosJsonToMetadatum(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "unsafe metadata integer"
    );
    let nested: unknown = 0;
    for (let index = 0; index < 66; index += 1) nested = [nested];
    expect(() => koiosJsonToMetadatum(nested as never)).toThrow(
      "metadata nesting exceeds 64 levels"
    );
  });
});

describe("CIP-179 context boundaries", () => {
  it("rejects link field coercion outside the supported inline profile", () => {
    const document = JSON.parse(JSON.stringify(anchor));
    document["@context"].body["@context"].cip179["@context"].surveyTxId = {
      "@id": "CIP179:surveyTxId", "@type": "@id",
    };
    expect(parseCip179Link(document).surveyRef).toBeNull();
  });
  it("rejects a body coerced to JSON instead of the required scoped link predicates", () => {
    const document = JSON.parse(JSON.stringify(anchor));
    document["@context"].body["@type"] = "@json";
    expect(parseCip179Link(document).surveyRef).toBeNull();
  });
  it("rejects local keyword overrides even under an otherwise valid context", () => {
    const document = JSON.parse(JSON.stringify(anchor));
    document.body.cip179["@value"] = "hidden";
    expect(parseCip179Link(document).surveyRef).toBeNull();
  });
});
