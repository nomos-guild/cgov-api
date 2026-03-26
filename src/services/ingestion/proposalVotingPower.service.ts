import { prisma } from "../prisma";
import { getKoiosPressureState } from "../koios";
import {
  getAllPoolVotingPowerHistoryForEpoch,
  getDrepEpochSummary,
  getProposalVotingSummary,
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
  skipped?: boolean;
  skippedReason?: string;
  partial?: boolean;
  partialReasons?: string[];
}

export interface ProposalVotingPowerRunCache {
  spoTotalByEpoch: Map<number, bigint>;
  spoTotalInFlight: Map<number, Promise<AggregatePowerFetchResult>>;
}

export function createProposalVotingPowerRunCache(): ProposalVotingPowerRunCache {
  return {
    spoTotalByEpoch: new Map<number, bigint>(),
    spoTotalInFlight: new Map<number, Promise<AggregatePowerFetchResult>>(),
  };
}

function lovelaceToBigInt(lovelace: string | null | undefined): bigint | null {
  if (!lovelace) return null;
  return BigInt(lovelace);
}

async function fetchProposalVotingSummary(
  proposalId: string
): Promise<Awaited<ReturnType<typeof getProposalVotingSummary>>> {
  const startedAt = Date.now();
  try {
    const summary = await getProposalVotingSummary(proposalId, {
      source: "ingestion.proposal.voting-power.summary",
    });
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 2000) {
      console.log(
        `[Voting Summary] action=timing proposalId=${proposalId} durationMs=${durationMs} found=${Boolean(summary)}`
      );
    }
    return summary;
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    console.warn(
      `[Voting Summary] Failed to fetch voting summary for ${proposalId}:`,
      error.message
    );
    console.warn(
      `[Voting Summary] action=timing proposalId=${proposalId} durationMs=${durationMs} outcome=error`
    );
    return null;
  }
}

interface AggregatePowerFetchResult {
  value: bigint;
  complete: boolean;
  error?: string;
}

async function fetchDrepTotalVotingPower(
  epochNo: number
): Promise<AggregatePowerFetchResult> {
  try {
    const summary = await getDrepEpochSummary(epochNo, {
      source: "ingestion.proposal.voting-power.drep-epoch-summary",
    });
    if (summary?.amount) {
      return { value: BigInt(summary.amount), complete: true };
    }
    return { value: BigInt(0), complete: false, error: "missing-drep-summary" };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    console.warn(`[DRep Epoch Summary] Failed to fetch for epoch ${epochNo}:`, message);
    return { value: BigInt(0), complete: false, error: message };
  }
}

async function fetchSpoTotalVotingPower(
  epochNo: number,
  runCache?: ProposalVotingPowerRunCache
): Promise<AggregatePowerFetchResult> {
  const fromCache = runCache?.spoTotalByEpoch.get(epochNo);
  if (fromCache !== undefined) {
    return { value: fromCache, complete: true };
  }
  const inFlight = runCache?.spoTotalInFlight.get(epochNo);
  if (inFlight) {
    return await inFlight;
  }

  const loadPromise = (async () => {
  try {
    const pools = await getAllPoolVotingPowerHistoryForEpoch({
      epochNo,
      source: "ingestion.proposal.voting-power.pool-history",
    });

    let totalLovelace = BigInt(0);
    let poolCount = 0;
    for (const pool of pools) {
      if (pool.amount) {
        totalLovelace += BigInt(pool.amount);
        poolCount++;
      }
    }

    console.log(
      `[SPO Total Voting Power] Summed ${poolCount} pools for epoch ${epochNo}`
    );

    runCache?.spoTotalByEpoch.set(epochNo, totalLovelace);
    return { value: totalLovelace, complete: true };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    console.warn(
      `[SPO Total Voting Power] Failed to fetch for epoch ${epochNo}:`,
      message
    );
    return { value: BigInt(0), complete: false, error: message };
  }
  })();

  if (runCache) {
    runCache.spoTotalInFlight.set(epochNo, loadPromise);
  }

  try {
    return await loadPromise;
  } finally {
    runCache?.spoTotalInFlight.delete(epochNo);
  }
}

export async function updateProposalVotingPower(
  proposalId: string,
  drepTotalPowerEpoch: number,
  spoTotalPowerEpoch: number,
  inactivePowerEpoch: number,
  isActiveProposal: boolean,
  inactivePowerRunCache?: Map<string, bigint>,
  inactivePowerMetrics?: InactivePowerMetrics,
  votingPowerRunCache?: ProposalVotingPowerRunCache
): Promise<VotingPowerUpdateResult> {
  try {
    if (
      process.env.KOIOS_SKIP_EXPENSIVE_ENRICHMENTS_WHEN_DEGRADED !== "false"
    ) {
      const pressure = getKoiosPressureState();
      if (pressure.active) {
        console.warn(
          `[Voting Power] Skipping update for ${proposalId} due to Koios degraded state (remainingMs=${pressure.remainingMs})`
        );
        return {
          success: true,
          summaryFound: false,
          skipped: true,
          skippedReason: "koios-degraded",
        };
      }
    }

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

    const [drepTotalVotePowerResult, spoTotalVotePowerResult, drepInactiveVotePower] =
      await Promise.all([
        fetchDrepTotalVotingPower(drepTotalPowerEpoch),
        fetchSpoTotalVotingPower(spoTotalPowerEpoch, votingPowerRunCache),
        shouldCalculateInactive
          ? getInactivePowerWithCache(
              inactivePowerEpoch,
              isActiveProposal,
              inactivePowerRunCache,
              inactivePowerMetrics
            )
          : Promise.resolve(BigInt(0)),
      ]);
    const partialReasons: string[] = [];
    if (!drepTotalVotePowerResult.complete) {
      partialReasons.push(
        `drep-total-unavailable(epoch=${drepTotalPowerEpoch})${drepTotalVotePowerResult.error ? `:${drepTotalVotePowerResult.error}` : ""}`
      );
    }
    if (!spoTotalVotePowerResult.complete) {
      partialReasons.push(
        `spo-total-unavailable(epoch=${spoTotalPowerEpoch})${spoTotalVotePowerResult.error ? `:${spoTotalVotePowerResult.error}` : ""}`
      );
    }
    if (partialReasons.length > 0) {
      console.warn(
        `[Voting Power] action=partial proposalId=${proposalId} reasons=${partialReasons.join(",")}`
      );
      return {
        success: false,
        summaryFound: true,
        partial: true,
        partialReasons,
        error: partialReasons.join("; "),
      };
    }

    if (!shouldCalculateInactive) {
      console.log(
        `[Voting Power] Skipping inactive DRep calculation for epoch ${inactivePowerEpoch} (before epoch ${DREP_INACTIVITY_START_EPOCH})`
      );
    }

    await prisma.proposal.update({
      where: { proposalId },
      data: {
        drepTotalVotePower: drepTotalVotePowerResult.value,
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
        spoTotalVotePower: spoTotalVotePowerResult.value,
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
