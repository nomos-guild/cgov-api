import { Router } from "express";
import * as healthzController from "../controllers/healthz";

const router = Router();

/**
 * @openapi
 * /healthz:
 *   get:
 *     summary: Liveness + snapshot boot readiness probe
 *     description: |
 *       Returns 200 with `status: "ok"`/`"starting"`/`"skipped"` while the API
 *       is healthy. Returns 503 with `status: "degraded"` when snapshot boot
 *       recovery has failed and `/snapshot/*` may be empty or stale. Public,
 *       unauthenticated; safe for Cloud Run / K8s readiness probes.
 *     responses:
 *       200: { description: API is up; snapshot boot recovery progressed normally. }
 *       503: { description: API is up but snapshot is degraded. }
 */
router.get("/", healthzController.getHealthz);

export default router;
