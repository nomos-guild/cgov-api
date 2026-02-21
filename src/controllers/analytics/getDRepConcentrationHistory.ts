import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  DRepConcentrationHistoryPoint,
  GetDRepConcentrationHistoryResponse,
} from "../../responses/analytics.response";

type RawConcentrationRow = {
  epoch_no: number;
  top10_vp_pct: unknown;
  top20_vp_pct: unknown;
  top50_vp_pct: unknown;
  top10_del_pct: unknown;
  top20_del_pct: unknown;
  top50_del_pct: unknown;
  top10_vp_abs: unknown;
  top20_vp_abs: unknown;
  top50_vp_abs: unknown;
  top10_del_abs: unknown;
  top20_del_abs: unknown;
  top50_del_abs: unknown;
};

const CONCENTRATION_SQL = `
WITH ranked AS (
  SELECT
    epoch_no,
    voting_power,
    delegator_count,
    ROW_NUMBER() OVER (PARTITION BY epoch_no ORDER BY voting_power DESC) AS vp_rank,
    ROW_NUMBER() OVER (PARTITION BY epoch_no ORDER BY delegator_count DESC) AS del_rank
  FROM drep_epoch_snapshot
),
totals AS (
  SELECT
    epoch_no,
    SUM(voting_power) AS total_vp,
    SUM(delegator_count) AS total_delegators
  FROM drep_epoch_snapshot
  GROUP BY epoch_no
),
concentration AS (
  SELECT
    r.epoch_no,
    SUM(CASE WHEN r.vp_rank <= 10 THEN r.voting_power ELSE 0 END) AS top10_vp,
    SUM(CASE WHEN r.vp_rank <= 20 THEN r.voting_power ELSE 0 END) AS top20_vp,
    SUM(CASE WHEN r.vp_rank <= 50 THEN r.voting_power ELSE 0 END) AS top50_vp,
    SUM(CASE WHEN r.del_rank <= 10 THEN r.delegator_count ELSE 0 END) AS top10_del,
    SUM(CASE WHEN r.del_rank <= 20 THEN r.delegator_count ELSE 0 END) AS top20_del,
    SUM(CASE WHEN r.del_rank <= 50 THEN r.delegator_count ELSE 0 END) AS top50_del
  FROM ranked r
  GROUP BY r.epoch_no
)
SELECT
  c.epoch_no,
  ROUND(100.0 * c.top10_vp / NULLIF(t.total_vp, 0), 2) AS top10_vp_pct,
  ROUND(100.0 * c.top20_vp / NULLIF(t.total_vp, 0), 2) AS top20_vp_pct,
  ROUND(100.0 * c.top50_vp / NULLIF(t.total_vp, 0), 2) AS top50_vp_pct,
  ROUND(100.0 * c.top10_del / NULLIF(t.total_delegators, 0), 2) AS top10_del_pct,
  ROUND(100.0 * c.top20_del / NULLIF(t.total_delegators, 0), 2) AS top20_del_pct,
  ROUND(100.0 * c.top50_del / NULLIF(t.total_delegators, 0), 2) AS top50_del_pct,
  c.top10_vp AS top10_vp_abs,
  c.top20_vp AS top20_vp_abs,
  c.top50_vp AS top50_vp_abs,
  c.top10_del AS top10_del_abs,
  c.top20_del AS top20_del_abs,
  c.top50_del AS top50_del_abs
FROM concentration c
JOIN totals t ON c.epoch_no = t.epoch_no
ORDER BY c.epoch_no;
`;

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * GET /analytics/drep-concentration-history
 * Returns DRep voting-power/delegator concentration over time.
 */
export const getDRepConcentrationHistory = async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRawUnsafe<RawConcentrationRow[]>(CONCENTRATION_SQL);

    const history: DRepConcentrationHistoryPoint[] = rows.map((row) => ({
      epoch: row.epoch_no,
      top10VpPct: asNumber(row.top10_vp_pct),
      top20VpPct: asNumber(row.top20_vp_pct),
      top50VpPct: asNumber(row.top50_vp_pct),
      top10DelPct: asNumber(row.top10_del_pct),
      top20DelPct: asNumber(row.top20_del_pct),
      top50DelPct: asNumber(row.top50_del_pct),
      top10VpAda: asNumber(row.top10_vp_abs) / 1_000_000,
      top20VpAda: asNumber(row.top20_vp_abs) / 1_000_000,
      top50VpAda: asNumber(row.top50_vp_abs) / 1_000_000,
      top10Del: asNumber(row.top10_del_abs),
      top20Del: asNumber(row.top20_del_abs),
      top50Del: asNumber(row.top50_del_abs),
    }));

    const response: GetDRepConcentrationHistoryResponse = {
      history,
    };

    res.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.json(response);
  } catch (error) {
    console.error("Error fetching DRep concentration history", error);
    res.status(500).json({
      error: "Failed to fetch DRep concentration history",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
