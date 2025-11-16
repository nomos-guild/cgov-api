import express from "express";
import { dataController } from "../controllers";
import { postIngestProposal } from "../controllers/data/ingestProposal";
import { postIngestVote } from "../controllers/data/ingestVote";
import {
  postIngestDrep,
  postIngestSpo,
  postIngestCc,
} from "../controllers/data/ingestVoters";

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

/**
 * @openapi
 * /data/proposal/{proposal_hash}:
 *   post:
 *     summary: Ingest a single proposal
 *     description: Fetches proposal data from Koios API and ingests it into the database along with all associated votes
 *     tags:
 *       - Data Ingestion
 *     parameters:
 *       - name: proposal_hash
 *         in: path
 *         required: true
 *         description: Transaction hash of the proposal
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Proposal ingested successfully
 *       404:
 *         description: Proposal not found
 *       500:
 *         description: Server error
 */
router.post("/proposal/:proposal_hash", postIngestProposal);

/**
 * @openapi
 * /data/vote/{tx_hash}:
 *   post:
 *     summary: Ingest a single vote
 *     description: Fetches vote data from Koios API and ingests it into the database
 *     tags:
 *       - Data Ingestion
 *     parameters:
 *       - name: tx_hash
 *         in: path
 *         required: true
 *         description: Transaction hash of the vote
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Vote ingested successfully
 *       500:
 *         description: Server error
 */
router.post("/vote/:tx_hash", postIngestVote);

/**
 * @openapi
 * /data/drep/{drep_id}:
 *   post:
 *     summary: Ingest a single DRep
 *     description: Fetches DRep data from Koios API and ingests it into the database
 *     tags:
 *       - Data Ingestion
 *     parameters:
 *       - name: drep_id
 *         in: path
 *         required: true
 *         description: DRep identifier
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: DRep ingested successfully
 *       500:
 *         description: Server error
 */
router.post("/drep/:drep_id", postIngestDrep);

/**
 * @openapi
 * /data/spo/{pool_id}:
 *   post:
 *     summary: Ingest a single SPO
 *     description: Fetches SPO (Stake Pool Operator) data from Koios API and ingests it into the database
 *     tags:
 *       - Data Ingestion
 *     parameters:
 *       - name: pool_id
 *         in: path
 *         required: true
 *         description: Pool identifier (Bech32)
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: SPO ingested successfully
 *       500:
 *         description: Server error
 */
router.post("/spo/:pool_id", postIngestSpo);

/**
 * @openapi
 * /data/cc/{cc_id}:
 *   post:
 *     summary: Ingest a single Constitutional Committee member
 *     description: Ingests CC member data into the database
 *     tags:
 *       - Data Ingestion
 *     parameters:
 *       - name: cc_id
 *         in: path
 *         required: true
 *         description: CC member identifier
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: CC member ingested successfully
 *       500:
 *         description: Server error
 */
router.post("/cc/:cc_id", postIngestCc);

export default router;
