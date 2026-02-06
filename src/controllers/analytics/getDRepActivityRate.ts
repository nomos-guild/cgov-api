import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import {
  GetDRepActivityRateResponse,
  DRepActivitySummary,
} from "../../responses/analytics.response";

/**
 * GET /analytics/drep-activity-rate
 * Returns DRep activity rate (unique proposals voted / proposals in scope)
 * Also returns totalVotesCast (raw vote rows) as additional info.
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - epochStart: Filter proposals by submission epoch >= epochStart
 * - epochEnd: Filter proposals by submission epoch <= epochEnd
 * - status: Filter proposals by status (comma-separated, default: all)
 * - activeOnly: If true, only return active DReps (default: true; pass false to include inactive)
 * - sortBy: Sort by "activityRate" | "proposalsVoted" | "name" (default: activityRate)
 * - sortOrder: Sort direction (asc, desc) (default: desc)
 */
export const getDRepActivityRate = async (req: Request, res: Response) => {
  try {
    const hasQueryParams = Object.keys(req.query).length > 0;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    // If no query params are passed, return all active DReps (no pagination cap).
    const pageSize = hasQueryParams
      ? Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20))
      : Number.MAX_SAFE_INTEGER;
    const epochStart = req.query.epochStart
      ? parseInt(req.query.epochStart as string)
      : null;
    const epochEnd = req.query.epochEnd
      ? parseInt(req.query.epochEnd as string)
      : null;
    const statusFilter = (req.query.status as string)?.split(",").filter(Boolean);
    const activeOnly = req.query.activeOnly !== "false";
    const sortBy = (req.query.sortBy as string) || "activityRate";
    const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";

    // Build proposal filter
    const proposalWhere: any = {};
    if (epochStart !== null) {
      proposalWhere.submissionEpoch = { ...proposalWhere.submissionEpoch, gte: epochStart };
    }
    if (epochEnd !== null) {
      proposalWhere.submissionEpoch = { ...proposalWhere.submissionEpoch, lte: epochEnd };
    }
    if (statusFilter && statusFilter.length > 0) {
      proposalWhere.status = { in: statusFilter };
    }

    // Total proposals in scope (regardless of registration epoch)
    const totalProposalsInScopeAll = await prisma.proposal.count({
      where: proposalWhere,
    });

    // Get proposal IDs in scope (and submission epoch for registration-based filtering)
    const proposalsInScope = await prisma.proposal.findMany({
      where: proposalWhere,
      select: { proposalId: true, submissionEpoch: true },
    });
    const proposalIds = proposalsInScope.map((p) => p.proposalId);
    const proposalEpochMap = new Map<string, number | null>(
      proposalsInScope.map((p) => [p.proposalId, p.submissionEpoch])
    );

    // Pre-compute proposal counts by epoch for fast per-DRep denominators.
    // We exclude proposals with null submissionEpoch since they can't be compared to a registration epoch.
    const proposalsByEpoch = await prisma.proposal.groupBy({
      by: ["submissionEpoch"],
      where: {
        ...proposalWhere,
        submissionEpoch: { not: null },
      },
      _count: { _all: true },
    });

    const epochCounts = proposalsByEpoch
      .filter((p) => p.submissionEpoch !== null)
      .map((p) => ({ epoch: p.submissionEpoch as number, count: p._count._all }))
      .sort((a, b) => a.epoch - b.epoch);

    const epochsAsc = epochCounts.map((e) => e.epoch);
    const suffixCounts = new Array<number>(epochCounts.length);
    let running = 0;
    for (let i = epochCounts.length - 1; i >= 0; i--) {
      running += epochCounts[i].count;
      suffixCounts[i] = running;
    }
    const countProposalsFromEpoch = (startEpochInclusive: number) => {
      if (epochsAsc.length === 0) return 0;
      let lo = 0;
      let hi = epochsAsc.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (epochsAsc[mid] < startEpochInclusive) lo = mid + 1;
        else hi = mid;
      }
      return lo >= suffixCounts.length ? 0 : suffixCounts[lo];
    };

    // Get DReps (not marked as do-not-list); optionally filter to active only.
    const dreps = await prisma.drep.findMany({
      where: {
        OR: [{ doNotList: false }, { doNotList: null }],
        ...(activeOnly ? { active: true } : {}),
      },
      select: { drepId: true, name: true },
    });

    // Registration epoch per DRep (earliest "registration" lifecycle event)
    const drepIds = dreps.map((d) => d.drepId);
    const registrationEpochs = await prisma.drepLifecycleEvent.groupBy({
      by: ["drepId"],
      where: {
        action: "registration",
        drepId: { in: drepIds },
      },
      _min: { epochNo: true },
    });
    const registrationEpochMap = new Map<string, number>();
    for (const r of registrationEpochs) {
      if (r._min.epochNo !== null && r._min.epochNo !== undefined) {
        registrationEpochMap.set(r.drepId, r._min.epochNo);
      }
    }

    // Count votes per DRep for proposals in scope.
    // We treat "proposalsVoted" as the number of UNIQUE proposals a DRep voted on,
    // and keep "totalVotesCast" as the raw number of vote rows (e.g. includes re-votes).
    const voteGroups = await prisma.onchainVote.groupBy({
      by: ["drepId", "proposalId"],
      where: {
        voterType: VoterType.DREP,
        drepId: { not: null },
        proposalId: { in: proposalIds },
      },
      _count: { _all: true },
    });

    // Create map of drepId -> { uniqueProposalsVoted, totalVotesCast }.
    // We only count votes for proposals submitted at/after the DRep's registration epoch.
    // If registration epoch is known, we also exclude proposals with null submissionEpoch
    // to keep numerator aligned with the since-registration denominator.
    const voteMetricsMap = new Map<
      string,
      { uniqueProposalsVoted: number; totalVotesCast: number }
    >();
    for (const vg of voteGroups) {
      if (!vg.drepId) continue;
      const registrationEpoch = registrationEpochMap.get(vg.drepId);
      const proposalEpoch = proposalEpochMap.get(vg.proposalId) ?? null;
      if (
        registrationEpoch !== undefined &&
        (proposalEpoch === null || proposalEpoch < registrationEpoch)
      ) {
        continue;
      }
      const existing = voteMetricsMap.get(vg.drepId) || {
        uniqueProposalsVoted: 0,
        totalVotesCast: 0,
      };
      existing.uniqueProposalsVoted += 1;
      existing.totalVotesCast += vg._count._all;
      voteMetricsMap.set(vg.drepId, existing);
    }

    // Build activity summaries
    let drepSummaries: DRepActivitySummary[] = dreps.map((drep) => {
      const metrics = voteMetricsMap.get(drep.drepId);
      const proposalsVoted = metrics?.uniqueProposalsVoted || 0;
      const totalVotesCast = metrics?.totalVotesCast || 0;
      const registrationEpoch = registrationEpochMap.get(drep.drepId);
      const totalProposalsSinceRegistration =
        registrationEpoch !== undefined
          ? countProposalsFromEpoch(registrationEpoch)
          : totalProposalsInScopeAll;
      const totalProposals = totalProposalsInScopeAll;
      return {
        drepId: drep.drepId,
        name: drep.name,
        registrationEpoch: registrationEpoch ?? null,
        proposalsVoted,
        totalVotesCast,
        totalProposals,
        totalProposalsSinceRegistration,
        activityRatePct:
          totalProposalsSinceRegistration > 0
            ? Math.round((proposalsVoted / totalProposalsSinceRegistration) * 10000) / 100
            : 0,
        activityRateAllTimePct:
          totalProposals > 0
            ? Math.round((proposalsVoted / totalProposals) * 10000) / 100
            : 0,
      };
    });

    // Sort
    drepSummaries.sort((a, b) => {
      let diff: number;
      if (sortBy === "name") {
        diff = (a.name || "").localeCompare(b.name || "");
      } else if (sortBy === "proposalsVoted") {
        diff = a.proposalsVoted - b.proposalsVoted;
      } else {
        diff = a.activityRatePct - b.activityRatePct;
      }
      return sortOrder === "asc" ? diff : -diff;
    });

    // Calculate aggregate activity rate
    const totalUniqueVotes = drepSummaries.reduce(
      (acc, d) => acc + d.proposalsVoted,
      0
    );
    const totalProposalDenominatorsSinceRegistration = drepSummaries.reduce(
      (acc, d) => acc + d.totalProposalsSinceRegistration,
      0
    );
    const aggregateActivityRatePct =
      totalProposalDenominatorsSinceRegistration > 0
        ? Math.round(
            (totalUniqueVotes / totalProposalDenominatorsSinceRegistration) * 10000
          ) / 100
        : 0;

    const totalProposalDenominatorsAllTime = drepSummaries.reduce(
      (acc, d) => acc + d.totalProposals,
      0
    );
    const aggregateActivityRateAllTimePct =
      totalProposalDenominatorsAllTime > 0
        ? Math.round((totalUniqueVotes / totalProposalDenominatorsAllTime) * 10000) /
          100
        : 0;

    // Paginate
    const totalItems = drepSummaries.length;
    const paginatedDreps = drepSummaries.slice(
      (page - 1) * pageSize,
      page * pageSize
    );

    const response: GetDRepActivityRateResponse = {
      dreps: paginatedDreps,
      aggregateActivityRatePct,
      aggregateActivityRateAllTimePct,
      filter: {
        epochStart,
        epochEnd,
        statuses: statusFilter || [],
        activeOnly,
      },
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching DRep activity rate", error);
    res.status(500).json({
      error: "Failed to fetch DRep activity rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
