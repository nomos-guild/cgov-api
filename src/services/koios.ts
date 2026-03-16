import axios, { AxiosInstance } from "axios";
import { withRetry, type RetryOptions } from "./ingestion/utils";

const BASE_URL = process.env.KOIOS_BASE_URL || "https://api.koios.rest/api/v1";

// Dedicated retry configuration for Koios API calls.
// Koios rate limits can be hit during heavy syncs, so we:
// - Allow more retries
// - Use slightly longer base/max delays than the generic defaults
const KOIOS_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 5,
  baseDelay: 3000, // 3 seconds
  maxDelay: 30000, // 30 seconds
};

const DEFAULT_KOIOS_MAX_CONCURRENT_REQUESTS = 6;
const DEFAULT_ENDPOINT_MAX_CONCURRENT = 2;
const DEFAULT_KOIOS_LIMITER_SLOW_MS = 15000;
const KOIOS_BURST_WINDOW_MS = 10_000;
const KOIOS_BURST_MAX_REQUESTS = 90;
const KOIOS_429_COOLDOWN_MS = 60_000;
const KOIOS_PUBLIC_MAX_BODY_BYTES = 1024;
const KOIOS_REGISTERED_MAX_BODY_BYTES = 5 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBoundedIntEnv(
  envKey: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const rawValue = process.env[envKey];
  if (!rawValue) return defaultValue;

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return defaultValue;
  }
  return parsed;
}

function getBooleanEnv(envKey: string, defaultValue = false): boolean {
  const rawValue = process.env[envKey];
  if (!rawValue) return defaultValue;
  const normalized = rawValue.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

interface AcquireMetrics {
  waitMs: number;
  queued: boolean;
  activeAtAcquireStart: number;
  pendingAtAcquireStart: number;
}

class ConcurrencyLimiter {
  private activeCount = 0;
  private queue: Array<() => void> = [];

  constructor(
    private readonly name: string,
    private readonly maxConcurrent: number
  ) {}

  private async acquire(): Promise<AcquireMetrics> {
    const activeAtAcquireStart = this.activeCount;
    const pendingAtAcquireStart = this.queue.length;
    const acquireStart = Date.now();
    const queued = this.activeCount >= this.maxConcurrent;

    if (queued) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.activeCount += 1;
    return {
      waitMs: Date.now() - acquireStart,
      queued,
      activeAtAcquireStart,
      pendingAtAcquireStart,
    };
  }

  private release(): void {
    this.activeCount -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  async runWithAcquireMetrics<T>(
    operation: () => Promise<T>
  ): Promise<{ value: T; acquire: AcquireMetrics }> {
    const acquire = await this.acquire();
    try {
      const value = await operation();
      return { value, acquire };
    } finally {
      this.release();
    }
  }

  getStats(): { name: string; active: number; pending: number; max: number } {
    return {
      name: this.name,
      active: this.activeCount,
      pending: this.queue.length,
      max: this.maxConcurrent,
    };
  }
}

class BurstLimiter {
  private readonly timestamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  private trim(now: number): void {
    while (
      this.timestamps.length > 0 &&
      now - this.timestamps[0] >= this.windowMs
    ) {
      this.timestamps.shift();
    }
  }

  async acquire(): Promise<number> {
    let waitedMs = 0;

    const reservation = this.chain.then(async () => {
      while (true) {
        const now = Date.now();
        this.trim(now);

        if (this.timestamps.length < this.maxRequests) {
          this.timestamps.push(Date.now());
          return;
        }

        const oldest = this.timestamps[0];
        const toWait = Math.max(1, this.windowMs - (now - oldest));
        waitedMs += toWait;
        await sleep(toWait);
      }
    });

    // Keep the queue alive even if a waiter fails unexpectedly.
    this.chain = reservation.catch(() => undefined);
    await reservation;
    return waitedMs;
  }
}

function getKoiosMaxConcurrentRequests(): number {
  return getBoundedIntEnv(
    "KOIOS_MAX_CONCURRENT_REQUESTS",
    DEFAULT_KOIOS_MAX_CONCURRENT_REQUESTS,
    1,
    50
  );
}

const globalKoiosLimiter = new ConcurrencyLimiter(
  "global",
  getKoiosMaxConcurrentRequests()
);
const globalKoiosBurstLimiter = new BurstLimiter(
  getBoundedIntEnv("KOIOS_BURST_MAX_REQUESTS", KOIOS_BURST_MAX_REQUESTS, 1, 100),
  KOIOS_BURST_WINDOW_MS
);

const KOIOS_ENDPOINT_LIMITS = new Map<string, number>([
  [
    "/drep_voting_power_history",
    getBoundedIntEnv(
      "KOIOS_MAX_CONCURRENT_DREP_VOTING_POWER_HISTORY",
      DEFAULT_ENDPOINT_MAX_CONCURRENT,
      1,
      20
    ),
  ],
  [
    "/pool_voting_power_history",
    getBoundedIntEnv(
      "KOIOS_MAX_CONCURRENT_POOL_VOTING_POWER_HISTORY",
      DEFAULT_ENDPOINT_MAX_CONCURRENT,
      1,
      20
    ),
  ],
  [
    "/drep_info",
    getBoundedIntEnv(
      "KOIOS_MAX_CONCURRENT_DREP_INFO",
      DEFAULT_ENDPOINT_MAX_CONCURRENT,
      1,
      20
    ),
  ],
  [
    "/drep_updates",
    getBoundedIntEnv(
      "KOIOS_MAX_CONCURRENT_DREP_UPDATES",
      DEFAULT_ENDPOINT_MAX_CONCURRENT,
      1,
      20
    ),
  ],
  [
    "/drep_delegators",
    getBoundedIntEnv(
      "KOIOS_MAX_CONCURRENT_DREP_DELEGATORS",
      DEFAULT_ENDPOINT_MAX_CONCURRENT,
      1,
      20
    ),
  ],
  [
    "/account_update_history",
    getBoundedIntEnv("KOIOS_MAX_CONCURRENT_ACCOUNT_UPDATE_HISTORY", 1, 1, 10),
  ],
  ["/tx_info", getBoundedIntEnv("KOIOS_MAX_CONCURRENT_TX_INFO", 1, 1, 10)],
]);

const endpointLimiters = new Map<string, ConcurrencyLimiter>();

function normalizeKoiosEndpoint(url: string): string {
  const rawPath = (() => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return new URL(url).pathname;
    }
    return url.split("?")[0];
  })();

  const withLeadingSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const withoutApiPrefix = withLeadingSlash.replace(/^\/api\/v\d+/, "");
  return withoutApiPrefix || withLeadingSlash;
}

function getEndpointLimiter(url: string): ConcurrencyLimiter | undefined {
  const endpoint = normalizeKoiosEndpoint(url);
  const endpointMax = KOIOS_ENDPOINT_LIMITS.get(endpoint);
  if (!endpointMax) return undefined;

  const existing = endpointLimiters.get(endpoint);
  if (existing) return existing;

  const created = new ConcurrencyLimiter(endpoint, endpointMax);
  endpointLimiters.set(endpoint, created);
  return created;
}

const koiosLimiterLoggingEnabled = getBooleanEnv("KOIOS_LIMITER_LOG", false);
const koiosLimiterLogAllRequests = getBooleanEnv("KOIOS_LIMITER_LOG_ALL", false);
const koiosLimiterSlowThresholdMs = getBoundedIntEnv(
  "KOIOS_LIMITER_SLOW_MS",
  DEFAULT_KOIOS_LIMITER_SLOW_MS,
  1000,
  300000
);
let koiosRequestCounter = 0;
let koiosBackoffUntil = 0;

function nextKoiosRequestId(): number {
  koiosRequestCounter += 1;
  return koiosRequestCounter;
}

function logKoiosLimiterEvent(args: {
  requestId: number;
  endpoint: string;
  durationMs: number;
  endpointAcquire?: AcquireMetrics;
  globalAcquire: AcquireMetrics;
}) {
  if (!koiosLimiterLoggingEnabled) return;

  const { requestId, endpoint, durationMs, endpointAcquire, globalAcquire } =
    args;
  const totalQueueWaitMs =
    globalAcquire.waitMs + (endpointAcquire?.waitMs ?? 0);
  const shouldLog =
    koiosLimiterLogAllRequests ||
    totalQueueWaitMs > 0 ||
    durationMs >= koiosLimiterSlowThresholdMs;

  if (!shouldLog) return;

  const endpointStats = endpointLimiters.get(endpoint)?.getStats();
  const globalStats = globalKoiosLimiter.getStats();
  const reason: string[] = [];
  if (totalQueueWaitMs > 0) reason.push(`queueWaitMs=${totalQueueWaitMs}`);
  if (durationMs >= koiosLimiterSlowThresholdMs) {
    reason.push(
      `slowRequestMs=${durationMs}>=${koiosLimiterSlowThresholdMs}`
    );
  }
  if (reason.length === 0) reason.push("logAll");

  console.log(
    `[Koios Limiter] req=${requestId} endpoint=${endpoint} durationMs=${durationMs} reasons=${reason.join(
      ","
    )} endpointAcquire=${JSON.stringify(
      endpointAcquire ?? {
        waitMs: 0,
        queued: false,
        activeAtAcquireStart: 0,
        pendingAtAcquireStart: 0,
      }
    )} globalAcquire=${JSON.stringify(
      globalAcquire
    )} endpointStats=${JSON.stringify(
      endpointStats ?? null
    )} globalStats=${JSON.stringify(globalStats)}`
  );
}

async function withKoiosConcurrencyLimit<T>(
  url: string,
  operation: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  if (koiosBackoffUntil > now) {
    await sleep(koiosBackoffUntil - now);
  }
  await globalKoiosBurstLimiter.acquire();

  const requestId = nextKoiosRequestId();
  const endpoint = normalizeKoiosEndpoint(url);
  const startedAt = Date.now();
  const endpointLimiter = getEndpointLimiter(url);

  if (endpointLimiter) {
    let endpointAcquire: AcquireMetrics | undefined;
    let globalAcquire: AcquireMetrics | undefined;

    try {
      // Endpoint limiter first, then global limiter.
      // This prevents endpoint-heavy flows from crowding out unrelated requests.
      const endpointResult = await endpointLimiter.runWithAcquireMetrics(() =>
        globalKoiosLimiter.runWithAcquireMetrics(operation)
      );
      endpointAcquire = endpointResult.acquire;
      globalAcquire = endpointResult.value.acquire;
      return endpointResult.value.value;
    } finally {
      if (globalAcquire) {
        logKoiosLimiterEvent({
          requestId,
          endpoint,
          durationMs: Date.now() - startedAt,
          endpointAcquire,
          globalAcquire,
        });
      }
    }
  }

  let globalAcquire: AcquireMetrics | undefined;
  try {
    const globalResult = await globalKoiosLimiter.runWithAcquireMetrics(
      operation
    );
    globalAcquire = globalResult.acquire;
    return globalResult.value;
  } finally {
    if (globalAcquire) {
      logKoiosLimiterEvent({
        requestId,
        endpoint,
        durationMs: Date.now() - startedAt,
        globalAcquire,
      });
    }
  }
}

let koiosInstance: AxiosInstance | null = null;

function getKoiosMaxBodyBytes(): number {
  const hasApiKey = Boolean(process.env.KOIOS_API_KEY);
  const defaultMax = hasApiKey
    ? KOIOS_REGISTERED_MAX_BODY_BYTES
    : KOIOS_PUBLIC_MAX_BODY_BYTES;
  return getBoundedIntEnv("KOIOS_MAX_REQUEST_BODY_BYTES", defaultMax, 256, 10240);
}

function byteLengthUtf8(value: unknown): number {
  if (value == null) return 0;
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function enforceKoiosPayloadLimit(url: string, body?: unknown): void {
  if (body == null) return;
  const maxBytes = getKoiosMaxBodyBytes();
  const payloadBytes = byteLengthUtf8(body);
  if (payloadBytes > maxBytes) {
    throw new Error(
      `Koios payload too large for ${normalizeKoiosEndpoint(
        url
      )}: ${payloadBytes} bytes (max ${maxBytes}). Reduce batch size.`
    );
  }
}

function clampKoiosPaginationLimit(url: string, params?: any): {
  url: string;
  params?: any;
} {
  const MAX_PAGE_LIMIT = 1000;
  let nextUrl = url;
  let nextParams = params;

  if (params && typeof params === "object") {
    nextParams = { ...params };
    for (const key of ["limit", "_limit"]) {
      const value = Number(nextParams[key]);
      if (Number.isFinite(value) && value > MAX_PAGE_LIMIT) {
        nextParams[key] = MAX_PAGE_LIMIT;
      }
    }
  }

  if (url.includes("?")) {
    const [path, query] = url.split("?");
    const search = new URLSearchParams(query);
    for (const key of ["limit", "_limit"]) {
      const value = Number(search.get(key));
      if (Number.isFinite(value) && value > MAX_PAGE_LIMIT) {
        search.set(key, String(MAX_PAGE_LIMIT));
      }
    }
    nextUrl = `${path}?${search.toString()}`;
  }

  return { url: nextUrl, params: nextParams };
}

/**
 * Creates and configures an Axios instance for Koios API
 * @returns Configured Axios instance with auth headers and interceptors
 */
export const getKoiosService = (): AxiosInstance => {
  if (koiosInstance) {
    return koiosInstance;
  }

  const API_KEY = process.env.KOIOS_API_KEY || "";

  koiosInstance = axios.create({
    baseURL: BASE_URL,
    headers: {
      "Authorization": API_KEY ? `Bearer ${API_KEY}` : undefined,
      "Content-Type": "application/json",
    },
    timeout: 30000, // 30 second timeout for blockchain data queries
    responseEncoding: "utf-8" as any, // Ensure UTF-8 decoding of response bodies
  });

  // Add response interceptor for common error handling
  koiosInstance.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 429) {
        koiosBackoffUntil = Math.max(
          koiosBackoffUntil,
          Date.now() + KOIOS_429_COOLDOWN_MS
        );
      }
      console.error("Koios API Error:", {
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.message,
        url: error.config?.url,
      });
      return Promise.reject(error);
    }
  );

  return koiosInstance;
};

/**
 * Helper function to make GET requests to Koios API with built-in retry logic
 * @param url - The endpoint path (e.g., "/proposal_list")
 * @param params - Optional query parameters
 * @returns The data from the API response
 */
export async function koiosGet<T>(url: string, params?: any): Promise<T> {
  const koios = getKoiosService();
  const request = clampKoiosPaginationLimit(url, params);

  return withRetry(
    () =>
      withKoiosConcurrencyLimit(request.url, async () => {
        const response = await koios.get<T>(request.url, {
          params: request.params,
        });
        return response.data;
      }),
    KOIOS_RETRY_OPTIONS
  );
}

/**
 * Helper function to make POST requests to Koios API with built-in retry logic
 * @param url - The endpoint path
 * @param data - The request body
 * @returns The data from the API response
 */
export async function koiosPost<T>(url: string, data?: any): Promise<T> {
  const koios = getKoiosService();
  const request = clampKoiosPaginationLimit(url);
  enforceKoiosPayloadLimit(request.url, data);

  return withRetry(
    () =>
      withKoiosConcurrencyLimit(request.url, async () => {
        const response = await koios.post<T>(request.url, data);
        return response.data;
      }),
    KOIOS_RETRY_OPTIONS
  );
}