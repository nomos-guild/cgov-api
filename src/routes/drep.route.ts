import express from "express";
import { drepController } from "../controllers";

const router = express.Router();

/**
 * @openapi
 * /dreps:
 *   get:
 *     summary: List all DReps
 *     description: Retrieves a paginated list of DReps with their summary information including voting power and total votes cast
 *     tags:
 *       - DRep Dashboard
 *     parameters:
 *       - name: page
 *         in: query
 *         description: Page number (starts at 1)
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         description: Number of items per page (max 100)
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *       - name: sortBy
 *         in: query
 *         description: Field to sort by
 *         schema:
 *           type: string
 *           enum: [votingPower, name, totalVotes]
 *           default: votingPower
 *       - name: sortOrder
 *         in: query
 *         description: Sort direction
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *       - name: search
 *         in: query
 *         description: Search by DRep name or ID
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Successfully retrieved DReps list
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetDRepsResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/", drepController.getDReps);

/**
 * @openapi
 * /dreps/stats:
 *   get:
 *     summary: Get aggregate DRep statistics
 *     description: Retrieves aggregate statistics about all DReps including total delegated ADA, total votes cast, and active DReps count
 *     tags:
 *       - DRep Dashboard
 *     responses:
 *       200:
 *         description: Successfully retrieved DRep statistics
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetDRepStatsResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/stats", drepController.getDRepStats);

/**
 * @openapi
 * /dreps/{drepId}:
 *   get:
 *     summary: Get DRep details
 *     description: Retrieves detailed information about a specific DRep including vote breakdown and participation metrics
 *     tags:
 *       - DRep Dashboard
 *     parameters:
 *       - name: drepId
 *         in: path
 *         required: true
 *         description: The DRep identifier
 *         schema:
 *           type: string
 *           example: "drep1abc123..."
 *     responses:
 *       200:
 *         description: Successfully retrieved DRep details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetDRepDetailResponse'
 *       400:
 *         description: Missing or invalid drepId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: DRep not found
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
router.get("/:drepId", drepController.getDRepDetail);

/**
 * @openapi
 * /dreps/{drepId}/votes:
 *   get:
 *     summary: Get DRep voting history
 *     description: Retrieves paginated voting history for a specific DRep including proposal details and rationales
 *     tags:
 *       - DRep Dashboard
 *     parameters:
 *       - name: drepId
 *         in: path
 *         required: true
 *         description: The DRep identifier
 *         schema:
 *           type: string
 *           example: "drep1abc123..."
 *       - name: page
 *         in: query
 *         description: Page number (starts at 1)
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         description: Number of items per page (max 100)
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *       - name: sortOrder
 *         in: query
 *         description: Sort direction by vote date
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *     responses:
 *       200:
 *         description: Successfully retrieved DRep voting history
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GetDRepVotesResponse'
 *       400:
 *         description: Missing or invalid drepId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: DRep not found
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
router.get("/:drepId/votes", drepController.getDRepVotes);

export default router;
