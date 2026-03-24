import { getDbPressureState } from "../services/prisma";

const skipWhenDegraded = process.env.DB_SKIP_NON_CRITICAL_JOBS_WHEN_DEGRADED !== "false";
const queueSkipThreshold = Number.parseInt(
  process.env.DB_WRITE_QUEUE_SKIP_THRESHOLD ?? "100",
  10
);

export function shouldSkipForDbPressure(jobName: string): boolean {
  if (!skipWhenDegraded) {
    return false;
  }

  const pressure = getDbPressureState();
  if (pressure.active) {
    console.warn(
      `[DB Pressure] action=skip job=${jobName} reason=circuit-open remainingMs=${pressure.remainingMs} observedErrors=${pressure.observedErrors}/${pressure.threshold}`
    );
    return true;
  }

  if (pressure.writeQueueDepth >= queueSkipThreshold) {
    console.warn(
      `[DB Pressure] action=skip job=${jobName} reason=queue-depth queueDepth=${pressure.writeQueueDepth} threshold=${queueSkipThreshold} inFlight=${pressure.writeInFlight}`
    );
    return true;
  }

  return false;
}
