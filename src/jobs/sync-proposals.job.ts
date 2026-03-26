/**
 * Proposal Sync Cron Job
 * Periodically syncs all proposals from Koios API to database
 * Also updates NCL (Net Change Limit) data for treasury withdrawals
 */

import { syncAllProposals } from "../services/ingestion/proposal.service";
import { updateNCL } from "../services/ingestion/ncl.service";
import {
  releaseProposalSyncLock,
  tryAcquireProposalSyncLock,
} from "../services/ingestion/proposalSyncLock";
import { startIngestionCronJob } from "./runIngestionCronJob";

/**
 * Starts the proposal sync cron job
 * Schedule is configurable via PROPOSAL_SYNC_SCHEDULE env variable
 * Defaults to every 5 minutes
 */
export const startProposalSyncJob = () =>
  startIngestionCronJob({
    jobName: "proposal-sync",
    displayName: "Proposal Sync",
    scheduleEnvKey: "PROPOSAL_SYNC_SCHEDULE",
    defaultSchedule: "*/5 * * * *",
    applyJitter: false,
    lockAdapter: {
      acquire: () => tryAcquireProposalSyncLock("cron.proposal-sync"),
      release: async (status, options) => {
        await releaseProposalSyncLock({
          status,
          itemsProcessed: options?.itemsProcessed,
          errorMessage: options?.errorMessage,
        });
      },
    },
    run: async () => {
      const timestamp = new Date().toISOString();
      const results = await syncAllProposals();
      console.log(
        `[${timestamp}] Proposal sync completed: total=${results.total} success=${results.success} partial=${results.partial} failed=${results.failed}`
      );
      if (results.errors.length > 0) {
        console.error(
          `[${timestamp}] Errors encountered during sync:`,
          results.errors
        );
      }

      try {
        const nclResult = await updateNCL();
        console.log(
          `[${timestamp}] NCL update completed: year=${nclResult.year} epoch=${nclResult.epoch} currentAda=${nclResult.currentValue.toLocaleString()} proposals=${nclResult.proposalsIncluded}`
        );
      } catch (nclError: any) {
        console.error(
          `[${timestamp}] NCL update failed:`,
          nclError?.message ?? String(nclError)
        );
      }

      return { itemsProcessed: results.success };
    },
  });
