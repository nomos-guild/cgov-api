import express from "express";
import { analyticsController } from "../controllers";

const router = express.Router();

// ============================================
// Category 1 – Ada Holder Participation
// ============================================

/**
 * @openapi
 * /analytics/voting-turnout:
 *   get:
 *     summary: Get voting turnout (% ada) for DRep and SPO
 *     description: Returns voting turnout metrics per proposal with aggregate statistics
 *     tags:
 *       - Governance Analytics
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
 *       - name: status
 *         in: query
 *         description: Filter by proposal status (comma-separated)
 *         schema:
 *           type: string
 *       - name: governanceActionType
 *         in: query
 *         description: Filter by governance action type (comma-separated)
 *         schema:
 *           type: string
 *       - name: epochStart
 *         in: query
 *         description: Filter proposals by submission epoch >= epochStart
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         description: Filter proposals by submission epoch <= epochEnd
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successfully retrieved voting turnout data
 *       500:
 *         description: Server error
 */
router.get("/voting-turnout", analyticsController.getVotingTurnout);

/**
 * @openapi
 * /analytics/stake-participation:
 *   get:
 *     summary: Get active stake address participation
 *     description: Returns statistics on delegator participation based on their DRep voting activity. Counts distinct stake addresses whose DRep voted on proposals, and includes breakdown buckets (with percentages) for drep_always_abstain and drep_always_no_confidence.
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: proposalId
 *         in: query
 *         description: Filter by specific proposal
 *         schema:
 *           type: string
 *       - name: epochStart
 *         in: query
 *         description: Start epoch for filtering
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         description: End epoch for filtering
 *         schema:
 *           type: integer
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
 *     responses:
 *       200:
 *         description: Successfully retrieved stake participation data
 *       500:
 *         description: Server error
 */
router.get("/stake-participation", analyticsController.getStakeParticipation);

/**
 * @openapi
 * /analytics/delegation-rate:
 *   get:
 *     summary: Get delegation rate (% ada) per epoch (DRep + SPO)
 *     description: Returns DRep delegation rate and SPO (pool vote power) delegation rate as percentage of circulation per epoch
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: epochStart
 *         in: query
 *         description: Start epoch
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         description: End epoch
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         description: Max number of epochs to return
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: Successfully retrieved delegation rate data
 *       500:
 *         description: Server error
 */
router.get("/delegation-rate", analyticsController.getDelegationRate);

/**
 * @openapi
 * /analytics/delegation-distribution:
 *   get:
 *     summary: Get delegation distribution by wallet size
 *     description: Returns delegation distribution bucketed by wallet size bands (0-1k ADA, 1k-10k, 10k-100k, 100k-1M, 1M+). Each band includes count of stake addresses and sum of delegated amount.
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: drepId
 *         in: query
 *         description: Filter by specific DRep for per-DRep distribution
 *         schema:
 *           type: string
 *       - name: epoch
 *         in: query
 *         description: Epoch for historical snapshot (defaults to current)
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successfully retrieved delegation distribution data
 *       500:
 *         description: Server error
 */
router.get("/delegation-distribution", analyticsController.getDelegationDistribution);

/**
 * @openapi
 * /analytics/new-delegation-rate:
 *   get:
 *     summary: Get new wallet delegation rate per epoch
 *     description: Returns new delegator counts and rates per epoch
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: epochStart
 *         in: query
 *         description: Start epoch
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         description: End epoch
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         description: Max number of epochs to return
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Successfully retrieved new delegation rate data
 *       500:
 *         description: Server error
 */
router.get("/new-delegation-rate", analyticsController.getNewDelegationRate);

/**
 * @openapi
 * /analytics/inactive-ada:
 *   get:
 *     summary: Get inactive delegated ADA statistics
 *     description: Returns inactive DRep vote power per proposal and special DRep stats per epoch
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: view
 *         in: query
 *         description: Data view type
 *         schema:
 *           type: string
 *           enum: [proposals, epochs, both]
 *           default: both
 *       - name: proposalId
 *         in: query
 *         description: Filter by specific proposal
 *         schema:
 *           type: string
 *       - name: epochStart
 *         in: query
 *         description: Start epoch
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         description: End epoch
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         description: Max items to return
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Successfully retrieved inactive ADA data
 *       500:
 *         description: Server error
 */
router.get("/inactive-ada", analyticsController.getInactiveAda);

// ============================================
// Category 2 – DRep Insights & Activity
// ============================================

/**
 * @openapi
 * /analytics/gini:
 *   get:
 *     summary: Get Gini coefficient for DRep voting power distribution
 *     description: Returns Gini coefficient measuring delegation decentralization
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: activeOnly
 *         in: query
 *         description: Filter to active DReps only
 *         schema:
 *           type: boolean
 *           default: true
 *     responses:
 *       200:
 *         description: Successfully retrieved Gini coefficient
 *       500:
 *         description: Server error
 */
router.get("/gini", analyticsController.getGiniCoefficient);

/**
 * @openapi
 * /analytics/drep-activity-rate:
 *   get:
 *     summary: Get DRep activity rate
 *     description: Returns DRep activity rate (proposals voted / proposals in scope)
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: epochStart
 *         in: query
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         schema:
 *           type: integer
 *       - name: status
 *         in: query
 *         description: Filter proposals by status (comma-separated)
 *         schema:
 *           type: string
 *       - name: sortBy
 *         in: query
 *         schema:
 *           type: string
 *           enum: [activityRate, proposalsVoted, name]
 *           default: activityRate
 *       - name: sortOrder
 *         in: query
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *     responses:
 *       200:
 *         description: Successfully retrieved DRep activity rate
 *       500:
 *         description: Server error
 */
router.get("/drep-activity-rate", analyticsController.getDRepActivityRate);

/**
 * @openapi
 * /analytics/drep-rationale-rate:
 *   get:
 *     summary: Get DRep rationale rate
 *     description: Returns DRep rationale rate (votes with rationale / total votes). A vote has rationale if anchorUrl or rationale field is non-empty.
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: epochStart
 *         in: query
 *         description: Start epoch for filtering votes
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         description: End epoch for filtering votes
 *         schema:
 *           type: integer
 *       - name: proposalId
 *         in: query
 *         description: Filter by specific proposal
 *         schema:
 *           type: string
 *       - name: sortBy
 *         in: query
 *         schema:
 *           type: string
 *           enum: [rationaleRate, totalVotes, name]
 *           default: rationaleRate
 *       - name: sortOrder
 *         in: query
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *     responses:
 *       200:
 *         description: Successfully retrieved DRep rationale rate
 *       500:
 *         description: Server error
 */
router.get("/drep-rationale-rate", analyticsController.getDRepRationaleRate);

/**
 * @openapi
 * /analytics/drep-correlation:
 *   get:
 *     summary: Get DRep voting correlation
 *     description: Returns correlation analysis between DRep voting patterns
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: drepId1
 *         in: query
 *         description: First DRep ID for specific pair comparison
 *         schema:
 *           type: string
 *       - name: drepId2
 *         in: query
 *         description: Second DRep ID for specific pair comparison
 *         schema:
 *           type: string
 *       - name: topN
 *         in: query
 *         description: Number of top pairs to return
 *         schema:
 *           type: integer
 *           default: 10
 *       - name: minSharedProposals
 *         in: query
 *         description: Minimum shared proposals for inclusion
 *         schema:
 *           type: integer
 *           default: 3
 *     responses:
 *       200:
 *         description: Successfully retrieved DRep correlation data
 *       404:
 *         description: DRep not found
 *       500:
 *         description: Server error
 */
router.get("/drep-correlation", analyticsController.getDRepCorrelation);

/**
 * @openapi
 * /analytics/drep-lifecycle-rate:
 *   get:
 *     summary: Get DRep lifecycle event rates
 *     description: Returns DRep registration, deregistration, and update events per epoch
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: epochStart
 *         in: query
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Successfully retrieved DRep lifecycle data
 *       500:
 *         description: Server error
 */
router.get("/drep-lifecycle-rate", analyticsController.getDRepLifecycleRate);

// ============================================
// Category 3 – SPO Governance Participation
// ============================================

/**
 * @openapi
 * /analytics/spo-silent-stake:
 *   get:
 *     summary: Get SPO silent stake rate
 *     description: Returns SPO stake that did not vote per proposal
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *       - name: epochStart
 *         in: query
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successfully retrieved SPO silent stake data
 *       500:
 *         description: Server error
 */
router.get("/spo-silent-stake", analyticsController.getSpoSilentStake);

/**
 * @openapi
 * /analytics/spo-default-stance:
 *   get:
 *     summary: Get SPO default stance adoption
 *     description: Returns SPO always abstain and always no confidence adoption rates
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *       - name: epochStart
 *         in: query
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successfully retrieved SPO default stance data
 *       500:
 *         description: Server error
 */
router.get("/spo-default-stance", analyticsController.getSpoDefaultStance);

/**
 * @openapi
 * /analytics/entity-concentration:
 *   get:
 *     summary: Get SPO entity voting power concentration
 *     description: Returns multi-pool operator concentration metrics including Herfindahl-Hirschman Index (HHI) and top-N entity share of total voting power
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: limit
 *         in: query
 *         description: Max number of entities to return in detail list
 *         schema:
 *           type: integer
 *           default: 50
 *       - name: topN
 *         in: query
 *         description: Number of top entities for concentration share calculation
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Successfully retrieved entity concentration data
 *       500:
 *         description: Server error
 */
router.get("/entity-concentration", analyticsController.getEntityConcentration);

/**
 * @openapi
 * /analytics/vote-divergence:
 *   get:
 *     summary: Get SPO-DRep vote divergence
 *     description: Returns divergence between SPO and DRep voting patterns per proposal
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *       - name: epochStart
 *         in: query
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successfully retrieved vote divergence data
 *       500:
 *         description: Server error
 */
router.get("/vote-divergence", analyticsController.getVoteDivergence);

// ============================================
// Category 4 – Governance Action & Treasury Health
// ============================================

/**
 * @openapi
 * /analytics/action-volume:
 *   get:
 *     summary: Get governance action volume
 *     description: Returns governance action volume by epoch and type. Volume counts proposals by submissionEpoch with breakdown by governanceActionType.
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: epochStart
 *         in: query
 *         description: Start epoch for filtering
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         description: End epoch for filtering
 *         schema:
 *           type: integer
 *       - name: governanceActionType
 *         in: query
 *         description: Filter by governance action type (comma-separated)
 *         schema:
 *           type: string
 *       - name: status
 *         in: query
 *         description: Filter by proposal status (comma-separated)
 *         schema:
 *           type: string
 *       - name: limit
 *         in: query
 *         description: Max number of epochs to return
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Successfully retrieved action volume data
 *       500:
 *         description: Server error
 */
router.get("/action-volume", analyticsController.getActionVolume);

/**
 * @openapi
 * /analytics/contention-rate:
 *   get:
 *     summary: Get governance action contention rate
 *     description: Returns contention metrics for proposals (close vote splits)
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *       - name: governanceActionType
 *         in: query
 *         schema:
 *           type: string
 *       - name: epochStart
 *         in: query
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         schema:
 *           type: integer
 *       - name: contentiousOnly
 *         in: query
 *         description: Only return contentious proposals
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: Successfully retrieved contention rate data
 *       500:
 *         description: Server error
 */
router.get("/contention-rate", analyticsController.getContentionRate);

/**
 * @openapi
 * /analytics/treasury-rate:
 *   get:
 *     summary: Get treasury balance rate per epoch
 *     description: Returns treasury as percentage of circulation per epoch
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: epochStart
 *         in: query
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: Successfully retrieved treasury rate data
 *       500:
 *         description: Server error
 */
router.get("/treasury-rate", analyticsController.getTreasuryRate);

/**
 * @openapi
 * /analytics/time-to-enactment:
 *   get:
 *     summary: Get time-to-enactment metrics
 *     description: Returns time from proposal submission to enactment
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *       - name: governanceActionType
 *         in: query
 *         schema:
 *           type: string
 *       - name: enactedOnly
 *         in: query
 *         description: Only return enacted proposals
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: Successfully retrieved time-to-enactment data
 *       500:
 *         description: Server error
 */
router.get("/time-to-enactment", analyticsController.getTimeToEnactment);

/**
 * @openapi
 * /analytics/compliance-status:
 *   get:
 *     summary: Get constitutional compliance status
 *     description: Returns CC voting results and constitutional status per proposal
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Successfully retrieved compliance status data
 *       500:
 *         description: Server error
 */
router.get("/compliance-status", analyticsController.getComplianceStatus);

// ============================================
// Category 5 – Constitutional Committee Activity
// ============================================

/**
 * @openapi
 * /analytics/cc-time-to-decision:
 *   get:
 *     summary: Get CC time-to-decision
 *     description: Returns time from proposal submission to first CC vote
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Successfully retrieved CC time-to-decision data
 *       500:
 *         description: Server error
 */
router.get("/cc-time-to-decision", analyticsController.getCCTimeToDecision);

/**
 * @openapi
 * /analytics/cc-participation:
 *   get:
 *     summary: Get CC member participation rate
 *     description: Returns participation rate per CC member. Rate = (CCs who voted / eligibleMembers) * 100. Only the latest vote per CC member is counted.
 *     tags:
 *       - Governance Analytics
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
 *       - name: status
 *         in: query
 *         description: Filter proposals by status (comma-separated)
 *         schema:
 *           type: string
 *       - name: epochStart
 *         in: query
 *         description: Start epoch for filtering
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         description: End epoch for filtering
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successfully retrieved CC participation data
 *       500:
 *         description: Server error
 */
router.get("/cc-participation", analyticsController.getCCParticipation);

/**
 * @openapi
 * /analytics/cc-abstain-rate:
 *   get:
 *     summary: Get CC abstain rate
 *     description: Returns CC abstain rate per proposal. Rate = (CC votes where vote = ABSTAIN / total CC votes) * 100.
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: status
 *         in: query
 *         description: Filter proposals by status (comma-separated)
 *         schema:
 *           type: string
 *       - name: epochStart
 *         in: query
 *         description: Start epoch for filtering
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         description: End epoch for filtering
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successfully retrieved CC abstain rate data
 *       500:
 *         description: Server error
 */
router.get("/cc-abstain-rate", analyticsController.getCCAbstainRate);

/**
 * @openapi
 * /analytics/cc-agreement-rate:
 *   get:
 *     summary: Get CC vote agreement rate
 *     description: Returns CC vote agreement rate (votes matching majority) per proposal. Uses latest vote per CC member only. Denominator for Yes/No = eligibleMembers - abstainCount.
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: status
 *         in: query
 *         description: Filter proposals by status (comma-separated)
 *         schema:
 *           type: string
 *       - name: epochStart
 *         in: query
 *         description: Start epoch for filtering
 *         schema:
 *           type: integer
 *       - name: epochEnd
 *         in: query
 *         description: End epoch for filtering
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Successfully retrieved CC agreement rate data
 *       500:
 *         description: Server error
 */
router.get("/cc-agreement-rate", analyticsController.getCCAgreementRate);

// ============================================
// Category 6 – Tooling & UX
// ============================================

/**
 * @openapi
 * /analytics/info-availability:
 *   get:
 *     summary: Get governance info availability
 *     description: Returns proposal and vote information completeness metrics
 *     tags:
 *       - Governance Analytics
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: pageSize
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Successfully retrieved info availability data
 *       500:
 *         description: Server error
 */
router.get("/info-availability", analyticsController.getInfoAvailability);

export default router;
