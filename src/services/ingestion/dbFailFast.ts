import { getDbPressureState } from "../prisma";

const dbFailFastEnabled = process.env.INGESTION_DB_FAILFAST_ENABLED !== "false";
const dbFailFastCooldownMs = (() => {
  const parsed = Number.parseInt(
    process.env.INGESTION_DB_FAILFAST_COOLDOWN_MS ?? "60000",
    10
  );
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 600000) {
    return 60_000;
  }
  return parsed;
})();

let dbFailFastUntilMs = 0;

export function isDbConnectivityError(error: unknown): boolean {
  const code = String((error as { code?: string })?.code ?? "").toUpperCase();
  if (code === "P1001" || code === "P1002" || code === "P1017" || code === "P2024") {
    return true;
  }

  const message = String((error as { message?: string })?.message ?? "").toLowerCase();
  return (
    message.includes("can't reach database server") ||
    message.includes("database server is running") ||
    message.includes("connection") ||
    message.includes("timed out") ||
    message.includes("too many connections") ||
    message.includes("connection pool") ||
    message.includes("db circuit open")
  );
}

export function shouldFailFastForDb(scope: string): boolean {
  if (!dbFailFastEnabled) return false;

  const now = Date.now();
  const pressure = getDbPressureState();
  if (pressure.active) {
    dbFailFastUntilMs = Math.max(dbFailFastUntilMs, now + pressure.remainingMs);
  }
  if (dbFailFastUntilMs > now) {
    console.warn(
      `[DB FailFast] action=skip scope=${scope} remainingMs=${dbFailFastUntilMs - now}`
    );
    return true;
  }
  return false;
}

export function recordDbFailureForFailFast(error: unknown, scope: string): void {
  if (!dbFailFastEnabled || !isDbConnectivityError(error)) {
    return;
  }
  dbFailFastUntilMs = Math.max(dbFailFastUntilMs, Date.now() + dbFailFastCooldownMs);
  console.warn(
    `[DB FailFast] action=activate scope=${scope} cooldownMs=${dbFailFastCooldownMs} message=${String((error as { message?: string })?.message ?? error)}`
  );
}
