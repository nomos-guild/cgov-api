import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

const createPrismaClient = () =>
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["error"],
  });

export const prisma = globalThis.prismaGlobal ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.prismaGlobal = prisma;
}

interface DbPressureState {
  active: boolean;
  remainingMs: number;
  observedErrors: number;
  threshold: number;
  windowMs: number;
  writeInFlight: number;
  writeQueueDepth: number;
  semaphoreSaturated: number;
}

const dbResilienceEnabled = process.env.DB_RESILIENCE_ENABLED !== "false";
const dbRetryMaxAttempts = boundedInt("DB_RETRY_MAX_ATTEMPTS", 3, 1, 8);
const dbRetryBaseDelayMs = boundedInt("DB_RETRY_BASE_DELAY_MS", 300, 50, 30_000);
const dbRetryMaxDelayMs = boundedInt("DB_RETRY_MAX_DELAY_MS", 5_000, 100, 60_000);
const dbCircuitThreshold = boundedInt("DB_CIRCUIT_THRESHOLD", 8, 1, 200);
const dbCircuitWindowMs = boundedInt("DB_CIRCUIT_WINDOW_MS", 30_000, 1_000, 300_000);
const dbCircuitCooldownMs = boundedInt("DB_CIRCUIT_COOLDOWN_MS", 20_000, 1_000, 300_000);
const dbWriteSemaphoreEnabled =
  process.env.DB_WRITE_SEMAPHORE_ENABLED !== "false";
const dbWriteMaxInFlight = boundedInt("DB_WRITE_MAX_IN_FLIGHT", 8, 1, 64);
const dbWriteQueueMaxDepth = boundedInt("DB_WRITE_QUEUE_MAX_DEPTH", 500, 10, 10_000);
const dbRetryJitterMs = boundedInt("DB_RETRY_JITTER_MS", 200, 0, 5_000);

let dbCircuitOpenUntil = 0;
let dbFailureTimestamps: number[] = [];

const writeSemaphore = createSemaphore(dbWriteMaxInFlight, dbWriteQueueMaxDepth);

function boundedInt(
  envKey: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const raw = process.env[envKey];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return defaultValue;
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSemaphore(limit: number, maxQueueDepth: number) {
  let active = 0;
  let saturatedCount = 0;
  const queue: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return;
    }
    saturatedCount += 1;
    if (queue.length >= maxQueueDepth) {
      throw new Error(
        `[DB Write Semaphore] queue-overflow depth=${queue.length} max=${maxQueueDepth}`
      );
    }
    await new Promise<void>((resolve) => {
      queue.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const release = () => {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) next();
  };

  const stats = () => ({
    active,
    queueDepth: queue.length,
    saturatedCount,
  });

  return { acquire, release, stats };
}

function isDbTransientError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? "";
  if (code === "P1001" || code === "P1002" || code === "P1017" || code === "P2024") {
    return true;
  }
  const message =
    (error as { message?: string })?.message?.toLowerCase() ?? "";
  return (
    message.includes("can't reach database server") ||
    message.includes("connection") ||
    message.includes("timed out") ||
    message.includes("too many connections") ||
    message.includes("connection pool") ||
    message.includes("terminating connection")
  );
}

function pruneFailures(nowMs: number): void {
  dbFailureTimestamps = dbFailureTimestamps.filter((ts) => nowMs - ts <= dbCircuitWindowMs);
}

function recordDbFailure(nowMs: number): void {
  dbFailureTimestamps.push(nowMs);
  pruneFailures(nowMs);
  if (dbFailureTimestamps.length >= dbCircuitThreshold) {
    dbCircuitOpenUntil = nowMs + dbCircuitCooldownMs;
    console.warn(
      `[DB Pressure] action=degraded reason=error-burst windowMs=${dbCircuitWindowMs} threshold=${dbCircuitThreshold} cooldownMs=${dbCircuitCooldownMs} observed=${dbFailureTimestamps.length}`
    );
  }
}

function getDbRetryDelayMs(attempt: number): number {
  const backoff = Math.min(
    dbRetryBaseDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
    dbRetryMaxDelayMs
  );
  const jitter = dbRetryJitterMs > 0 ? Math.floor(Math.random() * dbRetryJitterMs) : 0;
  return backoff + jitter;
}

export function getDbPressureState(): DbPressureState {
  const now = Date.now();
  pruneFailures(now);
  const semStats = writeSemaphore.stats();
  return {
    active: dbCircuitOpenUntil > now,
    remainingMs: Math.max(0, dbCircuitOpenUntil - now),
    observedErrors: dbFailureTimestamps.length,
    threshold: dbCircuitThreshold,
    windowMs: dbCircuitWindowMs,
    writeInFlight: semStats.active,
    writeQueueDepth: semStats.queueDepth,
    semaphoreSaturated: semStats.saturatedCount,
  };
}

async function executeWithDbResilience<T>(
  operation: string,
  write: boolean,
  fn: () => Promise<T>
): Promise<T> {
  if (!dbResilienceEnabled) {
    return fn();
  }

  const now = Date.now();
  if (dbCircuitOpenUntil > now) {
    const remainingMs = dbCircuitOpenUntil - now;
    throw new Error(
      `[DB Circuit Open] operation=${operation} remainingMs=${remainingMs}`
    );
  }

  const needsSemaphore = write && dbWriteSemaphoreEnabled;
  if (needsSemaphore) {
    await writeSemaphore.acquire();
  }

  try {
    for (let attempt = 1; attempt <= dbRetryMaxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        const transient = isDbTransientError(error);
        if (!transient || attempt >= dbRetryMaxAttempts) {
          if (transient) {
            recordDbFailure(Date.now());
          }
          throw error;
        }
        const delayMs = getDbRetryDelayMs(attempt);
        console.warn(
          `[DB Retry] operation=${operation} attempt=${attempt}/${dbRetryMaxAttempts} delayMs=${delayMs}`
        );
        await sleep(delayMs);
      }
    }
    return fn();
  } finally {
    if (needsSemaphore) {
      writeSemaphore.release();
    }
  }
}

export async function withDbRead<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  return executeWithDbResilience(operation, false, fn);
}

export async function withDbWrite<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  return executeWithDbResilience(operation, true, fn);
}
