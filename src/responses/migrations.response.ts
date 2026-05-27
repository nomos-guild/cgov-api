/**
 * Migration response types — per-epoch DRep migrations aggregated from
 * the StakeDelegationChange changelog.
 *
 * Convention: this endpoint is consumed primarily by off-line pipelines that
 * need exact totals, so lovelace is serialised as `LovelaceString` (precision
 * preserving) and ADA as `AdaString` (6dp string). See ./lovelace.ts.
 */

import type { LovelaceString, AdaString } from "./lovelace";

export interface MigrationRow {
  /** Delegation switch epoch (delegated_epoch_no) */
  epoch: number;
  /** Source DRep bech32 id; empty/sentinel rows are excluded by default */
  fromDrepId: string;
  /** Target DRep bech32 id */
  toDrepId: string;
  /** Lovelace moved — sum of amount_at_switch (or current-proxy fallback). */
  lovelace: LovelaceString;
  /** Lovelace converted to ADA, rounded to 6 dp. */
  ada: AdaString;
  /** Distinct stake addresses moved between (fromDrepId, toDrepId) in this epoch */
  delegators: number;
}

export interface GetMigrationsResponse {
  migrations: MigrationRow[];
  meta: {
    epochStart: number;
    epochEnd: number;
    /** Aggregated row count returned in this page */
    rowCount: number;
    /**
     * Pagination state. `total` is the count of rows matching the filter
     * BEFORE limit/offset, so callers can compute total pages.
     */
    pagination: {
      limit: number;
      offset: number;
      total: number;
      hasMore: boolean;
    };
    /**
     * Provenance of `lovelace`:
     *  - "koios-history": ≥99% of changelog rows have `amount_at_switch` from Koios /account_history.
     *  - "mixed":         partial — some rows historical, some fall back to current-state proxy.
     *  - "current":       fallback path — current StakeDelegationState.amount used everywhere.
     */
    accuracy: "koios-history" | "mixed" | "current";
    /** Distribution counts feeding the accuracy classification */
    sourceDistribution: {
      total: number;
      koiosHistory: number;
      currentProxy: number;
      unknown: number;
      /**
       * Rows whose Koios /account_history value couldn't be validated as a
       * non-negative integer. Excluded from automatic retries to avoid pinning
       * the queue head; an operator can clear the tag and re-run the backfill
       * once the upstream source is fixed.
       */
      malformed: number;
    };
    /** Most recent computedAt for any row in [epochStart, epochEnd], if any */
    lastComputedAt: string | null;
  };
}
