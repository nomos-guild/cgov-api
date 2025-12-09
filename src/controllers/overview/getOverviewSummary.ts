import { Request, Response } from "express";
import { ProposalStatus } from "@prisma/client";
import { prisma } from "../../services";
import { GetNCLDataResponse } from "../../responses";

type StatusCountMap = Partial<Record<ProposalStatus, number>>;

export const getOverviewSummary = async (_req: Request, res: Response) => {
  try {
    const currentYear = new Date().getUTCFullYear();

    const [totalProposals, grouped, nclData] = await Promise.all([
      prisma.proposal.count(),
      prisma.proposal.groupBy({
        by: ["status"],
        _count: { status: true },
      }),
      prisma.nCL.findUnique({
        where: { year: currentYear },
      }),
    ]);

    const counts = grouped.reduce<StatusCountMap>((acc, item) => {
      acc[item.status] = item._count.status;
      return acc;
    }, {});

    const currentlyRatified = counts[ProposalStatus.RATIFIED] ?? 0;
    const enacted = counts[ProposalStatus.ENACTED] ?? 0;

    const summary = {
      totalProposals,
      activeProposals: counts[ProposalStatus.ACTIVE] ?? 0,
      // Ratified = currently ratified + enacted (since enacted proposals were ratified first)
      ratifiedProposals: currentlyRatified + enacted,
      enactedProposals: enacted,
      expiredProposals: counts[ProposalStatus.EXPIRED] ?? 0,
      closedProposals: counts[ProposalStatus.CLOSED] ?? 0,
    };

    const response: GetNCLDataResponse = {
      year: currentYear,
      // NCL data: currentValue is treasury withdrawals so far, targetValue is the limit
      // Values are stored in lovelace (BigInt), convert to string for API response
      currentValue: (nclData?.current ?? BigInt(0)).toString(),
      targetValue: (nclData?.limit ?? BigInt(0)).toString(),
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
