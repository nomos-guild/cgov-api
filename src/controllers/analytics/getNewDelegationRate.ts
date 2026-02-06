import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetNewDelegationRateResponse,
  EpochNewDelegationRate,
} from "../../responses/analytics.response";

/**
 * GET /analytics/new-delegation-rate
 * Returns new wallet delegation rate per epoch
 *
 * A "new delegator" is a stake address that first delegated in that epoch.
 *
 * Query params:
 * - epochStart: Start epoch (optional)
 * - epochEnd: End epoch (optional)
 * - limit: Max number of epochs to return (default: 50). If no query params are provided,
 *   the endpoint returns all available epoch buckets.
 */
export const getNewDelegationRate = async (req: Request, res: Response) => {
  try {
    const parseOptionalInt = (value: unknown): number | null => {
      if (value == null) return null;
      const n = parseInt(String(value), 10);
      return Number.isFinite(n) ? n : null;
    };

    const epochStartRaw = req.query.epochStart;
    const epochEndRaw = req.query.epochEnd;
    const limitRaw = req.query.limit;

    const epochStart = parseOptionalInt(epochStartRaw);
    const epochEnd = parseOptionalInt(epochEndRaw);

    const noParamsProvided =
      epochStartRaw === undefined &&
      epochEndRaw === undefined &&
      limitRaw === undefined;

    const limit = noParamsProvided
      ? null
      : Math.min(500, Math.max(1, parseOptionalInt(limitRaw) ?? 50));

    // Define a "new delegator" as a stake address whose FIRST-EVER delegation
    // to a *non-special* (real) DRep is observed.
    //
    // This intentionally treats special DReps as "not yet delegated to a real DRep".
    // As a result, a stake address switching from a special DRep
    // (drep_always_abstain / drep_always_no_confidence) to a real DRep is counted
    // as a new delegator *if it has no prior real-DRep delegation*.
    //
    // Data quality: the change log can contain delegated_epoch_no = -1 (unknown). In that case,
    // we can't place the event into an epoch bucket. To avoid undercounting addresses that are
    // present in StakeDelegationState but missing usable history, we fall back to
    // stake_delegation_state.delegated_epoch_no (which reflects the epoch of the CURRENT delegation).
    // This fallback is best-effort and is only used when we have no first-delegation record.

    const epochStartValue = epochStart ?? null;
    const epochEndValue = epochEnd ?? null;

    const perEpochNewCounts = await prisma.$queryRaw<
      Array<{ epoch: number; new_delegators: number }>
    >`
      WITH firsts_change AS (
        SELECT stake_address, MIN(delegated_epoch_no) AS first_epoch
        FROM stake_delegation_change
        WHERE to_drep_id != ''
          AND to_drep_id NOT IN ('drep_always_abstain', 'drep_always_no_confidence')
          AND delegated_epoch_no != -1
        GROUP BY stake_address
      ),
      firsts_state_missing AS (
        SELECT s.stake_address, s.delegated_epoch_no AS first_epoch
        FROM stake_delegation_state s
        WHERE s.drep_id IS NOT NULL
          AND s.drep_id NOT IN ('drep_always_abstain', 'drep_always_no_confidence')
          AND s.delegated_epoch_no IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM firsts_change c WHERE c.stake_address = s.stake_address
          )
      ),
      firsts AS (
        SELECT stake_address, first_epoch FROM firsts_change
        UNION ALL
        SELECT stake_address, first_epoch FROM firsts_state_missing
      )
      SELECT
        first_epoch AS epoch,
        COUNT(*)::int AS new_delegators
      FROM firsts
      WHERE (${epochStartValue}::int IS NULL OR first_epoch >= ${epochStartValue}::int)
        AND (${epochEndValue}::int IS NULL OR first_epoch <= ${epochEndValue}::int)
      GROUP BY first_epoch
      ORDER BY first_epoch ASC
    `;

    // Apply limit (most recent buckets) unless no query params were provided.
    const limited = limit == null ? perEpochNewCounts : perEpochNewCounts.slice(-limit);
    const minReturnedEpoch = limited.length > 0 ? limited[0].epoch : null;

    // Baseline: number of delegators whose first delegation happened before the returned window.
    // This makes totalDelegators reflect global cumulative totals even when epochStart/limit is used.
    const baselineRow =
      minReturnedEpoch == null
        ? null
        : await prisma.$queryRaw<Array<{ baseline: number }>>`
            WITH firsts_change AS (
              SELECT stake_address, MIN(delegated_epoch_no) AS first_epoch
              FROM stake_delegation_change
              WHERE to_drep_id != ''
                AND to_drep_id NOT IN ('drep_always_abstain', 'drep_always_no_confidence')
                AND delegated_epoch_no != -1
              GROUP BY stake_address
            ),
            firsts_state_missing AS (
              SELECT s.stake_address, s.delegated_epoch_no AS first_epoch
              FROM stake_delegation_state s
              WHERE s.drep_id IS NOT NULL
                AND s.drep_id NOT IN ('drep_always_abstain', 'drep_always_no_confidence')
                AND s.delegated_epoch_no IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM firsts_change c WHERE c.stake_address = s.stake_address
                )
            ),
            firsts AS (
              SELECT stake_address, first_epoch FROM firsts_change
              UNION ALL
              SELECT stake_address, first_epoch FROM firsts_state_missing
            )
            SELECT COUNT(*)::int AS baseline
            FROM firsts
            WHERE first_epoch < ${minReturnedEpoch}::int
          `;

    const baseline = baselineRow?.[0]?.baseline ?? 0;

    let cumulativeTotal = baseline;
    const epochs: EpochNewDelegationRate[] = limited.map((row) => {
      const newCount = row.new_delegators;
      cumulativeTotal += newCount;
      return {
        epoch: row.epoch,
        newDelegators: newCount,
        totalDelegators: cumulativeTotal,
        newDelegationRatePct:
          cumulativeTotal > 0
            ? Number(((newCount * 10000) / cumulativeTotal) / 100)
            : null,
      };
    });

    const response: GetNewDelegationRateResponse = {
      epochs,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching new delegation rate", error);
    res.status(500).json({
      error: "Failed to fetch new delegation rate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
