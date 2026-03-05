import { Request, Response } from "express";
import { prisma } from "../../services";
import { DRepEngagementStat, GetDRepEngagementStatsResponse } from "../../responses";

type EngagementStatsRow = {
  drep_id: string;
  total_votes_cast: bigint | number;
  unique_proposals: bigint | number;
  rationales_provided: bigint | number;
  vote_changes: bigint | number;
  participation_percent: number | string | null;
};

function toNumber(value: bigint | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * GET /dreps/engagement-stats
 * Get aggregate DRep engagement statistics used by frontend rationale dashboards.
 */
export const getDRepEngagementStats = async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<EngagementStatsRow[]>`
      WITH eligible_proposals AS (
        SELECT
          proposal_id,
          COALESCE(expiration_epoch, submission_epoch, 0) AS effective_epoch
        FROM proposal
        WHERE
          drep_total_vote_power IS NOT NULL
          AND (
            status = 'ACTIVE'
            OR COALESCE(drep_active_yes_vote_power, 0) > 0
            OR COALESCE(drep_active_no_vote_power, 0) > 0
            OR COALESCE(drep_active_abstain_vote_power, 0) > 0
          )
      ),
      total_eligible AS (
        SELECT COUNT(*) AS total FROM eligible_proposals
      ),
      drep_reg AS (
        SELECT drep_id, MIN(epoch_no) AS registered_epoch
        FROM drep_lifecycle_event
        WHERE action = 'registration'
        GROUP BY drep_id
      ),
      drep_stats AS (
        SELECT
          v.drep_id,
          COUNT(*)::int AS total_votes_cast,
          COUNT(DISTINCT v.proposal_id)::int AS unique_proposals,
          COUNT(*) FILTER (
            WHERE v.rationale IS NOT NULL AND v.rationale != ''
          )::int AS rationales_provided
        FROM onchain_vote v
        INNER JOIN drep d ON d.drep_id = v.drep_id
        WHERE
          v.drep_id IS NOT NULL
          AND v.voter_type = 'DREP'
          AND (d.do_not_list = false OR d.do_not_list IS NULL)
        GROUP BY v.drep_id
      ),
      vote_changes AS (
        SELECT drep_id, COUNT(*)::int AS vote_changes
        FROM (
          SELECT v.drep_id, v.proposal_id
          FROM onchain_vote v
          INNER JOIN drep d ON d.drep_id = v.drep_id
          WHERE
            v.drep_id IS NOT NULL
            AND v.voter_type = 'DREP'
            AND (d.do_not_list = false OR d.do_not_list IS NULL)
          GROUP BY v.drep_id, v.proposal_id
          HAVING COUNT(DISTINCT v.vote) >= 2
        ) changed
        GROUP BY drep_id
      )
      SELECT
        ds.drep_id,
        ds.total_votes_cast,
        ds.unique_proposals,
        ds.rationales_provided,
        COALESCE(vc.vote_changes, 0)::int AS vote_changes,
        CASE
          WHEN dr.registered_epoch IS NULL THEN
            CASE WHEN (SELECT total FROM total_eligible) > 0
              THEN ROUND(ds.unique_proposals * 100.0 / (SELECT total FROM total_eligible), 2)
              ELSE 0
            END
          ELSE
            CASE WHEN (
              SELECT COUNT(*) FROM eligible_proposals ep
              WHERE ep.effective_epoch >= dr.registered_epoch
            ) > 0
              THEN ROUND(
                ds.unique_proposals * 100.0 / (
                  SELECT COUNT(*) FROM eligible_proposals ep
                  WHERE ep.effective_epoch >= dr.registered_epoch
                ), 2
              )
              ELSE 0
            END
        END AS participation_percent
      FROM drep_stats ds
      LEFT JOIN vote_changes vc ON ds.drep_id = vc.drep_id
      LEFT JOIN drep_reg dr ON ds.drep_id = dr.drep_id
      ORDER BY ds.total_votes_cast DESC;
    `;

    const dreps: DRepEngagementStat[] = rows.map((row) => ({
      drepId: row.drep_id,
      totalVotesCast: toNumber(row.total_votes_cast),
      rationalesProvided: toNumber(row.rationales_provided),
      proposalParticipationPercent: Number(row.participation_percent ?? 0) || 0,
      uniqueProposals: toNumber(row.unique_proposals),
      voteChanges: toNumber(row.vote_changes),
    }));

    const response: GetDRepEngagementStatsResponse = { dreps };

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.json(response);
  } catch (error) {
    console.error("Error fetching DRep engagement stats", error);
    return res.status(500).json({
      error: "Failed to fetch DRep engagement stats",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
