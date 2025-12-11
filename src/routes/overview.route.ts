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

/**
 * @openapi
 * /overview/ncl:
 *   get:
 *     summary: Get NCL data for all years
 *     description: Retrieves Net Change Limit data for all available years
 *     tags:
 *       - Overview
 *     responses:
 *       200:
 *         description: Successfully retrieved NCL data
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/NCLYearData'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/ncl", overviewController.getNCLData);

/**
 * @openapi
 * /overview/ncl/{year}:
 *   get:
 *     summary: Get NCL data for a specific year
 *     description: Retrieves Net Change Limit data for the specified year
 *     tags:
 *       - Overview
 *     parameters:
 *       - in: path
 *         name: year
 *         required: true
 *         schema:
 *           type: integer
 *         description: The calendar year (e.g., 2025)
 *     responses:
 *       200:
 *         description: Successfully retrieved NCL data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NCLYearData'
 *       400:
 *         description: Invalid year parameter
 *       404:
 *         description: NCL data not found for the specified year
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/ncl/:year", overviewController.getNCLDataByYear);

export default router;
