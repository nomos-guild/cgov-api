import axios, { AxiosInstance } from "axios";
import type { KoiosProposal } from "../types/koios.types";
import {
  withRetry,
  type RetryAttemptContext,
  type RetryOptions,
} from "./ingestion/utils";

const BASE_URL = process.env.KOIOS_BASE_URL || "https://api.koios.rest/api/v1";

// Dedicated retry configuration for Koios API calls.
// Koios rate limits can be hit during heavy syncs, so we:
// - Allow more retries
// - Use slightly longer base/max delays than the generic defaults
const KOIOS_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 5,
  baseDelay: 3000, // 3 seconds
  maxDelay: 30000, // 30 seconds
  non429JitterMaxMs: getBoundedIntEnv(
    "KOIOS_NON_429_RETRY_JITTER_MAX_MS",
    250,
    0,
    5000
  ),
};
const KOIOS_STRICT_TX_METADATA_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 3000,
  maxDelay: 30000,
  non429JitterMaxMs: getBoundedIntEnv(
    "KOIOS_NON_429_RETRY_JITTER_MAX_MS",
    250,
    0,
    5000
  ),
};

const DEFAULT_KOIOS_MAX_CONCURRENT_REQUESTS = 3;
const DEFAULT_ENDPOINT_MAX_CONCURRENT = 2;
const DEFAULT_KOIOS_LIMITER_SLOW_MS = 15000;
const KOIOS_BURST_WINDOW_MS = 10_000;
const KOIOS_BURST_MAX_REQUESTS = 90;
const KOIOS_429_COOLDOWN_MS = 60_000;
const DEFAULT_KOIOS_PRESSURE_WINDOW_MS = 30_000;
const DEFAULT_KOIOS_PRESSURE_THRESHOLD = 5;
const DEFAULT_KOIOS_PRESSURE_COOLDOWN_MS = 60_000;
const KOIOS_PUBLIC_MAX_BODY_BYTES = 1024;
const KOIOS_REGISTERED_MAX_BODY_BYTES = 5 * 1024;
const KOIOS_DEFAULT_TIMEOUT_MS = 30000;
const KOIOS_TX_METADATA_TIMEOUT_MS = 20000;
const DEFAULT_PROPOSAL_LIST_INTERACTIVE_CACHE_TTL_MS = 5000;

type KoiosRetryProfileName = "default" | "tx_metadata_strict";
interface KoiosRetryProfile {
  name: KoiosRetryProfileName;
  retry: RetryOptions;
  timeoutMs: number;
}

export interface KoiosRequestContext {
  source?: string;
}

interface InteractiveProposalListCacheEntry {
  value: KoiosProposal[];
  expiresAtMs: number;
}

let interactiveProposalListCache: InteractiveProposalListCacheEntry | null = null;
let interactiveProposalListInFlight: Promise<KoiosProposal[]> | null = null;

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

function getInteractiveProposalListCacheTtlMs(): number {
  return getBoundedIntEnv(
    "KOIOS_PROPOSAL_LIST_INTERACTIVE_CACHE_TTL_MS",
    DEFAULT_PROPOSAL_LIST_INTERACTIVE_CACHE_TTL_MS,
    250,
    30000
  );
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
  ["/vote_list", getBoundedIntEnv("KOIOS_MAX_CONCURRENT_VOTE_LIST", 1, 1, 20)],
  [
    "/proposal_voting_summary",
    getBoundedIntEnv("KOIOS_MAX_CONCURRENT_PROPOSAL_VOTING_SUMMARY", 1, 1, 20),
  ],
  [
    "/proposal_list",
    getBoundedIntEnv("KOIOS_MAX_CONCURRENT_PROPOSAL_LIST", 1, 1, 20),
  ],
  ["/tip", getBoundedIntEnv("KOIOS_MAX_CONCURRENT_TIP", 1, 1, 20)],
  ["/epoch_info", getBoundedIntEnv("KOIOS_MAX_CONCURRENT_EPOCH_INFO", 1, 1, 20)],
  [
    "/drep_epoch_summary",
    getBoundedIntEnv("KOIOS_MAX_CONCURRENT_DREP_EPOCH_SUMMARY", 1, 1, 20),
  ],
  [
    "/tx_metadata",
    getBoundedIntEnv("KOIOS_MAX_CONCURRENT_TX_METADATA", 1, 1, 10),
  ],
  [
    "/drep_voting_power_history",
    getBoundedIntEnv(
      "KOIOS_MAX_CONCURRENT_DREP_VOTING_POWER_HISTORY",
      1,
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
      1,
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
const koiosRetryCounters = new Map<string, number>();

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

function getKoiosRetryProfile(url: string): KoiosRetryProfile {
  const endpoint = normalizeKoiosEndpoint(url);
  if (endpoint === "/tx_metadata") {
    return {
      name: "tx_metadata_strict",
      retry: KOIOS_STRICT_TX_METADATA_RETRY_OPTIONS,
      timeoutMs: KOIOS_TX_METADATA_TIMEOUT_MS,
    };
  }

  return {
    name: "default",
    retry: KOIOS_RETRY_OPTIONS,
    timeoutMs: KOIOS_DEFAULT_TIMEOUT_MS,
  };
}

function incrementRetryCounter(endpoint: string): void {
  const current = koiosRetryCounters.get(endpoint) ?? 0;
  koiosRetryCounters.set(endpoint, current + 1);
}

function onKoiosRetry(
  url: string,
  profileName: KoiosRetryProfileName,
  context?: KoiosRequestContext
) {
  const endpoint = normalizeKoiosEndpoint(url);
  const source = context?.source ?? "unknown";
  return (context: RetryAttemptContext) => {
    incrementRetryCounter(endpoint);
    console.warn(
      `[Koios Retry] source=${source} endpoint=${endpoint} profile=${profileName} attempt=${context.attempt}/${context.maxRetries} waitMs=${context.delayMs} status=${context.status ?? "unknown"}`
    );
  };
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
const koiosPressureSheddingEnabled = getBooleanEnv(
  "KOIOS_PRESSURE_SHEDDING_ENABLED",
  true
);
const koiosPressureWindowMs = getBoundedIntEnv(
  "KOIOS_PRESSURE_WINDOW_MS",
  DEFAULT_KOIOS_PRESSURE_WINDOW_MS,
  5000,
  300000
);
const koiosPressureThreshold = getBoundedIntEnv(
  "KOIOS_PRESSURE_THRESHOLD",
  DEFAULT_KOIOS_PRESSURE_THRESHOLD,
  1,
  100
);
const koiosPressureCooldownMs = getBoundedIntEnv(
  "KOIOS_PRESSURE_COOLDOWN_MS",
  DEFAULT_KOIOS_PRESSURE_COOLDOWN_MS,
  5000,
  600000
);
let koiosRequestCounter = 0;
let koiosBackoffUntil = 0;
let koiosPressureCooldownUntil = 0;
const koiosPressureEvents: number[] = [];

function nextKoiosRequestId(): number {
  koiosRequestCounter += 1;
  return koiosRequestCounter;
}

function isKoiosPressureError(error: any): boolean {
  const status = error?.response?.status as number | undefined;
  if (status === 503) return true;

  const message = String(error?.message ?? "").toLowerCase();
  const code = String(error?.code ?? "").toUpperCase();

  if (message.includes("socket hang up")) return true;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE") {
    return true;
  }

  return false;
}

function trimKoiosPressureEvents(now: number): void {
  while (
    koiosPressureEvents.length > 0 &&
    now - koiosPressureEvents[0] > koiosPressureWindowMs
  ) {
    koiosPressureEvents.shift();
  }
}

function recordKoiosPressureSignal(error: any): void {
  if (!koiosPressureSheddingEnabled || !isKoiosPressureError(error)) {
    return;
  }

  const now = Date.now();
  trimKoiosPressureEvents(now);
  koiosPressureEvents.push(now);

  if (koiosPressureEvents.length < koiosPressureThreshold) {
    return;
  }

  koiosPressureCooldownUntil = Math.max(
    koiosPressureCooldownUntil,
    now + koiosPressureCooldownMs
  );
  console.warn(
    `[Koios Pressure] action=degraded reason=error-burst windowMs=${koiosPressureWindowMs} threshold=${koiosPressureThreshold} cooldownMs=${koiosPressureCooldownMs} observed=${koiosPressureEvents.length}`
  );
}

export function getKoiosPressureState(): {
  active: boolean;
  remainingMs: number;
  observedErrors: number;
  threshold: number;
  windowMs: number;
} {
  const now = Date.now();
  trimKoiosPressureEvents(now);
  const remainingMs = Math.max(0, koiosPressureCooldownUntil - now);

  return {
    active: koiosPressureSheddingEnabled && remainingMs > 0,
    remainingMs,
    observedErrors: koiosPressureEvents.length,
    threshold: koiosPressureThreshold,
    windowMs: koiosPressureWindowMs,
  };
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
    timeout: KOIOS_DEFAULT_TIMEOUT_MS,
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
      recordKoiosPressureSignal(error);
      console.error("Koios API Error:", {
        source: error.config?.__koiosSource,
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
export async function koiosGet<T>(
  url: string,
  params?: any,
  context?: KoiosRequestContext
): Promise<T> {
  const koios = getKoiosService();
  const request = clampKoiosPaginationLimit(url, params);
  const retryProfile = getKoiosRetryProfile(request.url);
  const endpoint = normalizeKoiosEndpoint(request.url);
  const source = context?.source ?? "unknown";

  try {
    return await withRetry(
      () =>
        withKoiosConcurrencyLimit(request.url, async () => {
          const requestConfig: any = {
            params: request.params,
            timeout: retryProfile.timeoutMs,
            __koiosSource: source,
          };
          const response = await koios.get<T>(request.url, requestConfig);
          return response.data;
        }),
      retryProfile.retry,
      {
        onRetry: onKoiosRetry(request.url, retryProfile.name, context),
      }
    );
  } catch (error: any) {
    const retries = koiosRetryCounters.get(endpoint) ?? 0;
    console.error(
      `[Koios Request Failed] source=${source} endpoint=${endpoint} profile=${retryProfile.name} timeoutMs=${retryProfile.timeoutMs} retriesSoFar=${retries} message=${error?.message ?? error}`
    );
    throw error;
  }
}

export async function getKoiosProposalList(options?: {
  context?: KoiosRequestContext;
  interactiveCache?: boolean;
  forceRefresh?: boolean;
}): Promise<KoiosProposal[]> {
  const context = options?.context;
  const source = context?.source ?? "unknown";
  const useInteractiveCache = options?.interactiveCache === true;
  const forceRefresh = options?.forceRefresh === true;

  if (!useInteractiveCache) {
    return koiosGet<KoiosProposal[]>("/proposal_list", undefined, context);
  }

  const now = Date.now();
  const cached = interactiveProposalListCache;
  if (!forceRefresh && cached && cached.expiresAtMs > now) {
    console.log(
      `[Koios Proposal List] action=cache-hit source=${source} ttlRemainingMs=${cached.expiresAtMs - now} proposals=${cached.value.length}`
    );
    return cached.value;
  }

  if (!forceRefresh && interactiveProposalListInFlight) {
    console.log(
      `[Koios Proposal List] action=single-flight-join source=${source}`
    );
    return interactiveProposalListInFlight;
  }

  const ttlMs = getInteractiveProposalListCacheTtlMs();
  let request: Promise<KoiosProposal[]>;
  request = koiosGet<KoiosProposal[]>("/proposal_list", undefined, context)
    .then((proposals) => {
      interactiveProposalListCache = {
        value: proposals,
        expiresAtMs: Date.now() + ttlMs,
      };
      console.log(
        `[Koios Proposal List] action=cache-fill source=${source} ttlMs=${ttlMs} proposals=${proposals.length}`
      );
      return proposals;
    })
    .finally(() => {
      if (interactiveProposalListInFlight === request) {
        interactiveProposalListInFlight = null;
      }
    });

  interactiveProposalListInFlight = request;
  return request;
}

/**
 * Helper function to make POST requests to Koios API with built-in retry logic
 * @param url - The endpoint path
 * @param data - The request body
 * @returns The data from the API response
 */
export async function koiosPost<T>(
  url: string,
  data?: any,
  context?: KoiosRequestContext
): Promise<T> {
  const koios = getKoiosService();
  const request = clampKoiosPaginationLimit(url);
  const retryProfile = getKoiosRetryProfile(request.url);
  const endpoint = normalizeKoiosEndpoint(request.url);
  const source = context?.source ?? "unknown";
  enforceKoiosPayloadLimit(request.url, data);

  try {
    return await withRetry(
      () =>
        withKoiosConcurrencyLimit(request.url, async () => {
          const requestConfig: any = {
            timeout: retryProfile.timeoutMs,
            __koiosSource: source,
          };
          const response = await koios.post<T>(request.url, data, requestConfig);
          return response.data;
        }),
      retryProfile.retry,
      {
        onRetry: onKoiosRetry(request.url, retryProfile.name, context),
      }
    );
  } catch (error: any) {
    const retries = koiosRetryCounters.get(endpoint) ?? 0;
    console.error(
      `[Koios Request Failed] source=${source} endpoint=${endpoint} profile=${retryProfile.name} timeoutMs=${retryProfile.timeoutMs} retriesSoFar=${retries} message=${error?.message ?? error}`
    );
    throw error;
  }
}
