import { prisma } from "../prisma";
import {
  getDrepEpochSummary,
  getProposalVotingSummary,
  listPoolVotingPowerHistory,
} from "../governanceProvider";
import {
  DREP_INACTIVITY_START_EPOCH,
  getInactivePowerWithCache,
  type InactivePowerMetrics,
} from "./inactiveDrepPower.service";

export interface VotingPowerUpdateResult {
  success: boolean;
  error?: string;
  summaryFound: boolean;
}

function lovelaceToBigInt(lovelace: string | null | undefined): bigint | null {
  if (!lovelace) return null;
  return BigInt(lovelace);
}

async function fetchProposalVotingSummary(
  proposalId: string
): Promise<Awaited<ReturnType<typeof getProposalVotingSummary>>> {
  try {
    return await getProposalVotingSummary(proposalId, {
      source: "ingestion.proposal.voting-power.summary",
    });
  } catch (error: any) {
    console.warn(
      `[Voting Summary] Failed to fetch voting summary for ${proposalId}:`,
      error.message
    );
    return null;
  }
}

async function fetchDrepTotalVotingPower(epochNo: number): Promise<bigint> {
  try {
    const summary = await getDrepEpochSummary(epochNo, {
      source: "ingestion.proposal.voting-power.drep-epoch-summary",
    });
    if (summary?.amount) {
      return BigInt(summary.amount);
    }
    return BigInt(0);
  } catch (error: any) {
    console.warn(
      `[DRep Epoch Summary] Failed to fetch for epoch ${epochNo}:`,
      error.message
    );
    return BigInt(0);
  }
}

async function fetchSpoTotalVotingPower(epochNo: number): Promise<bigint> {
  try {
    let totalLovelace = BigInt(0);
    const pageSize = 1000;
    let offset = 0;
    let hasMore = true;
    let poolCount = 0;

    while (hasMore) {
      const poolPowers = await listPoolVotingPowerHistory({
        epochNo,
        limit: pageSize,
        offset,
        source: "ingestion.proposal.voting-power.pool-history",
      });

      if (poolPowers && poolPowers.length > 0) {
        for (const pool of poolPowers) {
          if (pool.amount) {
            totalLovelace += BigInt(pool.amount);
            poolCount++;
          }
        }
        offset += poolPowers.length;
        hasMore = poolPowers.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    console.log(
      `[SPO Total Voting Power] Summed ${poolCount} pools for epoch ${epochNo}`
    );

    return totalLovelace;
  } catch (error: any) {
    console.warn(
      `[SPO Total Voting Power] Failed to fetch for epoch ${epochNo}:`,
      error.message
    );
    return BigInt(0);
  }
}

export async function updateProposalVotingPower(
  proposalId: string,
  drepTotalPowerEpoch: number,
  spoTotalPowerEpoch: number,
  inactivePowerEpoch: number,
  isActiveProposal: boolean,
  inactivePowerRunCache?: Map<string, bigint>,
  inactivePowerMetrics?: InactivePowerMetrics
): Promise<VotingPowerUpdateResult> {
  try {
    const votingSummary = await fetchProposalVotingSummary(proposalId);

    if (!votingSummary) {
      console.log(
        `[Voting Power] No voting summary available for ${proposalId}`
      );
      return {
        success: false,
        error: "No voting summary available from Koios",
        summaryFound: false,
      };
    }

    console.log(
      `[Voting Power] Fetching voting power data - drepTotal: epoch ${drepTotalPowerEpoch}, spoTotal: epoch ${spoTotalPowerEpoch}, inactive: epoch ${inactivePowerEpoch}, isActive: ${isActiveProposal} (proposal: ${proposalId})`
    );

    const shouldCalculateInactive =
      inactivePowerEpoch >= DREP_INACTIVITY_START_EPOCH;

    const [drepTotalVotePower, spoTotalVotePower, drepInactiveVotePower] =
      await Promise.all([
        fetchDrepTotalVotingPower(drepTotalPowerEpoch),
        fetchSpoTotalVotingPower(spoTotalPowerEpoch),
        shouldCalculateInactive
          ? getInactivePowerWithCache(
              inactivePowerEpoch,
              isActiveProposal,
              inactivePowerRunCache,
              inactivePowerMetrics
            )
          : Promise.resolve(BigInt(0)),
      ]);

    if (!shouldCalculateInactive) {
      console.log(
        `[Voting Power] Skipping inactive DRep calculation for epoch ${inactivePowerEpoch} (before epoch ${DREP_INACTIVITY_START_EPOCH})`
      );
    }

    await prisma.proposal.update({
      where: { proposalId },
      data: {
        drepTotalVotePower,
        drepActiveYesVotePower: lovelaceToBigInt(
          votingSummary.drep_active_yes_vote_power
        ),
        drepActiveNoVotePower: lovelaceToBigInt(
          votingSummary.drep_active_no_vote_power
        ),
        drepActiveAbstainVotePower: lovelaceToBigInt(
          votingSummary.drep_active_abstain_vote_power
        ),
        drepAlwaysAbstainVotePower: lovelaceToBigInt(
          votingSummary.drep_always_abstain_vote_power
        ),
        drepAlwaysNoConfidencePower: lovelaceToBigInt(
          votingSummary.drep_always_no_confidence_vote_power
        ),
        drepInactiveVotePower: drepInactiveVotePower,
        spoTotalVotePower,
        spoActiveYesVotePower: lovelaceToBigInt(
          votingSummary.pool_active_yes_vote_power
        ),
        spoActiveNoVotePower: lovelaceToBigInt(
          votingSummary.pool_active_no_vote_power
        ),
        spoActiveAbstainVotePower: lovelaceToBigInt(
          votingSummary.pool_active_abstain_vote_power
        ),
        spoAlwaysAbstainVotePower: lovelaceToBigInt(
          votingSummary.pool_passive_always_abstain_vote_power
        ),
        spoAlwaysNoConfidencePower: lovelaceToBigInt(
          votingSummary.pool_passive_always_no_confidence_vote_power
        ),
        spoNoVotePower: lovelaceToBigInt(votingSummary.pool_no_vote_power),
      },
    });

    console.log(`[Voting Power] Updated voting power data for ${proposalId}`);
    return {
      success: true,
      summaryFound: true,
    };
  } catch (error: any) {
    const errorMessage = error?.message ?? String(error);
    console.warn(
      `[Voting Power] Failed to update for ${proposalId}:`,
      errorMessage
    );
    return {
      success: false,
      error: errorMessage,
      summaryFound: true,
    };
  }
}
