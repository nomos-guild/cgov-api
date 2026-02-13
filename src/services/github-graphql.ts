import { withRetry, type RetryOptions } from "./ingestion/utils";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

const GITHUB_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 4,
  baseDelay: 5000, // 5 seconds (GitHub secondary limits need breathing room)
  maxDelay: 60000, // 60 seconds
};

// ─── Rate Limit State ────────────────────────────────────────────────────────

interface RateLimitState {
  remaining: number;
  resetAt: Date;
  lastCost: number;
}

let rateLimitState: RateLimitState = {
  remaining: 5000,
  resetAt: new Date(0),
  lastCost: 0,
};

export function getRateLimitState(): Readonly<RateLimitState> {
  return { ...rateLimitState };
}

// ─── Response Types ──────────────────────────────────────────────────────────

interface GraphQLRateLimit {
  cost: number;
  remaining: number;
  resetAt: string;
}

interface GraphQLError {
  message: string;
  type?: string;
  path?: string[];
}

interface GraphQLResponse<T = Record<string, unknown>> {
  data: T | null;
  errors?: GraphQLError[];
}

// ─── Core Client ─────────────────────────────────────────────────────────────

function getToken(): string {
  const token = process.env.GH_API_TOKEN;
  if (!token) {
    throw new Error("GH_API_TOKEN environment variable is not set");
  }
  return token;
}

async function rawQuery<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>
): Promise<GraphQLResponse<T>> {
  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${getToken()}`,
      "Content-Type": "application/json",
      "User-Agent": "cgov-api",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const error: any = new Error(
      `GitHub GraphQL ${response.status}: ${errorBody}`
    );
    error.response = {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    };
    throw error;
  }

  return response.json() as Promise<GraphQLResponse<T>>;
}

function updateRateLimit(rateLimit: GraphQLRateLimit | undefined): void {
  if (!rateLimit) return;
  rateLimitState = {
    remaining: rateLimit.remaining,
    resetAt: new Date(rateLimit.resetAt),
    lastCost: rateLimit.cost,
  };
}

async function waitForRateLimit(): Promise<void> {
  if (rateLimitState.remaining > 50) return;

  const now = Date.now();
  const resetMs = rateLimitState.resetAt.getTime();
  if (resetMs > now) {
    const waitMs = resetMs - now + 1000; // +1s buffer
    console.warn(
      `[github-graphql] Rate limit low (${rateLimitState.remaining} remaining). ` +
        `Waiting ${Math.round(waitMs / 1000)}s until reset...`
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Execute a GitHub GraphQL query with rate limit tracking and retry logic.
 * Always appends `rateLimit { cost remaining resetAt }` to the query.
 */
export async function githubGraphQL<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  await waitForRateLimit();

  const wrappedQuery = injectRateLimit(query);

  const result = await withRetry(async () => {
    const response = await rawQuery<T & { rateLimit?: GraphQLRateLimit }>(
      wrappedQuery,
      variables
    );

    if (response.errors?.length) {
      const msg = response.errors.map((e) => e.message).join("; ");
      throw new Error(`GitHub GraphQL errors: ${msg}`);
    }

    if (!response.data) {
      throw new Error("GitHub GraphQL returned null data");
    }

    updateRateLimit(response.data.rateLimit);
    return response.data;
  }, GITHUB_RETRY_OPTIONS);

  // Strip rateLimit from the returned data
  const { rateLimit: _, ...data } = result as any;
  return data as T;
}

/**
 * Build an aliased batch query for multiple repositories.
 * Each repo gets an alias like `repo0`, `repo1`, etc.
 *
 * @example
 * const query = buildBatchRepoQuery(
 *   [{ owner: "IntersectMBO", name: "cardano-node" }],
 *   `defaultBranchRef { target { ... on Commit {
 *     history(since: $since, first: 100) {
 *       nodes { oid message committedDate additions deletions }
 *       pageInfo { hasNextPage endCursor }
 *     }
 *   }}}`
 * );
 */
export function buildBatchRepoQuery(
  repos: { owner: string; name: string }[],
  innerFragment: string
): string {
  const aliases = repos
    .map(
      (r, i) =>
        `  repo${i}: repository(owner: "${r.owner}", name: "${r.name}") {\n    ${innerFragment}\n  }`
    )
    .join("\n");

  return `query {\n${aliases}\n}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function injectRateLimit(query: string): string {
  if (query.includes("rateLimit")) return query;

  // Insert `rateLimit { cost remaining resetAt }` before the closing `}`
  const lastBrace = query.lastIndexOf("}");
  if (lastBrace === -1) return query;

  return (
    query.slice(0, lastBrace) +
    "  rateLimit { cost remaining resetAt }\n" +
    query.slice(lastBrace)
  );
}
