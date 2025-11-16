import express from "express";
import { proposalController } from "../controllers";

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
 *         description: Proposal lookup key (tx hash or txHash:certIndex)
 *         schema:
 *           type: string
 *           example: "15f82a365bdee483a4b03873a40d3829cc88c048ff3703e11bd01dd9e035c916:0"
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
router.get("/:proposal_id", proposalController.getProposalDetails);

export default router;
