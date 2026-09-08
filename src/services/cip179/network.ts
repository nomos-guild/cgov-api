export function cip179Network(): {
  name: "mainnet" | "preprod" | "preview";
  secondsPerEpoch: number;
} {
  const name = process.env.CIP179_NETWORK ?? "mainnet";
  if (name !== "mainnet" && name !== "preprod" && name !== "preview")
    throw new Error("Invalid CIP179_NETWORK");
  const base = process.env.KOIOS_BASE_URL ?? "https://api.koios.rest/api/v1";
  const host = new URL(base).hostname;
  const expected = name === "mainnet" ? "api.koios.rest" : `${name}.koios.rest`;
  if (host.endsWith("koios.rest") && host !== expected)
    throw new Error("CIP179_NETWORK and Koios network disagree");
  if (!host.endsWith("koios.rest") && !process.env.CIP179_NETWORK)
    throw new Error("Custom Koios requires explicit CIP179_NETWORK");
  return { name, secondsPerEpoch: name === "preview" ? 86_400 : 432_000 };
}
