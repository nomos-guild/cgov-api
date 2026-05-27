import { Request, Response } from "express";
import { getSnapshotBootRecoveryStatus } from "../../services/ingestion/snapshot-builder.service";

/**
 * GET /healthz — liveness + snapshot boot readiness signal.
 *
 * Public, unauthenticated. Designed for cloud-deploy readiness probes.
 *
 * Status field:
 *   - "ok"          — process is up, snapshot boot recovery completed (or was
 *                     a no-op because L2 was already fresh).
 *   - "starting"    — boot recover is still running or hasn't started yet.
 *   - "skipped"     — boot recover skipped (no epoch data, or another replica
 *                     is rebuilding). The API will still serve requests but
 *                     the snapshot may be stale until a successful sync.
 *   - "degraded"    — boot recover failed. The API is up but `/snapshot/*` may
 *                     be empty or stale. Probes should mark NOT READY so the
 *                     load balancer drains traffic.
 *
 * The HTTP status mirrors the readiness signal: 200 for ok/starting/skipped,
 * 503 for degraded. Liveness check (process responsive) always returns 200
 * when this controller runs at all.
 */
export const getHealthz = (_req: Request, res: Response) => {
  const boot = getSnapshotBootRecoveryStatus();

  let status: "ok" | "starting" | "skipped" | "degraded";
  switch (boot.state) {
    case "ok":
    case "fresh":
      status = "ok";
      break;
    case "running":
    case "not-started":
      status = "starting";
      break;
    case "skipped":
      status = "skipped";
      break;
    case "failed":
      status = "degraded";
      break;
  }

  const httpStatus = status === "degraded" ? 503 : 200;

  res.status(httpStatus).json({
    status,
    snapshotBootRecovery: boot,
    serverTime: new Date().toISOString(),
  });
};
