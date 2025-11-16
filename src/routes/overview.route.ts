import express from "express";
import { overviewController } from "../controllers";

const router = express.Router();

/**
 * @openapi
 * /overview:
 *   get:
 *     summary: Get NCL data overview
 *     description: Retrieves NCL (Net Carbon Liability) data including year, current value, and target value
 *     tags:
 *       - Overview
 *     responses:
 *       200:
 *         description: Successfully retrieved NCL data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetNCLDataResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/", overviewController.getOverviewSummary);

/**
 * @openapi
 * /overview/proposals:
 *   get:
 *     summary: Get governance proposals list
 *     description: Retrieves a list of governance action proposals
 *     tags:
 *       - Overview
 *     responses:
 *       200:
 *         description: Successfully retrieved proposals list
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetProposalListReponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/proposals", overviewController.getOverviewProposals);

export default router;
