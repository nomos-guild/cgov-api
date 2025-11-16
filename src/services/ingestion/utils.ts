/**
 * Utility functions for data ingestion services
 */

/**
 * Options for retry logic
 */
export interface RetryOptions {
  maxRetries: number;
  baseDelay: number; // milliseconds
  maxDelay: number;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 2000, // 2 seconds
  maxDelay: 8000, // 8 seconds
};

/**
 * Wraps an async operation with retry logic and exponential backoff
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
  options: RetryOptions = DEFAULT_RETRY_OPTIONS
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      // Don't retry on client errors (4xx) or validation errors
      if (error.response?.status >= 400 && error.response?.status < 500) {
        console.error(
          `Non-retryable error (${error.response.status}):`,
          error.message
        );
        throw error;
      }

      // If max retries reached, throw
      if (attempt === options.maxRetries) {
        throw new Error(
          `Operation failed after ${options.maxRetries} retries: ${error.message}`
        );
      }

      // Calculate exponential backoff delay
      const delay = Math.min(
        options.baseDelay * Math.pow(2, attempt),
        options.maxDelay
      );

      console.log(
        `Retry attempt ${attempt + 1}/${options.maxRetries} after ${delay}ms delay...`
      );

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
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
