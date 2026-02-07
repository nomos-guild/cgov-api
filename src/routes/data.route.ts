import express from "express";
import { dataController } from "../controllers";
import { postIngestProposal } from "../controllers/data/ingestProposal";
import { postIngestVote } from "../controllers/data/ingestVote";
import {
  postIngestDrep,
  postIngestSpo,
  postIngestCc,
} from "../controllers/data/ingestVoters";
import { postTriggerSync } from "../controllers/data/triggerSync";
import { postTriggerVoterSync } from "../controllers/data/triggerVoterSync";
import {
  postTriggerDiscovery,
  postTriggerSync as postTriggerGithubSync,
  postTriggerBackfill,
  postTriggerSnapshot,
} from "../controllers/data/triggerGithub";
import { developmentController } from "../controllers";

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

/**
 * @openapi
 * /data/trigger-sync:
 *   post:
 *     summary: Manually trigger proposal sync
 *     description: Triggers a full sync of all governance proposals from Koios API. Used for manual testing and by Cloud Scheduler cron jobs.
 *     tags:
 *       - Data Ingestion
 *     responses:
 *       200:
 *         description: Sync completed successfully
 *       409:
 *         description: Sync already running
 *       500:
 *         description: Sync failed
 */
router.post("/trigger-sync", postTriggerSync);

/**
 * @openapi
 * /data/trigger-voter-sync:
 *   post:
 *     summary: Manually trigger voter power sync
 *     description: Triggers a full sync of DRep and SPO voting power from Koios API. Used for manual testing and by Cloud Scheduler cron jobs.
 *     tags:
 *       - Data Ingestion
 *     responses:
 *       200:
 *         description: Sync completed successfully
 *       409:
 *         description: Sync already running
 *       500:
 *         description: Sync failed
 */
router.post("/trigger-voter-sync", postTriggerVoterSync);

// ─── GitHub Admin Endpoints ─────────────────────────────────────────────────

/**
 * @openapi
 * /data/github/status:
 *   get:
 *     summary: GitHub ingestion status (discovery, backfill, rate limit)
 *     tags: [GitHub Admin]
 *     responses:
 *       200: { description: Current status of GitHub data pipelines }
 */
router.get("/github/status", developmentController.getStatus);

/**
 * @openapi
 * /data/github/discover:
 *   post:
 *     summary: Manually trigger GitHub repository discovery
 *     tags: [GitHub Admin]
 *     responses:
 *       200: { description: Discovery completed }
 */
router.post("/github/discover", postTriggerDiscovery);

/**
 * @openapi
 * /data/github/sync:
 *   post:
 *     summary: Manually trigger GitHub activity sync
 *     tags: [GitHub Admin]
 *     responses:
 *       200: { description: Sync completed }
 */
router.post("/github/sync", postTriggerGithubSync);

/**
 * @openapi
 * /data/github/backfill:
 *   post:
 *     summary: Manually trigger historical backfill
 *     tags: [GitHub Admin]
 *     parameters:
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 50 }
 *       - name: minStars
 *         in: query
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200: { description: Backfill completed }
 */
router.post("/github/backfill", postTriggerBackfill);

/**
 * @openapi
 * /data/github/snapshot:
 *   post:
 *     summary: Manually trigger daily snapshot (stars/forks for all repos)
 *     tags: [GitHub Admin]
 *     responses:
 *       200: { description: Snapshot completed }
 */
router.post("/github/snapshot", postTriggerSnapshot);

export default router;
