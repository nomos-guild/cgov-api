import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetTimeToEnactmentResponse,
  ProposalTimeToEnactment,
} from "../../responses/analytics.response";

/**
 * Calculates percentile from sorted array
 */
function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

/**
 * GET /analytics/time-to-enactment
 * Returns time-to-enactment metrics per proposal
 *
 * Query params:
 * - page: Page number (optional; if omitted and pageSize omitted, returns all results)
 * - pageSize: Items per page (optional; if omitted and page omitted, returns all results; max: 100 when paginating)
 * - status: Filter by proposal status (optional, comma-separated)
 * - governanceActionType: Filter by action type (optional, comma-separated)
 * - enactedOnly: If "true", only return enacted proposals (default: false)
 */
export const getTimeToEnactment = async (req: Request, res: Response) => {
  try {
    const pageParam = req.query.page as string | undefined;
    const pageSizeParam = req.query.pageSize as string | undefined;
    const wantsPagination = pageParam !== undefined || pageSizeParam !== undefined;
    const page = wantsPagination
      ? Math.max(1, parseInt(pageParam ?? "1") || 1)
      : 1;
    const pageSize = wantsPagination
      ? Math.min(100, Math.max(1, parseInt(pageSizeParam ?? "20") || 20))
      : null;
    const statusFilter = (req.query.status as string)?.split(",").filter(Boolean);
    const typeFilter = (req.query.governanceActionType as string)
      ?.split(",")
      .filter(Boolean);
    const enactedOnly = req.query.enactedOnly === "true";

    // Build where clause
    const whereClause: any = {};
    if (statusFilter && statusFilter.length > 0) {
      whereClause.status = { in: statusFilter };
    }
    if (typeFilter && typeFilter.length > 0) {
      whereClause.governanceActionType = { in: typeFilter };
    }
    if (enactedOnly) {
      whereClause.enactedEpoch = { not: null };
    }

    // Get proposals
    const totalItems = await prisma.proposal.count({ where: whereClause });

    const dbProposals = await prisma.proposal.findMany({
      where: whereClause,
      orderBy: { submissionEpoch: "desc" },
      ...(wantsPagination && pageSize !== null
        ? { skip: (page - 1) * pageSize, take: pageSize }
        : {}),
      select: {
        proposalId: true,
        title: true,
        governanceActionType: true,
        status: true,
        submissionEpoch: true,
        ratifiedEpoch: true,
        enactedEpoch: true,
      },
    });

    // Get epoch timestamps for wall-clock calculations
    const allEpochs = new Set<number>();
    for (const p of dbProposals) {
      if (p.submissionEpoch !== null) allEpochs.add(p.submissionEpoch);
      if (p.enactedEpoch !== null) allEpochs.add(p.enactedEpoch);
    }

    const epochTimestamps = await prisma.epochTotals.findMany({
      where: { epoch: { in: Array.from(allEpochs) } },
      select: { epoch: true, startTime: true, endTime: true },
    });

    // Create epoch -> timestamp map (use midpoint of epoch)
    const epochTimeMap = new Map<number, Date>();
    for (const et of epochTimestamps) {
      if (et.startTime && et.endTime) {
        const midpoint = new Date(
          (et.startTime.getTime() + et.endTime.getTime()) / 2
        );
        epochTimeMap.set(et.epoch, midpoint);
      } else if (et.startTime) {
        epochTimeMap.set(et.epoch, et.startTime);
      }
    }

    // Calculate time-to-enactment for each proposal
    const proposals: ProposalTimeToEnactment[] = dbProposals.map((p) => {
      const submissionToRatifiedEpochs =
        p.submissionEpoch !== null && p.ratifiedEpoch !== null
          ? p.ratifiedEpoch - p.submissionEpoch
          : null;

      const submissionToEnactedEpochs =
        p.submissionEpoch !== null && p.enactedEpoch !== null
          ? p.enactedEpoch - p.submissionEpoch
          : null;

      // Wall-clock calculation
      let submissionToEnactedDays: number | null = null;
      if (p.submissionEpoch !== null && p.enactedEpoch !== null) {
        const submissionTime = epochTimeMap.get(p.submissionEpoch);
        const enactedTime = epochTimeMap.get(p.enactedEpoch);
        if (submissionTime && enactedTime) {
          const diffMs = enactedTime.getTime() - submissionTime.getTime();
          submissionToEnactedDays = Math.round((diffMs / (1000 * 60 * 60 * 24)) * 10) / 10;
        }
      }

      return {
        proposalId: p.proposalId,
        title: p.title,
        governanceActionType: p.governanceActionType,
        status: p.status,
        submissionEpoch: p.submissionEpoch,
        ratifiedEpoch: p.ratifiedEpoch,
        enactedEpoch: p.enactedEpoch,
        submissionToRatifiedEpochs,
        submissionToEnactedEpochs,
        submissionToEnactedDays,
      };
    });

    // Calculate stats from all enacted proposals (not just current page)
    const allEnacted = await prisma.proposal.findMany({
      where: {
        ...whereClause,
        enactedEpoch: { not: null },
        submissionEpoch: { not: null },
      },
      select: {
        submissionEpoch: true,
        enactedEpoch: true,
      },
    });

    const epochDeltas = allEnacted
      .map((p) => (p.enactedEpoch ?? 0) - (p.submissionEpoch ?? 0))
      .sort((a, b) => a - b);

    // Get timestamps for all enacted proposals
    const allEnactedEpochs = new Set<number>();
    for (const p of allEnacted) {
      if (p.submissionEpoch !== null) allEnactedEpochs.add(p.submissionEpoch);
      if (p.enactedEpoch !== null) allEnactedEpochs.add(p.enactedEpoch);
    }

    const allEpochTimestamps = await prisma.epochTotals.findMany({
      where: { epoch: { in: Array.from(allEnactedEpochs) } },
      select: { epoch: true, startTime: true, endTime: true },
    });

    const allEpochTimeMap = new Map<number, Date>();
    for (const et of allEpochTimestamps) {
      if (et.startTime && et.endTime) {
        const midpoint = new Date(
          (et.startTime.getTime() + et.endTime.getTime()) / 2
        );
        allEpochTimeMap.set(et.epoch, midpoint);
      } else if (et.startTime) {
        allEpochTimeMap.set(et.epoch, et.startTime);
      }
    }

    const dayDeltas = allEnacted
      .map((p) => {
        const submissionTime = allEpochTimeMap.get(p.submissionEpoch!);
        const enactedTime = allEpochTimeMap.get(p.enactedEpoch!);
        if (submissionTime && enactedTime) {
          const diffMs = enactedTime.getTime() - submissionTime.getTime();
          return diffMs / (1000 * 60 * 60 * 24);
        }
        return null;
      })
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b);

    const response: GetTimeToEnactmentResponse = {
      proposals,
      stats: {
        medianEpochsToEnactment: percentile(epochDeltas, 50),
        p90EpochsToEnactment: percentile(epochDeltas, 90),
        medianDaysToEnactment:
          percentile(dayDeltas, 50) !== null
            ? Math.round(percentile(dayDeltas, 50)! * 10) / 10
            : null,
        p90DaysToEnactment:
          percentile(dayDeltas, 90) !== null
            ? Math.round(percentile(dayDeltas, 90)! * 10) / 10
            : null,
      },
      pagination: {
        page,
        pageSize: pageSize ?? totalItems,
        totalItems,
        totalPages:
          pageSize === null
            ? totalItems === 0
              ? 0
              : 1
            : Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching time to enactment", error);
    res.status(500).json({
      error: "Failed to fetch time to enactment",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
