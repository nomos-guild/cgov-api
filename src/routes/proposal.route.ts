import express from "express";
import { placeholderGet } from "../controllers";

const router = express.Router();

/**
 * @openapi
 * /proposal/{proposal_id}:
 *   get:
 *     summary: Get proposal details by ID
 *     description: Retrieves detailed information about a specific governance proposal including description, rationale, and votes
 *     tags:
 *       - Proposal
 *     parameters:
 *       - name: proposal_id
 *         in: path
 *         required: true
 *         description: Unique identifier of the proposal
 *         schema:
 *           type: string
 *           example: "prop_123456"
 *     responses:
 *       200:
 *         description: Successfully retrieved proposal details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetProposalInfoResponse'
 *       404:
 *         description: Proposal not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/:proposal_id", placeholderGet);

export default router;
