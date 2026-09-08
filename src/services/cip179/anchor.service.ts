import axios from "axios";
import { Agent } from "node:https";
import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blockedV6.addSubnet(network, prefix, "ipv6");

export function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (
    !family ||
    (family === 4
      ? blockedV4.check(address, "ipv4")
      : blockedV6.check(address, "ipv6"))
  )
    throw new Error("Anchor addresses must be public");
}
function anchorUrl(uri: string): URL {
  const url = new URL(
    uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri,
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("Only public HTTPS/IPFS anchors are supported");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) assertPublicAddress(host);
  return url;
}
// Validate the addresses actually used by the connection, including after redirects.
const agent = new Agent({
  lookup(hostname, options, callback) {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, "", 4);
      try {
        if (!addresses.length)
          throw new Error("Anchor hostname has no addresses");
        for (const item of addresses) assertPublicAddress(item.address);
        if (typeof options === "object" && options.all)
          callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      } catch (reason) {
        callback(reason as Error, "", 4);
      }
    });
  },
});

export async function fetchVerifiedAnchor(
  uri: string | null,
  hash: string | null,
): Promise<unknown> {
  if (!uri || !hash || !/^[a-fA-F0-9]{64}$/.test(hash))
    throw new Error("Governance anchor URL/hash is unavailable");
  const url = anchorUrl(uri);
  const response = await axios.get<ArrayBuffer>(url.href, {
    responseType: "arraybuffer",
    timeout: 15_000,
    maxContentLength: 1_048_576,
    maxRedirects: 3,
    httpsAgent: agent,
    proxy: false,
    beforeRedirect: (options) => {
      anchorUrl(
        `${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ""}${options.path}`,
      );
    },
  });
  const { verifyAnchorDocument } = await import("../../libs/cip179Package.mjs");
  return verifyAnchorDocument(new Uint8Array(response.data), hash);
}
