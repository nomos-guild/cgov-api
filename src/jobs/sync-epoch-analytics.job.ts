/**
 * Governance Analytics Epoch Sync Cron Job
 *
 * Runs frequently, but only does heavy work once per epoch by using the
 * EpochAnalyticsSync checkpoint table.
 *
 * Responsibilities:
 * - Inventory ALL DReps (Koios /drep_list) into DB (not just those who voted)
 * - At the start of each new epoch, sync the previous epoch's:
 *   - epoch totals / denominators / timestamps (Koios /totals, /drep_epoch_summary, /epoch_info, /pool_voting_power_history)
 *   - DRep lifecycle events (registrations, deregistrations)
 *   - Pool groups (multi-pool operator mappings)
 */

import cron from "node-cron";
import { prisma } from "../services";
import {
  syncGovernanceAnalyticsForPreviousAndCurrentEpoch,
  syncMissingEpochAnalytics,
} from "../services/ingestion/epoch-analytics.service";

// Simple in-process guard to prevent overlapping runs in a single Node process
let isEpochAnalyticsSyncRunning = false;

/**
 * Starts the governance analytics epoch sync job.
 *
 * Runs every hour at minute 10.
 */
export const startEpochAnalyticsSyncJob = () => {
  startEpochAnalyticsSyncJobWithSchedule("10 * * * *");
};

function startEpochAnalyticsSyncJobWithSchedule(schedule: string) {
  cron.schedule(schedule, async () => {
    if (isEpochAnalyticsSyncRunning) {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] Epoch analytics sync job is still running from a previous trigger. Skipping this run.`
      );
      return;
    }

    isEpochAnalyticsSyncRunning = true;
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Starting epoch analytics sync job...`);

    try {
      const result = await syncGovernanceAnalyticsForPreviousAndCurrentEpoch(
        prisma
      );

      const previous = result.previousEpoch;

      console.log(
        `[${timestamp}] Epoch analytics sync result (currentEpoch=${result.currentEpoch}, previousEpoch=${previous.epoch}):`
      );

      if (previous.dreps) {
        console.log(
          `  DReps: koios=${previous.dreps.koiosTotal}, existing=${previous.dreps.existingInDb}, created=${previous.dreps.created}, updatedFromInfo=${previous.dreps.updatedFromInfo}, failedInfoBatches=${previous.dreps.failedInfoBatches}`
        );
      } else {
        console.log(`  DReps: skipped=${previous.skipped.dreps}`);
      }

      if (previous.drepInfo) {
        console.log(
          `  DRep Info: total=${previous.drepInfo.totalDreps}, updated=${previous.drepInfo.updated}, failedBatches=${previous.drepInfo.failedBatches}`
        );
      } else {
        console.log(`  DRep Info: skipped=${previous.skipped.drepInfo}`);
      }

      // Log totals + timestamps sync results
      if (previous.totals) {
        console.log(
          `  Totals (previous epoch): upserted=${previous.totals.upserted}, circulation=${previous.totals.circulation?.toString() ?? "null"}, treasury=${previous.totals.treasury?.toString() ?? "null"}, delegatedDrepPower=${previous.totals.delegatedDrepPower?.toString() ?? "null"}, totalPoolVotePower=${previous.totals.totalPoolVotePower?.toString() ?? "null"}`
        );
        console.log(
          `  Epoch Timestamps (previous epoch): startTime=${previous.totals.startTime?.toISOString() ?? "null"}, endTime=${previous.totals.endTime?.toISOString() ?? "null"}, blocks=${previous.totals.blockCount ?? "null"}, txs=${previous.totals.txCount ?? "null"}`
        );
      } else {
        console.log(`  Totals (previous epoch): skipped=${previous.skipped.totals}`);
      }

      // Current epoch totals are always refreshed every run
      const currentTotals = result.currentEpochTotals;
      console.log(
        `  Totals (current epoch=${currentTotals.epoch}): upserted=${currentTotals.upserted}, circulation=${currentTotals.circulation?.toString() ?? "null"}, treasury=${currentTotals.treasury?.toString() ?? "null"}, delegatedDrepPower=${currentTotals.delegatedDrepPower?.toString() ?? "null"}, totalPoolVotePower=${currentTotals.totalPoolVotePower?.toString() ?? "null"}`
      );
      console.log(
        `  Epoch Timestamps (current epoch): startTime=${currentTotals.startTime?.toISOString() ?? "null"}, endTime=${currentTotals.endTime?.toISOString() ?? "null"}, blocks=${currentTotals.blockCount ?? "null"}, txs=${currentTotals.txCount ?? "null"}`
      );

      // Log DRep lifecycle sync results
      if (previous.drepLifecycle) {
        console.log(
          `  DRep Lifecycle: attempted=${previous.drepLifecycle.drepsAttempted}, processed=${previous.drepLifecycle.drepsProcessed}, ` +
            `noUpdates=${previous.drepLifecycle.drepsWithNoUpdates}, updatesFetched=${previous.drepLifecycle.totalUpdatesFetched}, ` +
            `events=${previous.drepLifecycle.eventsIngested} (reg=${previous.drepLifecycle.eventsByType.registration}, ` +
            `dereg=${previous.drepLifecycle.eventsByType.deregistration}, update=${previous.drepLifecycle.eventsByType.update}), ` +
            `failed=${previous.drepLifecycle.failed.length}`
        );
        if (previous.drepLifecycle.failed.length > 0) {
          console.error(
            `  DRep Lifecycle: first failures:`,
            previous.drepLifecycle.failed.slice(0, 10)
          );
        }
      } else {
        console.log(
          `  DRep Lifecycle: skipped=${previous.skipped.drepLifecycle}`
        );
      }

      // Log pool groups sync results
      if (previous.poolGroups) {
        console.log(
          `  Pool Groups: fetched=${previous.poolGroups.totalFetched}, created=${previous.poolGroups.created}, updated=${previous.poolGroups.updated}, uniqueGroups=${previous.poolGroups.uniqueGroups}`
        );
      } else {
        console.log(`  Pool Groups: skipped=${previous.skipped.poolGroups}`);
      }

      // Backfill missing epoch totals (includes timestamps now)
      const backfill = await syncMissingEpochAnalytics(prisma);
      console.log(
        `  Missing epochs: range=${backfill.startEpoch}-${backfill.endEpoch}, missing=${backfill.totals.missing.length}, synced=${backfill.totals.synced.length}, failed=${backfill.totals.failed.length}`
      );
      if (backfill.totals.failed.length > 0) {
        console.error(
          `  Missing epochs: first failures:`,
          backfill.totals.failed.slice(0, 10)
        );
      }
    } catch (error: any) {
      console.error(
        `[${timestamp}] Epoch analytics sync job failed:`,
        error?.message ?? String(error)
      );
    } finally {
      isEpochAnalyticsSyncRunning = false;
    }
  });

  console.log(
    `[Cron] Epoch analytics sync job scheduled with cron: ${schedule}`
  );
}

