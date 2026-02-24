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
  postTriggerGithubDiscovery,
  postTriggerGithubSync,
  postTriggerGithubBackfill,
  postTriggerGithubSnapshot,
  postTriggerGithubAggregate,
} from "../controllers/data/triggerGithub";
import { developmentController } from "../controllers";
import { postTriggerDrepInventorySync } from "../controllers/data/triggerDrepInventorySync";
import { postTriggerDrepInfoSync } from "../controllers/data/triggerDrepInfoSync";
import { postTriggerEpochTotalsSync } from "../controllers/data/triggerEpochTotalsSync";
import { postTriggerDrepLifecycleSync } from "../controllers/data/triggerDrepLifecycleSync";
import { postTriggerPoolGroupsSync } from "../controllers/data/triggerPoolGroupsSync";
import { postTriggerMissingEpochsSync } from "../controllers/data/triggerMissingEpochsSync";
import { postTriggerDrepDelegatorSync } from "../controllers/data/triggerDrepDelegatorSync";

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

/**
 * @openapi
 * /data/trigger-drep-inventory-sync:
 *   post:
 *     summary: Trigger DRep inventory + epoch snapshot sync
 *     description: Inventories all DReps from Koios /drep_list and creates per-epoch snapshots. Used by Cloud Scheduler.
 *     tags:
 *       - Data Ingestion
 *     responses:
 *       200:
 *         description: Sync started
 *       409:
 *         description: Sync already running
 *       500:
 *         description: Sync failed
 */
router.post("/trigger-drep-inventory-sync", postTriggerDrepInventorySync);

/**
 * @openapi
 * /data/trigger-drep-info-sync:
 *   post:
 *     summary: Trigger full DRep info refresh
 *     description: Refreshes all DRep metadata from Koios /drep_info + /drep_updates. This is the slowest step, isolated for timeout safety. Used by Cloud Scheduler.
 *     tags:
 *       - Data Ingestion
 *     responses:
 *       200:
 *         description: Sync started
 *       409:
 *         description: Sync already running
 *       500:
 *         description: Sync failed
 */
router.post("/trigger-drep-info-sync", postTriggerDrepInfoSync);

/**
 * @openapi
 * /data/trigger-epoch-totals-sync:
 *   post:
 *     summary: Trigger epoch totals sync (previous + current)
 *     description: Syncs epoch denominators (circulation, treasury, delegated power, pool voting power) and timestamps. Previous epoch is checkpointed; current epoch always refreshes. Used by Cloud Scheduler.
 *     tags:
 *       - Data Ingestion
 *     responses:
 *       200:
 *         description: Sync started
 *       409:
 *         description: Sync already running
 *       500:
 *         description: Sync failed
 */
router.post("/trigger-epoch-totals-sync", postTriggerEpochTotalsSync);

/**
 * @openapi
 * /data/trigger-drep-lifecycle-sync:
 *   post:
 *     summary: Trigger DRep lifecycle events sync
 *     description: Syncs DRep registration, deregistration, and update events from Koios /drep_updates. Used by Cloud Scheduler.
 *     tags:
 *       - Data Ingestion
 *     responses:
 *       200:
 *         description: Sync started
 *       409:
 *         description: Sync already running
 *       500:
 *         description: Sync failed
 */
router.post("/trigger-drep-lifecycle-sync", postTriggerDrepLifecycleSync);

/**
 * @openapi
 * /data/trigger-pool-groups-sync:
 *   post:
 *     summary: Trigger pool groups sync
 *     description: Syncs multi-pool operator groupings from Koios /pool_groups. Used by Cloud Scheduler.
 *     tags:
 *       - Data Ingestion
 *     responses:
 *       200:
 *         description: Sync started
 *       409:
 *         description: Sync already running
 *       500:
 *         description: Sync failed
 */
router.post("/trigger-pool-groups-sync", postTriggerPoolGroupsSync);

/**
 * @openapi
 * /data/trigger-missing-epochs-sync:
 *   post:
 *     summary: Trigger missing epochs backfill
 *     description: Finds epochs missing from EpochTotals table and backfills them from Koios. Used by Cloud Scheduler.
 *     tags:
 *       - Data Ingestion
 *     responses:
 *       200:
 *         description: Backfill started
 *       409:
 *         description: Backfill already running
 *       500:
 *         description: Backfill failed
 */
router.post("/trigger-missing-epochs-sync", postTriggerMissingEpochsSync);

/**
 * @openapi
 * /data/trigger-drep-delegator-sync:
 *   post:
 *     summary: Manually trigger DRep delegator sync
 *     description: Triggers a sync of DRep delegation changes including stake address delegation state updates and change log entries. Used for manual testing and by Cloud Scheduler cron jobs.
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
router.post("/trigger-drep-delegator-sync", postTriggerDrepDelegatorSync);

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
router.post("/github/discover", postTriggerGithubDiscovery);

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
router.post("/github/backfill", postTriggerGithubBackfill);

/**
 * @openapi
 * /data/github/snapshot:
 *   post:
 *     summary: Manually trigger daily snapshot (stars/forks for all repos)
 *     tags: [GitHub Admin]
 *     responses:
 *       200: { description: Snapshot completed }
 */
router.post("/github/snapshot", postTriggerGithubSnapshot);

/**
 * @openapi
 * /data/github/aggregate:
 *   post:
 *     summary: Manually trigger GitHub aggregation (rollups + network graphs)
 *     tags: [GitHub Admin]
 *     responses:
 *       200: { description: Aggregation completed }
 */
router.post("/github/aggregate", postTriggerGithubAggregate);

export default router;
