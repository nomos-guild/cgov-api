/**
 * Voter Ingestion Service
 * Handles creation and updates of DRep, SPO, and CC voters
 */

import type { Prisma } from "@prisma/client";
import { koiosGet, koiosPost } from "../koios";
import { lovelaceToAda } from "./utils";
import type {
  KoiosDrep,
  KoiosDrepVotingPower,
  KoiosSpo,
  KoiosSpoVotingPower,
  KoiosCommitteeInfo,
  KoiosTip,
} from "../../types/koios.types";

/**
 * Some Koios metadata fields (e.g. from /drep_updates) can be returned either
 * as plain strings or as objects of the form `{ "@value": "..." }`.
 * This helper normalises them to plain strings so they can be stored in
 * Prisma `String` columns without causing runtime validation errors.
 */
function extractStringField(value: unknown): string | undefined {
  if (value == null) return undefined;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    // Common pattern for Koios / CIP-129 style fields
    const withValue = value as { [key: string]: unknown };
    const candidate = (withValue["@value"] ?? withValue["value"]) as unknown;

    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Normalises Koios boolean-like metadata fields.
 * Accepts:
 * - booleans
 * - "true"/"false" (case-insensitive) strings
 * - objects of the form `{ "@value": "true" }` or `{ value: false }`
 */
function extractBooleanField(value: unknown): boolean | undefined {
  if (value == null) return undefined;

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (normalised === "true") return true;
    if (normalised === "false") return false;
    return undefined;
  }

  if (typeof value === "object") {
    const withValue = value as { [key: string]: unknown };
    const candidate = withValue["@value"] ?? withValue["value"];
    return extractBooleanField(candidate);
  }

  return undefined;
}

/**
 * Result of ensuring a voter exists
 */
export interface EnsureVoterResult {
  voterId: string;
  created: boolean;
  updated: boolean;
}

/**
 * Gets current epoch from Koios API
 */
async function getCurrentEpoch(): Promise<number> {
  const tip = await koiosGet<KoiosTip[]>("/tip");
  return tip?.[0]?.epoch_no || 0;
}

/**
 * Ensures a voter exists in the database, creating or updating as needed
 *
 * @param voterRole - Type of voter (DRep, SPO, or CC)
 * @param voterId - The unique identifier for the voter
 * @param tx - Prisma transaction client
 * @returns Result with voter ID and creation/update status
 */
export async function ensureVoterExists(
  voterRole: "DRep" | "SPO" | "ConstitutionalCommittee",
  voterId: string,
  tx: Prisma.TransactionClient
): Promise<EnsureVoterResult> {
  if (voterRole === "DRep") {
    return ensureDrepExists(voterId, tx);
  } else if (voterRole === "SPO") {
    return ensureSpoExists(voterId, tx);
  } else {
    return ensureCcExists(voterId, tx);
  }
}

// Cache for API responses to avoid duplicate calls within a transaction
const drepInfoCache = new Map<string, KoiosDrep | undefined>();
const drepVotingPowerCache = new Map<string, number>();
const spoInfoCache = new Map<string, KoiosSpo | undefined>();
const spoVotingPowerCache = new Map<string, number>();

/**
 * Ensures a DRep exists, creating if needed and updating voting power
 */
async function ensureDrepExists(
  drepId: string,
  tx: Prisma.TransactionClient
): Promise<EnsureVoterResult> {
  const existing = await tx.drep.findUnique({
    where: { drepId },
  });

  // If voter exists, just return it without updating (optimization for initial sync)
  // Voting power updates can be done in a separate background job
  if (existing) {
    return { voterId: existing.drepId, created: false, updated: false };
  }

  // Check cache first, then fetch if not cached
  let koiosDrep = drepInfoCache.get(drepId);
  if (koiosDrep === undefined) {
    const koiosDrepResponse = await koiosPost<KoiosDrep[]>("/drep_info", {
      _drep_ids: [drepId],
    });
    koiosDrep = koiosDrepResponse?.[0];
    drepInfoCache.set(drepId, koiosDrep);
  }

  // Get current epoch for voting power history
  const currentEpoch = await getCurrentEpoch();
  const cacheKey = `${drepId}_${currentEpoch}`;

  let votingPower = drepVotingPowerCache.get(cacheKey);
  if (votingPower === undefined) {
    const votingPowerHistory = await koiosGet<KoiosDrepVotingPower[]>(
      "/drep_voting_power_history",
      {
        _epoch_no: currentEpoch,
        _drep_id: drepId,
      }
    );
    const votingPowerLovelace = votingPowerHistory?.[0]?.amount;
    votingPower = lovelaceToAda(votingPowerLovelace) || 0;
    drepVotingPowerCache.set(cacheKey, votingPower);
  }

  // Fetch name, payment address, icon URL, and doNotList from drep_updates endpoint
  // Note: these are nested in meta_json.body and can sometimes be structured
  // as `{ "@value": "..." }` objects instead of plain strings.
  let name: string | undefined;
  let paymentAddress: string | undefined;
  let iconUrl: string | undefined;
  let doNotList: boolean | undefined;
  try {
    const drepUpdates = await koiosGet<
      Array<{
        meta_json?: {
          body?: {
            // Koios can return either `string` or `{ "@value": string }`
            givenName?: unknown;
            paymentAddress?: unknown;
            doNotList?: unknown;
            image?: {
              contentUrl?: unknown;
            };
          };
        } | null;
      }>
    >("/drep_updates", { _drep_id: drepId });

    // Find the first record that has usable metadata in meta_json
    for (const update of drepUpdates || []) {
      const body = update.meta_json?.body;
      if (!body) continue;

      if (!name && body.givenName !== undefined) {
        name = extractStringField(body.givenName);
      }

      if (!paymentAddress && body.paymentAddress !== undefined) {
        paymentAddress = extractStringField(body.paymentAddress);
      }

      if (!iconUrl && body.image?.contentUrl !== undefined) {
        iconUrl = extractStringField(body.image.contentUrl);
      }

      if (doNotList === undefined && body.doNotList !== undefined) {
        doNotList = extractBooleanField(body.doNotList);
      }

      // Break if we have all values
      if (name && paymentAddress && iconUrl && doNotList !== undefined) {
        break;
      }
    }
  } catch (error) {
    console.warn(`[Voter Service] Failed to fetch metadata for DRep ${drepId}`);
  }

  // Create new DRep
  const newDrep = await tx.drep.create({
    data: {
      drepId,
      votingPower,
      ...(name && { name }), // Only include if exists
      ...(paymentAddress && { paymentAddress }), // Only include if exists
      ...(iconUrl && { iconUrl }), // Only include if exists
      ...(typeof doNotList === "boolean" && { doNotList }), // Only include if resolved
    },
  });

  return { voterId: newDrep.drepId, created: true, updated: false };
}

/**
 * Ensures an SPO exists, creating if needed and updating voting power
 */
async function ensureSpoExists(
  poolId: string,
  tx: Prisma.TransactionClient
): Promise<EnsureVoterResult> {
  const existing = await tx.sPO.findUnique({
    where: { poolId },
  });

  // If voter exists, just return it without updating (optimization for initial sync)
  // Voting power updates can be done in a separate background job
  if (existing) {
    return { voterId: existing.poolId, created: false, updated: false };
  }

  // Check cache first, then fetch if not cached
  let koiosSpo = spoInfoCache.get(poolId);
  if (koiosSpo === undefined) {
    const koiosSpoResponse = await koiosPost<KoiosSpo[]>("/pool_info", {
      _pool_bech32_ids: [poolId],
    });
    koiosSpo = koiosSpoResponse?.[0];
    spoInfoCache.set(poolId, koiosSpo);
  }

  // Get current epoch for voting power history
  const currentEpoch = await getCurrentEpoch();
  const cacheKey = `${poolId}_${currentEpoch}`;

  let votingPower = spoVotingPowerCache.get(cacheKey);
  if (votingPower === undefined) {
    const votingPowerHistory = await koiosGet<KoiosSpoVotingPower[]>(
      "/pool_voting_power_history",
      {
        _epoch_no: currentEpoch,
        _pool_bech32: poolId,
      }
    );
    const votingPowerLovelace = votingPowerHistory?.[0]?.amount;
    votingPower = lovelaceToAda(votingPowerLovelace) || 0;
    spoVotingPowerCache.set(cacheKey, votingPower);
  }

  // Get pool name, ticker, and icon URL from meta_json or meta_url
  const { poolName, ticker, iconUrl } = await getPoolMeta(koiosSpo);

  // Create new SPO
  const newSpo = await tx.sPO.create({
    data: {
      poolId,
      poolName,
      ticker,
      votingPower,
      ...(iconUrl && { iconUrl }), // Only include if exists
    },
  });

  return { voterId: newSpo.poolId, created: true, updated: false };
}

/**
 * Recursively searches an extended metadata object for icon URLs.
 * Prefers `url_png_icon_64x64`, then falls back to `url_png_logo`.
 */
function findIconUrlInExtendedMeta(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") {
    return null;
  }

  const record = obj as Record<string, unknown>;

  const icon64 = record["url_png_icon_64x64"];
  if (typeof icon64 === "string" && icon64.trim()) {
    return icon64;
  }

  const logo = record["url_png_logo"];
  if (typeof logo === "string" && logo.trim()) {
    return logo;
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const found = findIconUrlInExtendedMeta(value);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

/**
 * Ensures a URL has an HTTP/HTTPS scheme. Many metadata URLs are provided
 * without protocol (e.g. "git.io/abc123" or "bit.ly/xyz"), which Puppeteer
 * cannot navigate to directly.
 */
function normaliseToHttpUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;

  const trimmed = rawUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Default to HTTPS for bare host paths like "git.io/abc123"
  return `https://${trimmed}`;
}

/**
 * Fetches JSON from a URL using a real browser (Puppeteer) to work around
 * providers that block plain HTTP clients such as Axios.
 */
async function fetchJsonWithBrowserLikeClient(
  url: string,
  redirectDepth = 0
): Promise<any | null> {
  const targetUrl = normaliseToHttpUrl(url);

  // Prevent infinite redirect loops
  if (redirectDepth > 5) {
    console.warn(
      `[Voter Service] Too many redirects while fetching JSON via browser-like client for URL ${targetUrl}`
    );
    return null;
  }

  try {
    const puppeteerModule = await import("puppeteer");
    const puppeteer: any =
      (puppeteerModule as any).default || (puppeteerModule as any);

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      // For URLs that trigger a "download" (e.g. JSON served with
      // Content-Disposition: attachment) Chrome will often abort the
      // navigation and Puppeteer may return `null` from page.goto or
      // throw net::ERR_ABORTED. However, the underlying HTTP response
      // still exists, so we race `page.goto` with `waitForResponse`
      // and use the captured response body. We explicitly ignore
      // non-GET / preflight (OPTIONS) responses which don't have
      // readable bodies.
      const [response] = await Promise.all([
        page.waitForResponse((res: any) => {
          try {
            const resUrl = res.url();
            const req = typeof res.request === "function" ? res.request() : null;
            const method =
              req && typeof req.method === "function" ? req.method() : null;

            // Only consider real GET requests for this URL (or redirects),
            // and filter out preflight / OPTIONS requests which may not
            // expose a readable body.
            if (method && method.toUpperCase() !== "GET") {
              return false;
            }

            // Match the exact URL or a redirect derived from it.
            return resUrl === targetUrl || resUrl.startsWith(targetUrl);
          } catch {
            return false;
          }
        }, { timeout: 15000 }),
        page
          .goto(targetUrl, {
            waitUntil: "networkidle0",
            timeout: 15000,
          })
          .catch(() => null), // downloads often cause net::ERR_ABORTED
      ]);

      if (!response) {
        return null;
      }

      const headers = response.headers?.() ?? {};
      const status =
        typeof (response as any).status === "function"
          ? (response as any).status()
          : 0;

      // Follow HTTP redirects explicitly. For some providers (e.g. git.io),
      // the initial response is a 3xx with no readable body. In that case we
      // read the Location header and recursively fetch the target URL.
      if (status >= 300 && status < 400) {
        const locationHeader =
          (headers["location"] as string | undefined) ||
          (headers["Location"] as string | undefined);

        if (locationHeader) {
          try {
            const nextUrl = new URL(locationHeader, response.url()).toString();
            return await fetchJsonWithBrowserLikeClient(
              nextUrl,
              redirectDepth + 1
            );
          } catch {
            // If we can't parse the redirect URL, fall through to normal handling
          }
        }
      }

      const contentType = (headers["content-type"] || "").toLowerCase();

      // If the response declares JSON, try to parse it directly
      if (contentType.includes("application/json")) {
        try {
          const text = await response.text();
          return JSON.parse(text);
        } catch {
          // Fall through to the generic parsing logic below
        }
      }

      // Fallback: try to parse the whole body as JSON
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        // As a last resort, try to read structured data from the page context
        try {
          const fromWindow = await page.evaluate(() => {
            const w: any = globalThis as any;
            return (
              w.metadata ||
              w.__metadata ||
              w.pool ||
              w.__NEXT_DATA__?.props?.pageProps?.data ||
              null
            );
          });

          return fromWindow ?? null;
        } catch {
          return null;
        }
      }
    } finally {
      try {
        await browser.close();
      } catch {
        // Ignore close errors
      }
    }
  } catch (error) {
    const message =
      (error as any)?.message || (error as any)?.toString?.() || String(error);
    console.warn(
      `[Voter Service] Failed to fetch JSON via browser-like client for URL ${url}. Error: ${message}`
    );
    return null;
  }
}

/**
 * Gets pool name, ticker, and icon URL from meta_json or fetches from meta_url
 * For iconUrl: meta_url → fetch extended URL → search for url_png_icon_64x64 / url_png_logo
 */
async function getPoolMeta(
  koiosSpo: KoiosSpo | undefined
): Promise<{
  poolName: string | null;
  ticker: string | null;
  iconUrl: string | null;
}> {
  if (!koiosSpo) {
    return { poolName: null, ticker: null, iconUrl: null };
  }

  // Start with values from Koios response
  let poolName: string | null = koiosSpo.meta_json?.name ?? null;
  let ticker: string | null = koiosSpo.meta_json?.ticker ?? null;
  let iconUrl: string | null = null;
  let extendedUrl: string | null = null;

  // Fetch metadata from meta_url using browser-like client only
  if (koiosSpo.meta_url) {
    // Convert IPFS URLs to use an HTTP gateway
    let metaUrlFetch = koiosSpo.meta_url;
    if (koiosSpo.meta_url.startsWith("ipfs://")) {
      const ipfsHash = koiosSpo.meta_url.replace("ipfs://", "");
      metaUrlFetch = `https://ipfs.io/ipfs/${ipfsHash}`;
    }

    // Ensure we always have a valid HTTP/HTTPS URL (handles bare git.io/bit.ly, etc.)
    metaUrlFetch = normaliseToHttpUrl(metaUrlFetch);

    // Browser-like client (Puppeteer) for all meta URLs
    try {
      const metaFromBrowser = await fetchJsonWithBrowserLikeClient(metaUrlFetch);
      if (metaFromBrowser) {
        if (!poolName) {
          poolName = metaFromBrowser?.name || null;
        }
        if (!ticker) {
          ticker = metaFromBrowser?.ticker || null;
        }
        extendedUrl = metaFromBrowser?.extended || null;
      }
    } catch (browserError) {
      const msg =
        (browserError as any)?.message ||
        (browserError as any)?.toString?.() ||
        String(browserError);
      console.warn(
        `[Voter Service] Failed to fetch pool metadata (type=meta) from URL: ${metaUrlFetch}. Error: ${msg}`
      );
    }
  }

  // Fetch icon URL from extended metadata
  if (extendedUrl) {
    try {
      // Convert IPFS URLs to use an HTTP gateway
      let fetchUrl = extendedUrl;
      if (extendedUrl.startsWith("ipfs://")) {
        const ipfsHash = extendedUrl.replace("ipfs://", "");
        fetchUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
      }

      fetchUrl = normaliseToHttpUrl(fetchUrl);

      const extendedMeta = await fetchJsonWithBrowserLikeClient(fetchUrl);
      if (extendedMeta) {
        iconUrl = findIconUrlInExtendedMeta(extendedMeta);
      }
    } catch (error) {
      const msg =
        (error as any)?.message ||
        (error as any)?.toString?.() ||
        String(error);
      console.warn(
        `[Voter Service] Failed to fetch pool metadata (type=extended) from URL: ${extendedUrl}. Error: ${msg}`
      );
    }
  }

  // Final fallback: use top-level Koios ticker if still missing
  if (!ticker && koiosSpo.meta_json?.ticker) {
    ticker = koiosSpo.meta_json.ticker;
  }

  return { poolName, ticker, iconUrl };
}

/**
 * Ensures a CC member exists, creating if needed
 * Fetches from /committee_info and /committee_votes endpoints
 */
async function ensureCcExists(
  ccId: string,
  tx: Prisma.TransactionClient
): Promise<EnsureVoterResult> {
  const existing = await tx.cC.findUnique({
    where: { ccId },
  });

  // If voter exists, just return it without updating (optimization for initial sync)
  if (existing) {
    return { voterId: existing.ccId, created: false, updated: false };
  }

  // Fetch committee info from Koios
  const committeeInfo = await koiosGet<KoiosCommitteeInfo[]>("/committee_info");

  // Find this specific CC member by cc_hot_id
  const ccMember = committeeInfo?.[0]?.members?.find(
    (member) => member.cc_hot_id === ccId
  );

  // Get current epoch to determine status
  const currentEpoch = await getCurrentEpoch();

  // Determine status based on expiration_epoch
  let status = "active";
  if (ccMember?.expiration_epoch && ccMember.expiration_epoch <= currentEpoch) {
    status = "expired";
  }

  // Note: memberName will be populated later when we process their first vote
  // The vote metadata contains the author name which we'll use to update the CC member

  // Create new CC member
  const newCc = await tx.cC.create({
    data: {
      ccId,
      hotCredential: ccMember?.cc_hot_id || ccId,
      coldCredential: ccMember?.cc_cold_id,
      status,
      memberName: null, // Will be updated when processing votes
    },
  });

  return { voterId: newCc.ccId, created: true, updated: false };
}

/**
 * Directly ingest a DRep (for POST /data/drep/:drep_id endpoint)
 */
export async function ingestDrep(
  drepId: string,
  prisma: Prisma.TransactionClient
) {
  return ensureDrepExists(drepId, prisma);
}

/**
 * Directly ingest an SPO (for POST /data/spo/:pool_id endpoint)
 */
export async function ingestSpo(
  poolId: string,
  prisma: Prisma.TransactionClient
) {
  return ensureSpoExists(poolId, prisma);
}

/**
 * Directly ingest a CC member (for POST /data/cc/:cc_id endpoint)
 */
export async function ingestCc(ccId: string, prisma: Prisma.TransactionClient) {
  return ensureCcExists(ccId, prisma);
}
