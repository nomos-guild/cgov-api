/**
 * Governance Analytics Epoch Sync Cron Job
 *
 * Runs frequently, but only does heavy work once per epoch by using the
 * EpochAnalyticsSync checkpoint table.
 *
 * Responsibilities:
 * - Inventory ALL DReps (Koios /drep_list) into DB (not just those who voted)
 * - At the start of each new epoch, sync the previous epoch's:
 *   - epoch totals / denominators (Koios /totals, /drep_epoch_summary, /pool_voting_power_history)
 *   - (optional) DRep delegator snapshots (Koios /drep_delegators)
 */

import cron from "node-cron";
import { prisma } from "../services";
import { syncGovernanceAnalyticsForPreviousEpoch } from "../services/ingestion/epoch-analytics.service";

// Simple in-process guard to prevent overlapping runs in a single Node process
let isEpochAnalyticsSyncRunning = false;

/**
 * Starts the governance analytics epoch sync job.
 *
 * Schedule is configurable via EPOCH_ANALYTICS_SYNC_SCHEDULE env variable.
 * Defaults to every hour at minute 10.
 */
export const startEpochAnalyticsSyncJob = () => {
  const schedule = process.env.EPOCH_ANALYTICS_SYNC_SCHEDULE || "10 * * * *";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log(
      "[Cron] Epoch analytics sync job disabled via ENABLE_CRON_JOBS env variable"
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule: ${schedule}. Using default: 10 * * * *`
    );
    return startEpochAnalyticsSyncJobWithSchedule("10 * * * *");
  }

  startEpochAnalyticsSyncJobWithSchedule(schedule);
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

      if (result.totals) {
        console.log(
          `  Totals: upserted=${result.totals.upserted}, circulation=${result.totals.circulation?.toString() ?? "null"}, treasury=${result.totals.treasury?.toString() ?? "null"}, delegatedDrepPower=${result.totals.delegatedDrepPower?.toString() ?? "null"}, totalPoolVotePower=${result.totals.totalPoolVotePower?.toString() ?? "null"}`
        );
      } else {
        console.log(`  Totals: skipped=${result.skipped.totals}`);
      }

      if (result.delegators) {
        console.log(
          `  Delegators: drepsProcessed=${result.delegators.drepsProcessed}, rowsInserted=${result.delegators.rowsInserted}, failed=${result.delegators.failed.length}`
        );
        if (result.delegators.failed.length > 0) {
          console.error(
            `  Delegators: first failures:`,
            result.delegators.failed.slice(0, 10)
          );
        }
      } else {
        console.log(`  Delegators: skipped=${result.skipped.delegators}`);
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

