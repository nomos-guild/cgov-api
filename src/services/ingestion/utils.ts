/**
 * Utility functions for data ingestion services
 */
import { isDeterministicGitHubUnresolvedError } from "./github-unresolved";

/**
 * Options for retry logic
 */
export interface RetryOptions {
  maxRetries: number;
  baseDelay: number; // milliseconds
  maxDelay: number;
  non429JitterMaxMs?: number;
  maxRetriesForRateLimit?: number;
  maxRetriesForTimeouts?: number;
  maxRetriesForNetworkErrors?: number;
  maxRetryAfterMs?: number;
}

export type RetryErrorClass =
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "client"
  | "unknown";

export interface RetryAttemptContext {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  status?: number;
  errorClass: RetryErrorClass;
  code?: string;
  error: unknown;
}

export interface RetryHooks {
  onRetry?: (context: RetryAttemptContext) => void;
  /** Called before each attempt with the zero-based attempt number. */
  onBeforeAttempt?: (attempt: number) => void;
  signal?: AbortSignal;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 2000, // 2 seconds
  maxDelay: 8000, // 8 seconds
  non429JitterMaxMs: 0,
};

function getRetryJitterMs(maxJitterMs: number | undefined): number {
  if (!maxJitterMs || maxJitterMs <= 0) return 0;
  return Math.floor(Math.random() * (maxJitterMs + 1));
}

function createAbortError(reason?: unknown): Error {
  const message =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? reason.message
        : "Operation aborted";
  const error = new Error(message);
  (error as any).name = "AbortError";
  (error as any).code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError((signal as any).reason);
}

function waitWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError((signal as any).reason));
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (done) return;
      done = true;
      cleanup();
      callback();
    };
    const timeout = setTimeout(() => {
      finish(resolve);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      finish(() => reject(createAbortError((signal as any).reason)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function classifyRetryError(error: any): RetryErrorClass {
  const status = error?.response?.status as number | undefined;
  if (status === 429) return "rate_limit";
  if (status && status >= 500) return "server";
  if (status && status >= 400) return "client";

  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message ?? "").toLowerCase();

  if (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    message.includes("timeout") ||
    message.includes("aborted")
  ) {
    return "timeout";
  }
  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    message.includes("socket hang up") ||
    message.includes("fetch failed")
  ) {
    return "network";
  }

  return "unknown";
}

function getMaxRetriesForError(
  options: RetryOptions,
  errorClass: RetryErrorClass
): number {
  if (errorClass === "rate_limit") {
    return options.maxRetriesForRateLimit ?? options.maxRetries;
  }
  if (errorClass === "timeout") {
    return options.maxRetriesForTimeouts ?? options.maxRetries;
  }
  if (errorClass === "network") {
    return options.maxRetriesForNetworkErrors ?? options.maxRetries;
  }
  return options.maxRetries;
}

/**
 * Wraps an async operation with retry logic and exponential backoff
 *
 * Special handling:
 * - Treats HTTP 429 (Too Many Requests) as *retryable* even though it's a 4xx
 * - Respects `Retry-After` header when present for rate-limited responses
 *
 * @param operation - The async function to execute
 * @param options - Retry configuration options
 * @returns Promise resolving to the operation result
 * @throws Error after max retries exceeded or on non-retryable errors
 *
 * @example
 * ```typescript
 * const result = await withRetry(async () => {
 *   return await fetchDataFromAPI();
 * });
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS,
  hooks?: RetryHooks
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      hooks?.onBeforeAttempt?.(attempt);
      throwIfAborted(hooks?.signal);
      return await operation();
    } catch (error: any) {
      if (hooks?.signal?.aborted) {
        throw createAbortError((hooks.signal as any).reason);
      }
      lastError = error;

      const status = error?.response?.status as number | undefined;
      const code = String(error?.code ?? "").toUpperCase() || undefined;
      const errorClass = classifyRetryError(error);
      const maxRetriesForError = getMaxRetriesForError(options, errorClass);

      // Deterministic unresolved repository errors should fail fast.
      if (isDeterministicGitHubUnresolvedError(error)) {
        console.warn(
          "Non-retryable GitHub unresolved repository error:",
          error.message
        );
        throw error;
      }

      // Don't retry on client errors (4xx) or validation errors
      // EXCEPT 429 (Too Many Requests), which we *do* want to retry with backoff.
      //
      // 5xx errors (including 503 Service Unavailable and 504 Gateway Timeout)
      // are intentionally retried — Koios docs explicitly note that queries
      // exceeding 30 s are returned as 504, and 503 signals transient overload.
      if (
        errorClass === "client" &&
        status &&
        status >= 400 &&
        status < 500 &&
        status !== 429
      ) {
        console.error(
          `Non-retryable error (${status}):`,
          error.message
        );
        throw error;
      }

      // If max retries reached, throw
      if (attempt >= maxRetriesForError) {
        throw error;
      }
      throwIfAborted(hooks?.signal);
      
      // Calculate delay:
      // - If 429 and Retry-After header is present, prefer that
      // - Otherwise, fall back to exponential backoff
      let delay = Math.min(
        options.baseDelay * Math.pow(2, attempt),
        options.maxDelay
      );

      const jitterMs = status === 429 ? 0 : getRetryJitterMs(options.non429JitterMaxMs);

      if (errorClass === "rate_limit") {
        const retryAfterHeader =
          error.response?.headers?.["retry-after"] ??
          error.response?.headers?.["Retry-After"];

        const retryAfterSeconds = retryAfterHeader
          ? parseInt(retryAfterHeader, 10)
          : NaN;

        if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
          const retryAfterCap = options.maxRetryAfterMs ?? Number.POSITIVE_INFINITY;
          delay = Math.min(retryAfterSeconds * 1000, retryAfterCap);
        }

        console.warn(
          `[withRetry] Rate limited (429). Waiting ${delay}ms before retry ` +
          `(${attempt + 1}/${maxRetriesForError})...`
        );
      }

      const delayWithJitter = delay + jitterMs;

      if (errorClass === "rate_limit") {
        // already logged above
      } else if (jitterMs > 0) {
        console.log(
          `Retry attempt ${attempt + 1}/${maxRetriesForError} after ${delayWithJitter}ms delay ` +
          `(base=${delay}ms + jitter=${jitterMs}ms)...`
        );
      } else {
        console.log(
          `Retry attempt ${attempt + 1}/${maxRetriesForError} after ${delay}ms delay...`
        );
      }

      throwIfAborted(hooks?.signal);
      hooks?.onRetry?.({
        attempt: attempt + 1,
        maxRetries: maxRetriesForError,
        delayMs: delayWithJitter,
        status,
        errorClass,
        code,
        error,
      });

      // Wait before retrying
      await waitWithAbort(delayWithJitter, hooks?.signal);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError || new Error("Operation failed with unknown error");
}

/**
 * Converts lovelace (smallest ADA unit) to ADA
 * @param lovelace - Amount in lovelace as string
 * @returns Amount in ADA as float, or null if invalid
 */
export function lovelaceToAda(lovelace: string | undefined): number | null {
  if (!lovelace) return null;
  try {
    return parseFloat(lovelace) / 1_000_000;
  } catch {
    return null;
  }
}

/**
 * Safely parse JSON string, returning null on error
 * @param jsonString - JSON string to parse
 * @returns Parsed object or null
 */
export function safeJsonParse(jsonString: string | undefined): any | null {
  if (!jsonString) return null;
  try {
    return JSON.parse(jsonString);
  } catch {
    return null;
  }
}
