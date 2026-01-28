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
  syncGovernanceAnalyticsForPreviousEpoch,
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
      const result = await syncGovernanceAnalyticsForPreviousEpoch(prisma);

      console.log(
        `[${timestamp}] Epoch analytics sync result (currentEpoch=${result.currentEpoch}, targetEpoch=${result.epoch}):`
      );

      if (result.dreps) {
        console.log(
          `  DReps: koios=${result.dreps.koiosTotal}, existing=${result.dreps.existingInDb}, created=${result.dreps.created}, updatedFromInfo=${result.dreps.updatedFromInfo}, failedInfoBatches=${result.dreps.failedInfoBatches}`
        );
      } else {
        console.log(`  DReps: skipped=${result.skipped.dreps}`);
      }

      if (result.drepInfo) {
        console.log(
          `  DRep Info: total=${result.drepInfo.totalDreps}, updated=${result.drepInfo.updated}, failedBatches=${result.drepInfo.failedBatches}`
        );
      } else {
        console.log(`  DRep Info: skipped=${result.skipped.drepInfo}`);
      }

      // Log totals + timestamps sync results
      if (result.totals) {
        console.log(
          `  Totals: upserted=${result.totals.upserted}, circulation=${result.totals.circulation?.toString() ?? "null"}, treasury=${result.totals.treasury?.toString() ?? "null"}, delegatedDrepPower=${result.totals.delegatedDrepPower?.toString() ?? "null"}, totalPoolVotePower=${result.totals.totalPoolVotePower?.toString() ?? "null"}`
        );
        console.log(
          `  Epoch Timestamps: startTime=${result.totals.startTime?.toISOString() ?? "null"}, endTime=${result.totals.endTime?.toISOString() ?? "null"}, blocks=${result.totals.blockCount ?? "null"}, txs=${result.totals.txCount ?? "null"}`
        );
      } else {
        console.log(`  Totals: skipped=${result.skipped.totals}`);
      }

      // Log DRep lifecycle sync results
      if (result.drepLifecycle) {
        console.log(
          `  DRep Lifecycle: dreps=${result.drepLifecycle.drepsProcessed}, events=${result.drepLifecycle.eventsIngested} (reg=${result.drepLifecycle.eventsByType.registration}, dereg=${result.drepLifecycle.eventsByType.deregistration}, update=${result.drepLifecycle.eventsByType.update}), failed=${result.drepLifecycle.failed.length}`
        );
      } else {
        console.log(`  DRep Lifecycle: skipped=${result.skipped.drepLifecycle}`);
      }

      // Log pool groups sync results
      if (result.poolGroups) {
        console.log(
          `  Pool Groups: fetched=${result.poolGroups.totalFetched}, created=${result.poolGroups.created}, updated=${result.poolGroups.updated}, uniqueGroups=${result.poolGroups.uniqueGroups}`
        );
      } else {
        console.log(`  Pool Groups: skipped=${result.skipped.poolGroups}`);
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

