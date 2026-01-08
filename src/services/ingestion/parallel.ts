/**
 * Parallel Processing Utility
 * Provides controlled concurrent execution for API calls to avoid rate limits
 * Uses native Promise-based implementation (no external dependencies)
 */

export const DEFAULT_VOTER_SYNC_CONCURRENCY = 5;

/**
 * Gets the voter sync concurrency from environment variable
 * Falls back to DEFAULT_VOTER_SYNC_CONCURRENCY if not set or invalid
 */
export function getVoterSyncConcurrency(): number {
  const envValue = process.env.VOTER_SYNC_CONCURRENCY;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 20) {
      return parsed;
    }
  }
  return DEFAULT_VOTER_SYNC_CONCURRENCY;
}

/**
 * Result of parallel processing operation
 */
export interface ParallelResult<T> {
  successful: T[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Processes items in parallel with controlled concurrency
 * Native implementation using Promise pooling (no external dependencies)
 *
 * @param items - Array of items to process
 * @param getId - Function to extract a unique identifier from each item
 * @param processor - Async function to process each item (return null to skip)
 * @param concurrency - Maximum number of concurrent operations
 * @returns Object containing successful results and failed items with errors
 */
export async function processInParallel<TItem, TResult>(
  items: TItem[],
  getId: (item: TItem) => string,
  processor: (item: TItem) => Promise<TResult | null>,
  concurrency: number = DEFAULT_VOTER_SYNC_CONCURRENCY
): Promise<ParallelResult<TResult>> {
  const successful: TResult[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  // Process items with controlled concurrency using a pool
  let activeCount = 0;
  let currentIndex = 0;

  await new Promise<void>((resolve) => {
    const processNext = () => {
      // Check if we're done
      if (currentIndex >= items.length && activeCount === 0) {
        resolve();
        return;
      }

      // Start new tasks up to concurrency limit
      while (activeCount < concurrency && currentIndex < items.length) {
        const item = items[currentIndex];
        const id = getId(item);
        currentIndex++;
        activeCount++;

        processor(item)
          .then((result) => {
            if (result !== null) {
              successful.push(result);
            }
          })
          .catch((error: any) => {
            failed.push({ id, error: error.message || String(error) });
          })
          .finally(() => {
            activeCount--;
            processNext();
          });
      }
    };

    processNext();
  });

  return { successful, failed };
}
