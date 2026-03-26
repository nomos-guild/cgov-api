/**
 * Voter Power Sync Cron Job
 * Periodically syncs DRep and SPO voting power from Koios API
 * Updates voting power based on the latest epoch data
 */

import { prisma } from "../services";
import { syncCommitteeState } from "../services/committeeState.service";
import { syncAllVoterVotingPower } from "../services/ingestion/voterPowerSync.service";
import { startIngestionCronJob } from "./runIngestionCronJob";

const JOB_NAME = "voter-power-sync";

/**
 * Starts the voter power sync cron job
 * Schedule is configurable via VOTER_POWER_SYNC_SCHEDULE env variable
 * Defaults to once daily at 00:08 UTC
 */
export const startVoterPowerSyncJob = () =>
  startIngestionCronJob({
    jobName: JOB_NAME,
    displayName: "Voter Power Sync",
    scheduleEnvKey: "VOTER_POWER_SYNC_SCHEDULE",
    defaultSchedule: "8 0 * * *",
    skipKoiosPressure: true,
    useKoiosHeavyLane: true,
    run: async () => {
      const timestamp = new Date().toISOString();
      const results = await syncAllVoterVotingPower(prisma);

      console.log(
        `[${timestamp}] Voter power sync completed for epoch ${results.epoch}: drepUpdated=${results.dreps.updated}/${results.dreps.total} spoUpdated=${results.spos.updated}/${results.spos.total}`
      );

      if (results.dreps.errors.length > 0) {
        console.error(
          `[${timestamp}] DRep sync errors:`,
          results.dreps.errors.slice(0, 10)
        );
      }
      if (results.spos.errors.length > 0) {
        console.error(
          `[${timestamp}] SPO sync errors:`,
          results.spos.errors.slice(0, 10)
        );
      }

      try {
        const ccStateResult = await syncCommitteeState(prisma);
        console.log(
          `[${timestamp}] Committee state sync completed for epoch ${ccStateResult.epoch}: eligible=${ccStateResult.eligibleMembers}/${ccStateResult.totalMembers}`
        );
      } catch (ccError: any) {
        console.error(
          `[${timestamp}] Committee state sync failed:`,
          ccError?.message ?? String(ccError)
        );
      }

      return { itemsProcessed: results.dreps.updated + results.spos.updated };
    },
  });
