import { getKoiosPressureState } from "../services/koios";
import {
  acquireJobLock,
  getBoundedIntEnv,
  releaseJobLock,
} from "../services/ingestion/syncLock";

const koiosSkipWhenDegraded =
  process.env.KOIOS_SKIP_NON_CRITICAL_JOBS_WHEN_DEGRADED !== "false";
const koiosHeavyLaneEnabled =
  process.env.KOIOS_HEAVY_JOB_LANE_ENABLED !== "false";
const koiosHeavyLaneTtlMs = getBoundedIntEnv(
  "KOIOS_HEAVY_JOB_LANE_TTL_MS",
  30 * 60 * 1000,
  30_000,
  60 * 60 * 1000
);
const koiosHeavyLaneJobName =
  process.env.KOIOS_HEAVY_JOB_LANE_NAME ?? "koios-heavy-job-lane";
const koiosHeavyLaneDisplayName =
  process.env.KOIOS_HEAVY_JOB_LANE_DISPLAY_NAME ?? "Koios Heavy Job Lane";

export function shouldSkipForKoiosPressure(jobName: string): boolean {
  if (!koiosSkipWhenDegraded) return false;

  const pressure = getKoiosPressureState();
  if (!pressure.active) return false;

  console.warn(
    `[Koios Pressure] action=skip job=${jobName} reason=degraded remainingMs=${pressure.remainingMs} observedErrors=${pressure.observedErrors}/${pressure.threshold} windowMs=${pressure.windowMs}`
  );
  return true;
}

export async function acquireKoiosHeavyJobLane(
  sourceJobName: string
): Promise<boolean> {
  if (!koiosHeavyLaneEnabled) return true;
  return acquireJobLock(koiosHeavyLaneJobName, koiosHeavyLaneDisplayName, {
    ttlMs: koiosHeavyLaneTtlMs,
    source: sourceJobName,
  });
}

export async function releaseKoiosHeavyJobLane(
  status: "success" | "failed",
  errorMessage?: string
): Promise<void> {
  if (!koiosHeavyLaneEnabled) return;
  await releaseJobLock(
    koiosHeavyLaneJobName,
    status,
    undefined,
    errorMessage
  );
}
