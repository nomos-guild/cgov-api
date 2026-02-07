import express from "express";
import { developmentController } from "../controllers";

const router = express.Router();

/**
 * @openapi
 * /development/overview:
 *   get:
 *     summary: Development activity overview KPIs
 *     tags: [Development Activity]
 *     parameters:
 *       - name: compare
 *         in: query
 *         schema: { type: string, enum: [previous] }
 *     responses:
 *       200: { description: KPI stats with optional previous period comparison }
 */
router.get("/overview", developmentController.getOverview);

/**
 * @openapi
 * /development/activity:
 *   get:
 *     summary: Activity time-series (commits, PRs, issues)
 *     tags: [Development Activity]
 *     parameters:
 *       - name: range
 *         in: query
 *         schema: { type: string, enum: [7d, 30d, 90d, 1y, 5y], default: 30d }
 *       - name: compare
 *         in: query
 *         schema: { type: string, enum: [previous] }
 *     responses:
 *       200: { description: Time-series data points }
 */
router.get("/activity", developmentController.getActivity);

/**
 * @openapi
 * /development/repos:
 *   get:
 *     summary: Top repositories by activity
 *     tags: [Development Activity]
 *     parameters:
 *       - name: sort
 *         in: query
 *         schema: { type: string, enum: [commits, stars, recent, trending], default: recent }
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 50, maximum: 200 }
 *     responses:
 *       200: { description: List of repos with activity counts }
 */
router.get("/repos", developmentController.getRepos);

/**
 * @openapi
 * /development/contributors:
 *   get:
 *     summary: Top contributors
 *     tags: [Development Activity]
 *     parameters:
 *       - name: range
 *         in: query
 *         schema: { type: string, enum: [30d, 90d, 1y], default: 90d }
 *     responses:
 *       200: { description: List of contributors with stats }
 */
router.get("/contributors", developmentController.getContributors);

/**
 * @openapi
 * /development/health:
 *   get:
 *     summary: Ecosystem health metrics
 *     tags: [Development Activity]
 *     parameters:
 *       - name: range
 *         in: query
 *         schema: { type: string, enum: [30d, 90d, 1y], default: 90d }
 *     responses:
 *       200: { description: Health rates and metrics }
 */
router.get("/health", developmentController.getHealth);

/**
 * @openapi
 * /development/stars:
 *   get:
 *     summary: Star and fork trends over time
 *     tags: [Development Activity]
 *     parameters:
 *       - name: range
 *         in: query
 *         schema: { type: string, enum: [30d, 90d, 1y, 5y], default: 90d }
 *     responses:
 *       200: { description: Time-series of star/fork totals }
 */
router.get("/stars", developmentController.getStars);

/**
 * @openapi
 * /development/languages:
 *   get:
 *     summary: Language distribution across ecosystem
 *     tags: [Development Activity]
 *     responses:
 *       200: { description: Language breakdown with counts }
 */
router.get("/languages", developmentController.getLanguages);

/**
 * @openapi
 * /development/network:
 *   get:
 *     summary: Network graph (developers, repos, orgs)
 *     tags: [Development Activity]
 *     parameters:
 *       - name: range
 *         in: query
 *         schema: { type: string, enum: [30d, 90d, 1y], default: 90d }
 *     responses:
 *       200: { description: Nodes and edges for network visualization }
 */
router.get("/network", developmentController.getNetwork);

/**
 * @openapi
 * /development/recent:
 *   get:
 *     summary: Recent activity feed
 *     tags: [Development Activity]
 *     parameters:
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 50, maximum: 200 }
 *       - name: offset
 *         in: query
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200: { description: Paginated recent events }
 */
router.get("/recent", developmentController.getRecent);

export default router;
