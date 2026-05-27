import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import {
  DRepSummary,
  GetDRepsResponse,
  toAdaString,
  toLovelaceString,
} from "../../responses";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";
import { parseIntegerQuery } from "../../utils/query-params";


/**
 * GET /dreps
 * List all DReps with pagination and sorting
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 1000)
 * - sortBy: Field to sort by (votingPower, name, totalVotes) (default: votingPower)
 * - sortOrder: Sort direction (asc, desc) (default: desc)
 * - search: Search by name or drepId (optional)
 */
export const getDReps = async (req: Request, res: Response) => {
  try {
    const pageR = parseIntegerQuery(req.query.page, "page", {
      min: 1,
      default: 1,
    });
    if (!pageR.ok) return res.status(pageR.status).json(pageR);
    const page = pageR.value;

    const pageSizeR = parseIntegerQuery(req.query.pageSize, "pageSize", {
      min: 1,
      max: 1000,
      default: 20,
    });
    if (!pageSizeR.ok) return res.status(pageSizeR.status).json(pageSizeR);
    const pageSize = pageSizeR.value;

    const sortBy = (req.query.sortBy as string) || "votingPower";
    const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";
    const search = (req.query.search as string) || "";

    // Build where clause
    const whereClause: any = {
      // Exclude DReps marked as "do not list"
      OR: [{ doNotList: false }, { doNotList: null }],
    };

    // Add search filter if provided
    if (search) {
      whereClause.AND = [
        {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { drepId: { contains: search, mode: "insensitive" } },
          ],
        },
      ];
    }

    // Get total count for pagination
    const totalItems = await prisma.drep.count({ where: whereClause });

    // Build order by clause
    let orderBy: any;
    if (sortBy === "name") {
      orderBy = { name: sortOrder };
    } else if (sortBy === "votingPower") {
      orderBy = { votingPower: sortOrder };
    } else {
      // Default to voting power
      orderBy = { votingPower: sortOrder };
    }

    // Fetch DReps with pagination
    const dreps = await prisma.drep.findMany({
      where: whereClause,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        drepId: true,
        name: true,
        iconUrl: true,
        votingPower: true,
        delegatorCount: true,
        firstSeenEpoch: true,
        proposalParticipationPercent: true,
      },
    });

    const allColumnsPopulated = dreps.every(
      (d) => d.firstSeenEpoch != null && d.proposalParticipationPercent != null
    );

    // Get vote counts. firstSeenEpoch + participation are read directly from
    // denormalised columns when populated; we only fall back to on-fly groupBy
    // if the denorm refresh hasn't run yet (fresh DB / boot before first epoch sync).
    const drepIds = dreps.map((d) => d.drepId);
    const voteCounts = await prisma.onchainVote.groupBy({
      by: ["drepId"],
      where: {
        drepId: { in: drepIds },
        voterType: VoterType.DREP,
      },
      _count: { id: true },
    });

    const voteCountMap = new Map<string, number>();
    for (const vc of voteCounts) {
      if (vc.drepId) voteCountMap.set(vc.drepId, vc._count.id);
    }

    const firstSeenEpochMap = new Map<string, number>();
    const participationMap = new Map<string, number>();

    if (!allColumnsPopulated) {
      // Cold-start fallback — recompute firstSeenEpoch + participation on the fly.
      console.warn(
        "[getDReps] denorm columns not yet populated for some DReps; falling back to on-fly groupBy. Run /data/snapshot/rebuild or wait for the next epoch-totals sync."
      );
      const [lifecycleRegs, drepProposalPairs, totalProposals] = await Promise.all([
        prisma.drepLifecycleEvent.groupBy({
          by: ["drepId"],
          where: { drepId: { in: drepIds }, action: "registration" },
          _min: { epochNo: true },
        }),
        prisma.onchainVote.groupBy({
          by: ["drepId", "proposalId"],
          where: {
            drepId: { in: drepIds },
            voterType: VoterType.DREP,
          },
        }),
        prisma.proposal.count(),
      ]);

      for (const row of lifecycleRegs) {
        if (row._min.epochNo != null) firstSeenEpochMap.set(row.drepId, row._min.epochNo);
      }
      const distinctProposalsMap = new Map<string, number>();
      for (const pair of drepProposalPairs) {
        if (!pair.drepId) continue;
        distinctProposalsMap.set(pair.drepId, (distinctProposalsMap.get(pair.drepId) ?? 0) + 1);
      }
      for (const id of drepIds) {
        const distinctVoted = distinctProposalsMap.get(id) ?? 0;
        participationMap.set(
          id,
          totalProposals > 0
            ? Math.round((distinctVoted / totalProposals) * 100 * 100) / 100
            : 0
        );
      }
    }

    // Map to response format
    const drepSummaries: DRepSummary[] = dreps.map((drep) => ({
      drepId: drep.drepId,
      name: drep.name,
      iconUrl: drep.iconUrl,
      votingPower: toLovelaceString(drep.votingPower),
      votingPowerAda: toAdaString(drep.votingPower),
      totalVotesCast: voteCountMap.get(drep.drepId) || 0,
      delegatorCount: drep.delegatorCount,
      firstSeenEpoch:
        drep.firstSeenEpoch ?? firstSeenEpochMap.get(drep.drepId) ?? null,
      proposalParticipationPercent:
        drep.proposalParticipationPercent ?? participationMap.get(drep.drepId) ?? 0,
    }));

    // If sorting by totalVotes, we need to sort in memory after getting counts
    if (sortBy === "totalVotes") {
      drepSummaries.sort((a, b) => {
        const diff = a.totalVotesCast - b.totalVotesCast;
        return sortOrder === "asc" ? diff : -diff;
      });
    }

    const response: GetDRepsResponse = {
      dreps: drepSummaries,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching DReps list", formatAxiosLikeError(error));
    res.status(500).json({
      error: "Failed to fetch DReps",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
