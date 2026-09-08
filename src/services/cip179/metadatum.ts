import type { Metadatum } from "cip-179" with { "resolution-mode": "import" };

export type KoiosMetadatum =
  | bigint
  | number
  | string
  | KoiosMetadatum[]
  | { [key: string]: KoiosMetadatum };

const MAX_DEPTH = 64;
const HEX = /^[0-9a-fA-F]*$/;

function stringValue(value: string): string | Uint8Array {
  if (!value.startsWith("0x")) return value;
  const hex = value.slice(2);
  if (hex.length % 2 !== 0 || !HEX.test(hex)) {
    return value;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function mapKey(value: string): Metadatum {
  return /^-?\d+$/.test(value) ? BigInt(value) : stringValue(value);
}

export function koiosJsonToMetadatum(value: KoiosMetadatum, depth = 0): Metadatum {
  if (depth > MAX_DEPTH) throw new Error("metadata nesting exceeds 64 levels");
  if (typeof value === "bigint") return value;
  if (value === null || typeof value === "boolean" || typeof value === "undefined") throw new Error("Impossible metadata value");
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`unsafe metadata integer: ${value}`);
    return BigInt(value);
  }
  if (typeof value === "string") return stringValue(value);
  if (Array.isArray(value)) {
    return value.map((item) => koiosJsonToMetadatum(item, depth + 1));
  }
  return new Map(
    Object.entries(value).map(([key, item]) => [
      mapKey(key),
      koiosJsonToMetadatum(item, depth + 1),
    ])
  );
}
