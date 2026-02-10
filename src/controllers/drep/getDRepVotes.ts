import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import { GetDRepVotesResponse, DRepVoteRecord } from "../../responses";

/**
 * Extracts rationale text from vote metadata JSON
 * The rationale can be nested in various structures depending on the CIP-100 format
 */
function extractRationaleText(rationale: string | null): string | null {
  if (!rationale) return null;

  try {
    const parsed = JSON.parse(rationale);

    // Check common paths for rationale text
    // CIP-100 format: { body: { comment: "..." } }
    if (parsed?.body?.comment) {
      return parsed.body.comment;
    }

    // Alternative: { comment: "..." }
    if (parsed?.comment) {
      return parsed.comment;
    }

    // Alternative: { rationale: "..." }
    if (parsed?.rationale) {
      return parsed.rationale;
    }

    // If it's just a string, return as-is
    if (typeof parsed === "string") {
      return parsed;
    }

    // Return stringified version if no known format matched
    return rationale;
  } catch {
    // If not valid JSON, return as-is
    return rationale;
  }
}

/**
 * GET /drep/:drepId/votes
 * Get paginated voting history for a specific DRep
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - sortOrder: Sort by votedAt (asc, desc) (default: desc - newest first)
 */
export const getDRepVotes = async (req: Request, res: Response) => {
  try {
    const drepId = req.params.drepId as string;

    if (!drepId) {
      return res.status(400).json({
        error: "Missing drepId",
        message: "A drepId path parameter is required",
      });
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";

    // Check if DRep exists
    const drep = await prisma.drep.findUnique({
      where: { drepId },
      select: { drepId: true },
    });

    if (!drep) {
      return res.status(404).json({
        error: "DRep not found",
        message: `No DRep found with id ${drepId}`,
      });
    }

    // Get total count for pagination
    const totalItems = await prisma.onchainVote.count({
      where: {
        drepId,
        voterType: VoterType.DREP,
      },
    });

    // Fetch votes with proposal details
    const votes = await prisma.onchainVote.findMany({
      where: {
        drepId,
        voterType: VoterType.DREP,
      },
      orderBy: { votedAt: sortOrder },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        txHash: true,
        proposalId: true,
        vote: true,
        votingPower: true,
        rationale: true,
        anchorUrl: true,
        votedAt: true,
        proposal: {
          select: {
            title: true,
            governanceActionType: true,
          },
        },
      },
    });

    // Map to response format
    const voteRecords: DRepVoteRecord[] = votes.map((v) => ({
      proposalId: v.proposalId,
      proposalTitle: v.proposal.title,
      proposalType: v.proposal.governanceActionType,
      vote: v.vote?.toString() || "UNKNOWN",
      votingPower: v.votingPower?.toString() || null,
      rationale: extractRationaleText(v.rationale),
      anchorUrl: v.anchorUrl,
      votedAt: v.votedAt?.toISOString() || null,
      txHash: v.txHash,
    }));

    const response: GetDRepVotesResponse = {
      drepId,
      votes: voteRecords,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    return res.json(response);
  } catch (error) {
    console.error("Error fetching DRep votes", error);
    return res.status(500).json({
      error: "Failed to fetch DRep voting history",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
