import { prisma } from "../prisma";
import { getKoiosPressureState } from "../koios";
import {
  getAllPoolVotingPowerHistoryForEpoch,
  getDrepEpochSummary,
  getProposalVotingSummary,
  listPoolVotingPowerHistory,
} from "../governanceProvider";
import { shouldRequireCompleteEpochTotals } from "./epoch-totals.service";
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
  drepTotalByEpoch: Map<number, bigint>;
  drepTotalInFlight: Map<number, Promise<AggregatePowerFetchResult>>;
  spoTotalByEpoch: Map<number, bigint>;
  spoTotalInFlight: Map<number, Promise<AggregatePowerFetchResult>>;
  epochTotalsByEpoch: Map<
    number,
    {
      delegatedDrepPower: bigint | null;
      totalPoolVotePower: bigint | null;
    }
  >;
  epochTotalsInFlight: Map<
    number,
    Promise<{
      delegatedDrepPower: bigint | null;
      totalPoolVotePower: bigint | null;
    }>
  >;
}

export function createProposalVotingPowerRunCache(): ProposalVotingPowerRunCache {
  return {
    drepTotalByEpoch: new Map<number, bigint>(),
    drepTotalInFlight: new Map<number, Promise<AggregatePowerFetchResult>>(),
    spoTotalByEpoch: new Map<number, bigint>(),
    spoTotalInFlight: new Map<number, Promise<AggregatePowerFetchResult>>(),
    epochTotalsByEpoch: new Map(),
    epochTotalsInFlight: new Map(),
  };
}

const VOTE_POWER_USE_EPOCH_TOTALS_CACHE =
  process.env.VOTE_POWER_USE_EPOCH_TOTALS_CACHE !== "false";

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

async function getEpochTotalsPowerFromDb(
  epochNo: number,
  runCache?: ProposalVotingPowerRunCache
): Promise<{ delegatedDrepPower: bigint | null; totalPoolVotePower: bigint | null }> {
  const epochTotalsClient = (prisma as typeof prisma & {
    epochTotals?: { findUnique?: (...args: any[]) => Promise<any> };
  }).epochTotals;
  if (typeof epochTotalsClient?.findUnique !== "function") {
    return { delegatedDrepPower: null, totalPoolVotePower: null };
  }

  const cached = runCache?.epochTotalsByEpoch.get(epochNo);
  if (cached) return cached;

  const inFlight = runCache?.epochTotalsInFlight.get(epochNo);
  if (inFlight) return await inFlight;

  const loadPromise = (async () => {
    const row = await epochTotalsClient.findUnique({
      where: { epoch: epochNo },
      select: { delegatedDrepPower: true, totalPoolVotePower: true },
    });
    return {
      delegatedDrepPower: row?.delegatedDrepPower ?? null,
      totalPoolVotePower: row?.totalPoolVotePower ?? null,
    };
  })();

  if (runCache) runCache.epochTotalsInFlight.set(epochNo, loadPromise);
  try {
    const loaded = await loadPromise;
    runCache?.epochTotalsByEpoch.set(epochNo, loaded);
    return loaded;
  } finally {
    runCache?.epochTotalsInFlight.delete(epochNo);
  }
}

async function fetchDrepTotalVotingPower(
  epochNo: number,
  runCache?: ProposalVotingPowerRunCache
): Promise<AggregatePowerFetchResult> {
  const fromCache = runCache?.drepTotalByEpoch.get(epochNo);
  if (fromCache !== undefined) {
    return { value: fromCache, complete: true };
  }
  const inFlight = runCache?.drepTotalInFlight.get(epochNo);
  if (inFlight) return await inFlight;

  const loadPromise = (async () => {
    if (VOTE_POWER_USE_EPOCH_TOTALS_CACHE) {
      try {
        const row = await getEpochTotalsPowerFromDb(epochNo, runCache);
        if (row.delegatedDrepPower != null) {
          runCache?.drepTotalByEpoch.set(epochNo, row.delegatedDrepPower);
          return { value: row.delegatedDrepPower, complete: true };
        }
        if (shouldRequireCompleteEpochTotals(epochNo)) {
          console.warn(
            `[Voting Power] EpochTotals missing delegatedDrepPower for required-complete epoch ${epochNo}; falling back to Koios`
          );
        }
      } catch (dbError: any) {
        console.warn(
          `[Voting Power] Failed reading EpochTotals delegatedDrepPower for epoch ${epochNo}: ${dbError?.message ?? String(dbError)}`
        );
      }
    }

  try {
    const summary = await getDrepEpochSummary(epochNo, {
      source: "ingestion.proposal.voting-power.drep-epoch-summary",
    });
    if (summary?.amount) {
      const value = BigInt(summary.amount);
      runCache?.drepTotalByEpoch.set(epochNo, value);
      return { value, complete: true };
    }
    return { value: BigInt(0), complete: false, error: "missing-drep-summary" };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    console.warn(`[DRep Epoch Summary] Failed to fetch for epoch ${epochNo}:`, message);
    return { value: BigInt(0), complete: false, error: message };
  }
  })();

  if (runCache) runCache.drepTotalInFlight.set(epochNo, loadPromise);
  try {
    return await loadPromise;
  } finally {
    runCache?.drepTotalInFlight.delete(epochNo);
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
  if (VOTE_POWER_USE_EPOCH_TOTALS_CACHE) {
    try {
      const row = await getEpochTotalsPowerFromDb(epochNo, runCache);
      if (row.totalPoolVotePower != null) {
        runCache?.spoTotalByEpoch.set(epochNo, row.totalPoolVotePower);
        return { value: row.totalPoolVotePower, complete: true };
      }
      if (shouldRequireCompleteEpochTotals(epochNo)) {
        console.warn(
          `[Voting Power] EpochTotals missing totalPoolVotePower for required-complete epoch ${epochNo}; falling back to Koios`
        );
      }
    } catch (dbError: any) {
      console.warn(
        `[Voting Power] Failed reading EpochTotals totalPoolVotePower for epoch ${epochNo}: ${dbError?.message ?? String(dbError)}`
      );
    }
  }

  try {
    const pools = typeof getAllPoolVotingPowerHistoryForEpoch === "function"
      ? await getAllPoolVotingPowerHistoryForEpoch({
          epochNo,
          source: "ingestion.proposal.voting-power.pool-history",
        })
      : await listPoolVotingPowerHistory({
          epochNo,
          source: "ingestion.proposal.voting-power.pool-history.fallback",
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

type ProposalVotePowerData = {
  drepTotalVotePower: bigint | null;
  drepActiveYesVotePower: bigint | null;
  drepActiveNoVotePower: bigint | null;
  drepActiveAbstainVotePower: bigint | null;
  drepAlwaysAbstainVotePower: bigint | null;
  drepAlwaysNoConfidencePower: bigint | null;
  drepInactiveVotePower: bigint | null;
  spoTotalVotePower: bigint | null;
  spoActiveYesVotePower: bigint | null;
  spoActiveNoVotePower: bigint | null;
  spoActiveAbstainVotePower: bigint | null;
  spoAlwaysAbstainVotePower: bigint | null;
  spoAlwaysNoConfidencePower: bigint | null;
  spoNoVotePower: bigint | null;
};

function buildProposalVotePowerData(args: {
  votingSummary: NonNullable<Awaited<ReturnType<typeof getProposalVotingSummary>>>;
  drepTotalVotePower: bigint;
  spoTotalVotePower: bigint;
  drepInactiveVotePower: bigint;
}): ProposalVotePowerData {
  return {
    drepTotalVotePower: args.drepTotalVotePower,
    drepActiveYesVotePower: lovelaceToBigInt(
      args.votingSummary.drep_active_yes_vote_power
    ),
    drepActiveNoVotePower: lovelaceToBigInt(
      args.votingSummary.drep_active_no_vote_power
    ),
    drepActiveAbstainVotePower: lovelaceToBigInt(
      args.votingSummary.drep_active_abstain_vote_power
    ),
    drepAlwaysAbstainVotePower: lovelaceToBigInt(
      args.votingSummary.drep_always_abstain_vote_power
    ),
    drepAlwaysNoConfidencePower: lovelaceToBigInt(
      args.votingSummary.drep_always_no_confidence_vote_power
    ),
    drepInactiveVotePower: args.drepInactiveVotePower,
    spoTotalVotePower: args.spoTotalVotePower,
    spoActiveYesVotePower: lovelaceToBigInt(
      args.votingSummary.pool_active_yes_vote_power
    ),
    spoActiveNoVotePower: lovelaceToBigInt(
      args.votingSummary.pool_active_no_vote_power
    ),
    spoActiveAbstainVotePower: lovelaceToBigInt(
      args.votingSummary.pool_active_abstain_vote_power
    ),
    spoAlwaysAbstainVotePower: lovelaceToBigInt(
      args.votingSummary.pool_passive_always_abstain_vote_power
    ),
    spoAlwaysNoConfidencePower: lovelaceToBigInt(
      args.votingSummary.pool_passive_always_no_confidence_vote_power
    ),
    spoNoVotePower: lovelaceToBigInt(args.votingSummary.pool_no_vote_power),
  };
}

function countChangedVotePowerFields(
  current: ProposalVotePowerData,
  next: ProposalVotePowerData
): number {
  const keys = Object.keys(next) as Array<keyof ProposalVotePowerData>;
  let changed = 0;
  for (const key of keys) {
    if ((current[key] ?? null) !== (next[key] ?? null)) {
      changed += 1;
    }
  }
  return changed;
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
        fetchDrepTotalVotingPower(drepTotalPowerEpoch, votingPowerRunCache),
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

    const nextVotePowerData = buildProposalVotePowerData({
      votingSummary,
      drepTotalVotePower: drepTotalVotePowerResult.value,
      spoTotalVotePower: spoTotalVotePowerResult.value,
      drepInactiveVotePower,
    });
    const proposalClient = prisma.proposal as typeof prisma.proposal & {
      findUnique?: (...args: any[]) => Promise<ProposalVotePowerData | null>;
    };
    let changedFields = Object.keys(nextVotePowerData).length;
    if (typeof proposalClient.findUnique === "function") {
      const currentProposal = await proposalClient.findUnique({
        where: { proposalId },
        select: {
          drepTotalVotePower: true,
          drepActiveYesVotePower: true,
          drepActiveNoVotePower: true,
          drepActiveAbstainVotePower: true,
          drepAlwaysAbstainVotePower: true,
          drepAlwaysNoConfidencePower: true,
          drepInactiveVotePower: true,
          spoTotalVotePower: true,
          spoActiveYesVotePower: true,
          spoActiveNoVotePower: true,
          spoActiveAbstainVotePower: true,
          spoAlwaysAbstainVotePower: true,
          spoAlwaysNoConfidencePower: true,
          spoNoVotePower: true,
        },
      });
      if (!currentProposal) {
        return {
          success: false,
          summaryFound: true,
          error: `Proposal not found: ${proposalId}`,
        };
      }
      changedFields = countChangedVotePowerFields(
        currentProposal,
        nextVotePowerData
      );
      if (changedFields === 0) {
        console.log(
          `[Voting Power] Skip DB write for ${proposalId} (unchanged vote power fields)`
        );
        return {
          success: true,
          summaryFound: true,
        };
      }
    }

    await prisma.proposal.update({
      where: { proposalId },
      data: nextVotePowerData,
    });
    console.log(
      `[Voting Power] Proposal update metrics: proposalId=${proposalId} changedFields=${changedFields}`
    );

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
