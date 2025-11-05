import express from "express";
import { dataController } from "../controllers";

const router = express.Router();

/**
 * @openapi
 * /data/proposals:
 *   get:
 *     summary: Get Cardano governance proposals
 *     description: Fetches governance action proposals from Blockfrost API. Default behavior fetches ALL proposals across all pages automatically. Specify the 'page' parameter to fetch only that specific page.
 *     tags:
 *       - Governance
 *     parameters:
 *       - name: count
 *         in: query
 *         description: Number of results per page (max 100)
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 100
 *       - name: page
 *         in: query
 *         description: Page number (if omitted, fetches all pages automatically)
 *         schema:
 *           type: integer
 *           minimum: 1
 *       - name: order
 *         in: query
 *         description: Sort order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: asc
 *     responses:
 *       200:
 *         description: List of governance proposals
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Proposal'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/proposals", dataController.getProposals);

export default router;
