import axios from "axios";
import type { KoiosSpo } from "../types/koios.types";

export function normaliseToHttpUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;

  const trimmed = rawUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

export function normaliseMetadataUrl(rawUrl: string): string {
  if (!rawUrl) {
    return rawUrl;
  }

  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("ipfs://")) {
    const ipfsHash = trimmed.replace("ipfs://", "");
    return `https://ipfs.io/ipfs/${ipfsHash}`;
  }

  return normaliseToHttpUrl(trimmed);
}

export async function fetchJsonWithBrowserLikeClient(
  url: string,
  redirectDepth = 0
): Promise<any | null> {
  const targetUrl = normaliseMetadataUrl(url);

  if (redirectDepth > 5) {
    console.warn(
      `[Remote Metadata] Too many redirects while fetching JSON for URL ${targetUrl}`
    );
    return null;
  }

  try {
    const response = await axios.get(targetUrl, {
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      validateStatus: () => true,
    });

    if (response.status >= 200 && response.status < 300 && response.data) {
      return response.data;
    }
  } catch (axiosError) {
    const msg =
      (axiosError as any)?.message ||
      (axiosError as any)?.toString?.() ||
      String(axiosError);
    console.warn(
      `[Remote Metadata] Axios JSON fetch failed for URL ${targetUrl}. Error: ${msg}`
    );
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

      const [response] = await Promise.all([
        page.waitForResponse(
          (res: any) => {
            try {
              const resUrl = res.url();
              const req =
                typeof res.request === "function" ? res.request() : null;
              const method =
                req && typeof req.method === "function" ? req.method() : null;

              if (method && method.toUpperCase() !== "GET") {
                return false;
              }

              return resUrl === targetUrl || resUrl.startsWith(targetUrl);
            } catch {
              return false;
            }
          },
          { timeout: 15000 }
        ),
        page
          .goto(targetUrl, {
            waitUntil: "networkidle0",
            timeout: 15000,
          })
          .catch(() => null),
      ]);

      if (!response) {
        return null;
      }

      const headers = response.headers?.() ?? {};
      const status =
        typeof (response as any).status === "function"
          ? (response as any).status()
          : 0;

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
            // Fall through to body parsing.
          }
        }
      }

      const contentType = (headers["content-type"] || "").toLowerCase();

      if (contentType.includes("application/json")) {
        try {
          const text = await response.text();
          return JSON.parse(text);
        } catch {
          // Fall through to generic parsing.
        }
      }

      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
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
        // Ignore close errors.
      }
    }
  } catch (error) {
    const message =
      (error as any)?.message || (error as any)?.toString?.() || String(error);
    console.warn(
      `[Remote Metadata] Failed to fetch JSON for URL ${targetUrl}. Error: ${message}`
    );
    return null;
  }
}

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

export async function fetchPoolMetadata(
  koiosSpo: KoiosSpo | undefined
): Promise<{
  poolName: string | null;
  ticker: string | null;
  iconUrl: string | null;
}> {
  if (!koiosSpo) {
    return { poolName: null, ticker: null, iconUrl: null };
  }

  let poolName: string | null = koiosSpo.meta_json?.name ?? null;
  let ticker: string | null = koiosSpo.meta_json?.ticker ?? null;
  let iconUrl: string | null = null;
  let extendedUrl: string | null = null;

  if (koiosSpo.meta_url) {
    const metaUrlFetch = normaliseMetadataUrl(koiosSpo.meta_url);

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
        `[Remote Metadata] Failed to fetch pool metadata (type=meta) from URL: ${metaUrlFetch}. Error: ${msg}`
      );
    }
  }

  if (extendedUrl) {
    try {
      const extendedMeta = await fetchJsonWithBrowserLikeClient(extendedUrl);
      if (extendedMeta) {
        iconUrl = findIconUrlInExtendedMeta(extendedMeta);
      }
    } catch (error) {
      const msg =
        (error as any)?.message ||
        (error as any)?.toString?.() ||
        String(error);
      console.warn(
        `[Remote Metadata] Failed to fetch pool metadata (type=extended) from URL: ${extendedUrl}. Error: ${msg}`
      );
    }
  }

  if (!ticker && koiosSpo.meta_json?.ticker) {
    ticker = koiosSpo.meta_json.ticker;
  }

  return { poolName, ticker, iconUrl };
}
