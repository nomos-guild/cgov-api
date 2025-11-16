import { Request, Response } from "express";
import { ProposalStatus } from "@prisma/client";
import { prisma } from "../../services";
import { GetNCLDataResponse } from "../../responses";

type StatusCountMap = Partial<Record<ProposalStatus, number>>;

export const getOverviewSummary = async (_req: Request, res: Response) => {
  try {
    const [totalProposals, grouped] = await Promise.all([
      prisma.proposal.count(),
      prisma.proposal.groupBy({
        by: ["status"],
        _count: { status: true },
      }),
    ]);

    const counts = grouped.reduce<StatusCountMap>((acc, item) => {
      acc[item.status] = item._count.status;
      return acc;
    }, {});

    const summary = {
      totalProposals,
      activeProposals: counts[ProposalStatus.ACTIVE] ?? 0,
      ratifiedProposals: counts[ProposalStatus.RATIFIED] ?? 0,
      expiredProposals: counts[ProposalStatus.EXPIRED] ?? 0,
      approvedProposals: counts[ProposalStatus.APPROVED] ?? 0,
      notApprovedProposals: counts[ProposalStatus.NOT_APPROVED] ?? 0,
    };

    const response: GetNCLDataResponse = {
      year: new Date().getUTCFullYear(),
      currentValue: summary.activeProposals,
      targetValue: summary.totalProposals,
      ...summary,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching overview summary", error);
    res.status(500).json({
      error: "Failed to fetch overview data",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
