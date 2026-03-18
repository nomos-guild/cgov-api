const RETRYABLE_PRISMA_CODES = new Set(["P1001", "P1017"]);
const RETRYABLE_CONNECTION_SIGNATURES = [
  "econnreset",
  "etimedout",
  "epipe",
  "connection reset by peer",
  "server has closed the connection",
  "can't reach database server",
];

function collectCandidateMessages(error: any): string[] {
  const values = [
    error?.message,
    error?.cause?.message,
    error?.meta?.cause,
    error?.meta?.message,
  ];

  return values
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => String(value).toLowerCase());
}

export function isRetryablePrismaConnectionError(error: unknown): boolean {
  if (process.env.PRISMA_RETRYABLE_CONNECTIVITY_ENABLED === "false") {
    return false;
  }

  const candidate = error as any;
  const errorCode = String(candidate?.code ?? candidate?.cause?.code ?? "").toUpperCase();
  if (RETRYABLE_PRISMA_CODES.has(errorCode)) {
    return true;
  }

  const messages = collectCandidateMessages(candidate);
  if (messages.length === 0) {
    return false;
  }

  return RETRYABLE_CONNECTION_SIGNATURES.some((signature) =>
    messages.some((message) => message.includes(signature))
  );
}

interface PrismaConnectivityRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  operationName?: string;
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
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return defaultValue;
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withPrismaConnectivityRetry<T>(
  operation: () => Promise<T>,
  options?: PrismaConnectivityRetryOptions
): Promise<T> {
  const maxRetries =
    options?.maxRetries ??
    getBoundedIntEnv("PRISMA_CONNECTIVITY_MAX_RETRIES", 2, 0, 10);
  const baseDelayMs =
    options?.baseDelayMs ??
    getBoundedIntEnv("PRISMA_CONNECTIVITY_BASE_DELAY_MS", 500, 50, 30_000);
  const maxDelayMs =
    options?.maxDelayMs ??
    getBoundedIntEnv("PRISMA_CONNECTIVITY_MAX_DELAY_MS", 3_000, 50, 60_000);
  const operationName = options?.operationName ?? "prisma-operation";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      if (!isRetryablePrismaConnectionError(error) || attempt === maxRetries) {
        throw error;
      }

      const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      console.warn(
        `[Prisma Retry] action=retry operation=${operationName} attempt=${attempt + 1}/${maxRetries} waitMs=${delayMs} message=${error?.message ?? String(error)}`
      );
      await sleep(delayMs);
    }
  }

  throw new Error(
    `[Prisma Retry] Unreachable retry state for operation=${operationName}`
  );
}
