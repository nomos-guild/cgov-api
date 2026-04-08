import axios, { AxiosInstance } from "axios";
import https from "https";
import http from "http";
import type { KoiosProposal } from "../types/koios.types";
import {
  withRetry,
  type RetryAttemptContext,
  type RetryOptions,
} from "./ingestion/utils";
import {
  getBooleanEnv,
  getBoundedIntEnv,
  sleep,
} from "./koios/shared";
import {
  type AcquireMetrics,
  BurstLimiter,
  ConcurrencyLimiter,
} from "./koios/limiters";

// Single tunable timeout for all Koios requests, read from env.
const KOIOS_REQUEST_TIMEOUT_MS = getBoundedIntEnv(
  "KOIOS_REQUEST_TIMEOUT_MS",
  30000,
  1000,
  120000
);

// Certain endpoints (e.g. /proposal_voting_summary) are known to be slow.
// We give them an extra 10 s over the base timeout so the server has time to
// return a proper 504 rather than racing our client-side cutoff.  Receiving a
// 504 lets withRetry classify it as a retryable 5xx; a client-side timeout
// produces status=undefined and a less predictable retry path.
const KOIOS_SLOW_ENDPOINT_TIMEOUT_MS = getBoundedIntEnv(
  "KOIOS_SLOW_ENDPOINT_TIMEOUT_MS",
  KOIOS_REQUEST_TIMEOUT_MS + 10_000,
  1000,
  180000
);

// HTTP Keep-Alive agents to reuse TCP connections and avoid socket pool exhaustion.
// Socket timeout must be >= the longest per-endpoint timeout + 5 s so the OS
// does not tear down the socket before Axios receives the response.
const KOIOS_SOCKET_TIMEOUT_MS =
  Math.max(KOIOS_REQUEST_TIMEOUT_MS, KOIOS_SLOW_ENDPOINT_TIMEOUT_MS) + 5000;
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 15,
  maxFreeSockets: 5,
  timeout: KOIOS_SOCKET_TIMEOUT_MS,
});
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 15,
  maxFreeSockets: 5,
  timeout: KOIOS_SOCKET_TIMEOUT_MS,
});

const BASE_URL = process.env.KOIOS_BASE_URL || "https://api.koios.rest/api/v1";

// Baseline retry configuration for Koios API calls.
const KOIOS_DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 3000, // 3 seconds
  maxDelay: 30000, // 30 seconds
  maxRetriesForRateLimit: 4,
  maxRetriesForTimeouts: 1,
  maxRetriesForNetworkErrors: 2,
  maxRetryAfterMs: 180_000,
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
const DEFAULT_KOIOS_PRESSURE_WINDOW_MS = 60_000;
const DEFAULT_KOIOS_PRESSURE_THRESHOLD = 10;
const DEFAULT_KOIOS_PRESSURE_COOLDOWN_MS = 20_000;
const DEFAULT_KOIOS_TIMEOUT_COOLOFF_THRESHOLD = 5;
const DEFAULT_KOIOS_TIMEOUT_COOLOFF_WINDOW_MS = 20_000;
const DEFAULT_KOIOS_TIMEOUT_COOLOFF_MS = 10_000;
const KOIOS_MAX_PAGE_LIMIT = 1000;
const KOIOS_PUBLIC_MAX_BODY_BYTES = 1024;
const KOIOS_REGISTERED_MAX_BODY_BYTES = 5 * 1024;
const DEFAULT_PROPOSAL_LIST_INTERACTIVE_CACHE_TTL_MS = 5000;

type KoiosRetryProfileName =
  | "default"
  | "tx_metadata"
  | "slow_endpoint"
  | "high_volume";
interface KoiosRetryProfile {
  name: KoiosRetryProfileName;
  retry: RetryOptions;
  timeoutMs: number;
  timeoutByAttemptMs?: number[];
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

function getInteractiveProposalListCacheTtlMs(): number {
  return getBoundedIntEnv(
    "KOIOS_PROPOSAL_LIST_INTERACTIVE_CACHE_TTL_MS",
    DEFAULT_PROPOSAL_LIST_INTERACTIVE_CACHE_TTL_MS,
    250,
    30000
  );
}

function getKoiosMaxConcurrentRequests(): number {
  return getBoundedIntEnv(
    "KOIOS_MAX_CONCURRENT_REQUESTS",
    DEFAULT_KOIOS_MAX_CONCURRENT_REQUESTS,
    1,
    50
  );
}

const koiosAdaptiveConcurrencyEnabled = getBooleanEnv(
  "KOIOS_ADAPTIVE_CONCURRENCY_ENABLED",
  true
);
const koiosAdaptivePressureScale = getBoundedIntEnv(
  "KOIOS_ADAPTIVE_PRESSURE_SCALE_PERCENT",
  50,
  10,
  100
);
const koiosAdaptiveCooldownScale = getBoundedIntEnv(
  "KOIOS_ADAPTIVE_COOLDOWN_SCALE_PERCENT",
  34,
  10,
  100
);

function getAdaptiveScalePercent(): number {
  if (!koiosAdaptiveConcurrencyEnabled) return 100;
  const now = Date.now();
  if (koiosPressureCooldownUntil > now) return koiosAdaptiveCooldownScale;

  trimKoiosPressureEvents(now);
  if (koiosPressureEvents.length >= koiosPressureThreshold) {
    return koiosAdaptivePressureScale;
  }
  return 100;
}

function applyAdaptiveCap(baseMax: number): number {
  const scaled = Math.floor((baseMax * getAdaptiveScalePercent()) / 100);
  return Math.max(1, scaled);
}

const koiosBaseMaxConcurrentRequests = getKoiosMaxConcurrentRequests();
const globalKoiosLimiter = new ConcurrencyLimiter(
  "global",
  () => applyAdaptiveCap(koiosBaseMaxConcurrentRequests)
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
    "/pool_info",
    getBoundedIntEnv(
      "KOIOS_MAX_CONCURRENT_POOL_INFO",
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

// Endpoints that consistently approach the Koios server-side 30 s deadline.
// Using KOIOS_SLOW_ENDPOINT_TIMEOUT_MS (default: base + 10 s) ensures the
// server has time to return a 504 before the client cuts the connection.
const KOIOS_SLOW_ENDPOINTS = new Set(["/proposal_voting_summary"]);
const KOIOS_HIGH_VOLUME_ENDPOINTS = new Set([
  "/vote_list",
  "/pool_voting_power_history",
  "/drep_updates",
  "/drep_delegators",
  "/drep_voting_power_history",
]);

function getKoiosRetryOptionsForProfile(
  profile: KoiosRetryProfileName
): RetryOptions {
  const non429JitterMaxMs =
    KOIOS_DEFAULT_RETRY_OPTIONS.non429JitterMaxMs ?? 0;

  if (profile === "high_volume") {
    return {
      ...KOIOS_DEFAULT_RETRY_OPTIONS,
      maxRetries: getBoundedIntEnv("KOIOS_RETRY_MAX_HIGH_VOLUME", 2, 0, 8),
      maxRetriesForTimeouts: getBoundedIntEnv(
        "KOIOS_RETRY_TIMEOUT_HIGH_VOLUME",
        1,
        0,
        8
      ),
      maxRetriesForRateLimit: getBoundedIntEnv(
        "KOIOS_RETRY_429_HIGH_VOLUME",
        4,
        0,
        12
      ),
      non429JitterMaxMs: getBoundedIntEnv(
        "KOIOS_NON_429_RETRY_JITTER_HIGH_VOLUME_MAX_MS",
        non429JitterMaxMs,
        0,
        5000
      ),
    };
  }

  if (profile === "tx_metadata") {
    return {
      ...KOIOS_DEFAULT_RETRY_OPTIONS,
      maxRetries: getBoundedIntEnv("KOIOS_RETRY_MAX_TX_METADATA", 2, 0, 8),
      maxRetriesForTimeouts: getBoundedIntEnv(
        "KOIOS_RETRY_TIMEOUT_TX_METADATA",
        1,
        0,
        8
      ),
    };
  }

  if (profile === "slow_endpoint") {
    return {
      ...KOIOS_DEFAULT_RETRY_OPTIONS,
      maxRetries: getBoundedIntEnv("KOIOS_RETRY_MAX_SLOW_ENDPOINT", 3, 0, 8),
      maxRetriesForTimeouts: getBoundedIntEnv(
        "KOIOS_RETRY_TIMEOUT_SLOW_ENDPOINT",
        2,
        0,
        8
      ),
    };
  }

  return KOIOS_DEFAULT_RETRY_OPTIONS;
}

function getKoiosRetryProfile(url: string): KoiosRetryProfile {
  const endpoint = normalizeKoiosEndpoint(url);

  if (KOIOS_SLOW_ENDPOINTS.has(endpoint)) {
    return {
      name: "slow_endpoint",
      retry: getKoiosRetryOptionsForProfile("slow_endpoint"),
      timeoutMs: KOIOS_SLOW_ENDPOINT_TIMEOUT_MS,
      timeoutByAttemptMs: [
        KOIOS_REQUEST_TIMEOUT_MS,
        KOIOS_SLOW_ENDPOINT_TIMEOUT_MS,
      ],
    };
  }

  if (KOIOS_HIGH_VOLUME_ENDPOINTS.has(endpoint)) {
    return {
      name: "high_volume",
      retry: getKoiosRetryOptionsForProfile("high_volume"),
      timeoutMs: KOIOS_REQUEST_TIMEOUT_MS,
      timeoutByAttemptMs: [
        Math.max(5000, Math.floor(KOIOS_REQUEST_TIMEOUT_MS * 0.55)),
        Math.max(8000, Math.floor(KOIOS_REQUEST_TIMEOUT_MS * 0.75)),
        KOIOS_REQUEST_TIMEOUT_MS,
      ],
    };
  }

  if (endpoint === "/tx_metadata") {
    return {
      name: "tx_metadata",
      retry: getKoiosRetryOptionsForProfile("tx_metadata"),
      timeoutMs: KOIOS_REQUEST_TIMEOUT_MS,
      timeoutByAttemptMs: [
        Math.max(5000, Math.floor(KOIOS_REQUEST_TIMEOUT_MS * 0.6)),
        KOIOS_REQUEST_TIMEOUT_MS,
      ],
    };
  }

  return {
    name: "default",
    retry: getKoiosRetryOptionsForProfile("default"),
    timeoutMs: KOIOS_REQUEST_TIMEOUT_MS,
    timeoutByAttemptMs: [
      Math.max(5000, Math.floor(KOIOS_REQUEST_TIMEOUT_MS * 0.7)),
      KOIOS_REQUEST_TIMEOUT_MS,
    ],
  };
}

function onKoiosRetry(
  url: string,
  profileName: KoiosRetryProfileName,
  context?: KoiosRequestContext
) {
  const endpoint = normalizeKoiosEndpoint(url);
  const source = context?.source ?? "unknown";
  return (context: RetryAttemptContext) => {
    console.warn(
      `[Koios Retry] source=${source} endpoint=${endpoint} profile=${profileName} attempt=${context.attempt}/${context.maxRetries} waitMs=${context.delayMs} status=${context.status ?? "unknown"} class=${context.errorClass} code=${context.code ?? "none"}`
    );
  };
}

function getEndpointLimiter(url: string): ConcurrencyLimiter | undefined {
  const endpoint = normalizeKoiosEndpoint(url);
  const endpointMax = KOIOS_ENDPOINT_LIMITS.get(endpoint);
  if (!endpointMax) return undefined;

  const existing = endpointLimiters.get(endpoint);
  if (existing) return existing;

  const created = new ConcurrencyLimiter(endpoint, () =>
    applyAdaptiveCap(endpointMax)
  );
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
const koiosTimeoutCooloffThreshold = getBoundedIntEnv(
  "KOIOS_TIMEOUT_COOLOFF_THRESHOLD",
  DEFAULT_KOIOS_TIMEOUT_COOLOFF_THRESHOLD,
  1,
  100
);
const koiosTimeoutCooloffWindowMs = getBoundedIntEnv(
  "KOIOS_TIMEOUT_COOLOFF_WINDOW_MS",
  DEFAULT_KOIOS_TIMEOUT_COOLOFF_WINDOW_MS,
  1000,
  300000
);
const koiosTimeoutCooloffMs = getBoundedIntEnv(
  "KOIOS_TIMEOUT_COOLOFF_MS",
  DEFAULT_KOIOS_TIMEOUT_COOLOFF_MS,
  1000,
  300000
);
let koiosRequestCounter = 0;
let koiosBackoffUntil = 0;
let koiosPressureCooldownUntil = 0;
let koiosTimeoutCooldownUntil = 0;
const koiosPressureEvents: number[] = [];
const koiosTimeoutEvents: number[] = [];

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

function isKoiosTimeoutLikeError(error: any): boolean {
  const message = String(error?.message ?? "").toLowerCase();
  const code = String(error?.code ?? "").toUpperCase();
  return (
    message.includes("timeout") ||
    message.includes("aborted") ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED"
  );
}

function trimKoiosPressureEvents(now: number): void {
  while (
    koiosPressureEvents.length > 0 &&
    now - koiosPressureEvents[0] > koiosPressureWindowMs
  ) {
    koiosPressureEvents.shift();
  }
}

function trimKoiosTimeoutEvents(now: number): void {
  while (
    koiosTimeoutEvents.length > 0 &&
    now - koiosTimeoutEvents[0] > koiosTimeoutCooloffWindowMs
  ) {
    koiosTimeoutEvents.shift();
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

function recordKoiosTimeoutCooloffSignal(error: any): void {
  if (!isKoiosTimeoutLikeError(error)) {
    return;
  }
  const now = Date.now();
  trimKoiosTimeoutEvents(now);
  koiosTimeoutEvents.push(now);
  if (koiosTimeoutEvents.length < koiosTimeoutCooloffThreshold) {
    return;
  }
  koiosTimeoutCooldownUntil = Math.max(
    koiosTimeoutCooldownUntil,
    now + koiosTimeoutCooloffMs
  );
  console.warn(
    `[Koios Timeout Cooloff] action=degraded reason=timeout-burst windowMs=${koiosTimeoutCooloffWindowMs} threshold=${koiosTimeoutCooloffThreshold} cooldownMs=${koiosTimeoutCooloffMs} observed=${koiosTimeoutEvents.length}`
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

/**
 * Returns a unified snapshot of all Koios limiter health — mirrors
 * `getRateLimitState()` in the GitHub client. Useful for health-check
 * endpoints and debugging during ingestion runs.
 */
export function getKoiosLimiterState(): {
  backoffUntil: number;
  backoffActive: boolean;
  timeoutCooldownUntil: number;
  timeoutCooldownActive: boolean;
  burstWindowMs: number;
  burstMaxRequests: number;
  adaptiveScalePercent: number;
  pressure: ReturnType<typeof getKoiosPressureState>;
  concurrency: {
    global: { active: number; pending: number; max: number };
    endpoints: Record<string, { active: number; pending: number; max: number }>;
  };
} {
  const now = Date.now();
  const globalStats = globalKoiosLimiter.getStats();
  const endpoints: Record<
    string,
    { active: number; pending: number; max: number }
  > = {};
  for (const [name, limiter] of endpointLimiters) {
    const s = limiter.getStats();
    endpoints[name] = { active: s.active, pending: s.pending, max: s.max };
  }

  return {
    backoffUntil: koiosBackoffUntil,
    backoffActive: koiosBackoffUntil > now,
    timeoutCooldownUntil: koiosTimeoutCooldownUntil,
    timeoutCooldownActive: koiosTimeoutCooldownUntil > now,
    burstWindowMs: KOIOS_BURST_WINDOW_MS,
    burstMaxRequests: getBoundedIntEnv(
      "KOIOS_BURST_MAX_REQUESTS",
      KOIOS_BURST_MAX_REQUESTS,
      1,
      100
    ),
    adaptiveScalePercent: getAdaptiveScalePercent(),
    pressure: getKoiosPressureState(),
    concurrency: {
      global: {
        active: globalStats.active,
        pending: globalStats.pending,
        max: globalStats.max,
      },
      endpoints,
    },
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
  const endpoint = normalizeKoiosEndpoint(url);
  let waitBackoffMs = 0;
  let waitPressureMs = 0;
  let waitTimeoutCooloffMs = 0;
  // Pre-burst checks: wait out any active 429 backoff or pressure cooldown
  // before entering the burst queue. This prevents callers from stacking up
  // behind a long backoff and then thundering-herding when it expires.
  const now = Date.now();
  if (koiosBackoffUntil > now) {
    const waitMs = koiosBackoffUntil - now;
    waitBackoffMs += waitMs;
    await sleep(waitMs);
  }
  // Task 3: enforce pressure cooldown — mirrors GitHub's waitForRateLimit().
  const pressureNow = Date.now();
  if (koiosPressureCooldownUntil > pressureNow) {
    const waitMs = koiosPressureCooldownUntil - pressureNow;
    waitPressureMs += waitMs;
    await sleep(waitMs);
  }
  const timeoutNow = Date.now();
  if (koiosTimeoutCooldownUntil > timeoutNow) {
    const waitMs = koiosTimeoutCooldownUntil - timeoutNow;
    waitTimeoutCooloffMs += waitMs;
    await sleep(waitMs);
  }

  const burstWaitMs = await globalKoiosBurstLimiter.acquire();

  // Task 4: re-check after burst queue — callers that queued during a backoff
  // or pressure cooldown must not all fire at once when the burst slot opens.
  const afterBurst = Date.now();
  if (koiosBackoffUntil > afterBurst) {
    const waitMs = koiosBackoffUntil - afterBurst;
    waitBackoffMs += waitMs;
    await sleep(waitMs);
  }
  if (koiosPressureCooldownUntil > afterBurst) {
    const waitMs = koiosPressureCooldownUntil - afterBurst;
    waitPressureMs += waitMs;
    await sleep(waitMs);
  }
  if (koiosTimeoutCooldownUntil > afterBurst) {
    const waitMs = koiosTimeoutCooldownUntil - afterBurst;
    waitTimeoutCooloffMs += waitMs;
    await sleep(waitMs);
  }

  const requestId = nextKoiosRequestId();
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
        if (koiosLimiterLoggingEnabled) {
          console.log(
            `[Koios Limiter Wait] req=${requestId} endpoint=${endpoint} backoffWaitMs=${waitBackoffMs} pressureWaitMs=${waitPressureMs} timeoutCooloffWaitMs=${waitTimeoutCooloffMs} burstWaitMs=${burstWaitMs}`
          );
        }
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
      if (koiosLimiterLoggingEnabled) {
        console.log(
          `[Koios Limiter Wait] req=${requestId} endpoint=${endpoint} backoffWaitMs=${waitBackoffMs} pressureWaitMs=${waitPressureMs} timeoutCooloffWaitMs=${waitTimeoutCooloffMs} burstWaitMs=${burstWaitMs}`
        );
      }
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
  let nextUrl = url;
  let nextParams = params;

  if (params && typeof params === "object") {
    nextParams = { ...params };
    for (const key of ["limit", "_limit"]) {
      const value = Number(nextParams[key]);
      if (Number.isFinite(value) && value > KOIOS_MAX_PAGE_LIMIT) {
        nextParams[key] = KOIOS_MAX_PAGE_LIMIT;
      }
    }
  }

  if (url.includes("?")) {
    const [path, query] = url.split("?");
    const search = new URLSearchParams(query);
    for (const key of ["limit", "_limit"]) {
      const value = Number(search.get(key));
      if (Number.isFinite(value) && value > KOIOS_MAX_PAGE_LIMIT) {
        search.set(key, String(KOIOS_MAX_PAGE_LIMIT));
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
    timeout: KOIOS_REQUEST_TIMEOUT_MS,
    responseEncoding: "utf-8" as any, // Ensure UTF-8 decoding of response bodies
    httpsAgent,
    httpAgent,
  });

  // Add response interceptor for common error handling
  koiosInstance.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 429) {
        // Prefer the server-supplied Retry-After value so the global backoff
        // reflects the actual penalty period rather than the hardcoded default.
        const retryAfterHeader =
          error.response?.headers?.["retry-after"] ??
          error.response?.headers?.["Retry-After"];
        const retryAfterSeconds = retryAfterHeader
          ? parseInt(retryAfterHeader, 10)
          : NaN;
        const cooldownMs =
          !Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : KOIOS_429_COOLDOWN_MS;
        koiosBackoffUntil = Math.max(
          koiosBackoffUntil,
          Date.now() + cooldownMs
        );
      }
      recordKoiosPressureSignal(error);
      recordKoiosTimeoutCooloffSignal(error);
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

interface KoiosGetResult<T> {
  data: T;
  /** Raw Content-Range header value, e.g. "0-999/*", or null when absent. */
  contentRange: string | null;
}

/** Internal GET that surfaces both the response data and the Content-Range header. */
async function koiosGetInternal<T>(
  url: string,
  params?: any,
  context?: KoiosRequestContext
): Promise<KoiosGetResult<T>> {
  const koios = getKoiosService();
  const request = clampKoiosPaginationLimit(url, params);
  const retryProfile = getKoiosRetryProfile(request.url);
  const endpoint = normalizeKoiosEndpoint(request.url);
  const source = context?.source ?? "unknown";
  let attemptTimeoutMs = retryProfile.timeoutMs;

  try {
    return await withRetry(
      () =>
        withKoiosConcurrencyLimit(request.url, async () => {
          const requestConfig: any = {
            params: request.params,
            timeout: attemptTimeoutMs,
            __koiosSource: source,
          };
          const response = await koios.get<T>(request.url, requestConfig);
          const contentRange =
            (response.headers?.["content-range"] as string) ?? null;
          return { data: response.data, contentRange };
        }),
      retryProfile.retry,
      {
        onBeforeAttempt: (attempt) => {
          attemptTimeoutMs =
            retryProfile.timeoutByAttemptMs?.[attempt] ?? retryProfile.timeoutMs;
        },
        onRetry: onKoiosRetry(request.url, retryProfile.name, context),
      }
    );
  } catch (error: any) {
    console.error(
      `[Koios Request Failed] source=${source} endpoint=${endpoint} profile=${retryProfile.name} timeoutMs=${attemptTimeoutMs} message=${error?.message ?? error}`
    );
    throw error;
  }
}

/**
 * Makes a GET request to Koios API with built-in retry and concurrency logic.
 * For paginated endpoints where you need all records, use `koiosGetAll` instead.
 */
export async function koiosGet<T>(
  url: string,
  params?: any,
  context?: KoiosRequestContext
): Promise<T> {
  const { data, contentRange } = await koiosGetInternal<T>(url, params, context);
  const hasExplicitPagination =
    params
    && typeof params === "object"
    && ("offset" in params || "limit" in params);

  // Warn only for single-page callers. koiosGetAll handles pagination itself
  // and never reaches this path. Also skip warning when caller is explicitly
  // paginating with offset/limit.
  if (contentRange && !hasExplicitPagination) {
    const match = /^(\d+)-(\d+)\//.exec(contentRange);
    if (match) {
      const lower = parseInt(match[1], 10);
      const upper = parseInt(match[2], 10);
      if (upper - lower + 1 === KOIOS_MAX_PAGE_LIMIT) {
        const endpoint = normalizeKoiosEndpoint(url);
        console.warn(
          `[Koios Pagination] endpoint=${endpoint} Content-Range=${contentRange} — full page (${KOIOS_MAX_PAGE_LIMIT} items) returned, result may be truncated. Consider using koiosGetAll.`
        );
      }
    }
  }

  return data;
}

/**
 * Auto-paginating GET helper for Koios endpoints that return paginated results.
 *
 * Calls the endpoint repeatedly with incrementing `offset` values until a page
 * returns fewer than `KOIOS_MAX_PAGE_LIMIT` items (or `Content-Range` confirms
 * the last page), then returns the concatenated result array.
 *
 * Mirrors the conceptual model of `buildBatchRepoQuery` in the GitHub client —
 * callers don't need to manage pagination themselves.
 */
export async function koiosGetAll<T>(
  url: string,
  params?: any,
  context?: KoiosRequestContext
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  const endpoint = normalizeKoiosEndpoint(url);
  const isHighVolumeEndpoint = KOIOS_HIGH_VOLUME_ENDPOINTS.has(endpoint);
  let isFirstPage = true;

  while (true) {
    const pressureState = getKoiosPressureState();
    const adaptiveLimit =
      isHighVolumeEndpoint && pressureState.active
        ? Math.max(200, Math.floor(KOIOS_MAX_PAGE_LIMIT / 2))
        : KOIOS_MAX_PAGE_LIMIT;
    const adaptiveDelayMs =
      isHighVolumeEndpoint && pressureState.active ? 150 : 0;
    if (!isFirstPage && adaptiveDelayMs > 0) {
      await sleep(adaptiveDelayMs);
    }
    isFirstPage = false;

    const pageParams = {
      ...params,
      limit: adaptiveLimit,
      offset,
    };
    const { data, contentRange } = await koiosGetInternal<T[]>(
      url,
      pageParams,
      context
    );

    if (Array.isArray(data) && data.length > 0) {
      results.push(...data);
    }

    // Use Content-Range to detect the last page when available.
    if (contentRange) {
      const match = /^(\d+)-(\d+)\//.exec(contentRange);
      if (match) {
        const lower = parseInt(match[1], 10);
        const upper = parseInt(match[2], 10);
        if (upper - lower + 1 < adaptiveLimit) {
          break;
        }
      }
    }

    // Fall back to item count: a short page means no more records.
    if (!Array.isArray(data) || data.length < adaptiveLimit) {
      break;
    }

    offset += adaptiveLimit;
  }

  return results;
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
  let attemptTimeoutMs = retryProfile.timeoutMs;
  enforceKoiosPayloadLimit(request.url, data);

  try {
    return await withRetry(
      () =>
        withKoiosConcurrencyLimit(request.url, async () => {
          const requestConfig: any = {
            timeout: attemptTimeoutMs,
            __koiosSource: source,
          };
          const response = await koios.post<T>(request.url, data, requestConfig);
          return response.data;
        }),
      retryProfile.retry,
      {
        onBeforeAttempt: (attempt) => {
          attemptTimeoutMs =
            retryProfile.timeoutByAttemptMs?.[attempt] ?? retryProfile.timeoutMs;
        },
        onRetry: onKoiosRetry(request.url, retryProfile.name, context),
      }
    );
  } catch (error: any) {
    console.error(
      `[Koios Request Failed] source=${source} endpoint=${endpoint} profile=${retryProfile.name} timeoutMs=${attemptTimeoutMs} message=${error?.message ?? error}`
    );
    throw error;
  }
}
