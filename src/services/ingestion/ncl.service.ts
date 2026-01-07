/**
 * NCL (Net Change Limit) Service
 * Handles calculation and updating of treasury withdrawal aggregates
 * All values stored in lovelace (1 ADA = 1,000,000 lovelace)
 */

import { GovernanceType, ProposalStatus } from "@prisma/client";
import { prisma } from "../prisma";
import { koiosGet } from "../koios";
import type { KoiosProposal } from "../../types/koios.types";

/**
 * Result of NCL update operation
 */
export interface NCLUpdateResult {
  year: number;
  epoch: number;
  currentValue: bigint; // In lovelace
  proposalsIncluded: number;
  updated: boolean;
}

/**
 * Gets the current epoch from Koios API
 */
async function getCurrentEpoch(): Promise<number> {
  const tip = await koiosGet<Array<{ epoch_no: number }>>("/tip");
  return tip?.[0]?.epoch_no || 0;
}

/**
 * Cardano mainnet epoch reference point
 * Epoch 208 started on July 29, 2020 (Shelley era start)
 * Each epoch is exactly 5 days (432000 seconds)
 */
const EPOCH_208_START = new Date("2020-07-29T21:44:51Z").getTime();
const EPOCH_DURATION_MS = 5 * 24 * 60 * 60 * 1000; // 5 days in milliseconds

/**
 * Converts an epoch number to its start date
 */
function epochToDate(epoch: number): Date {
  const epochDiff = epoch - 208;
  const timestampMs = EPOCH_208_START + epochDiff * EPOCH_DURATION_MS;
  return new Date(timestampMs);
}

/**
 * Special epoch boundaries for NCL years
 *
 * 2025 NCL Extension: The "2025 Net Change Limit Extension" governance action
 * approved extending the 2025 NCL period by 8 additional epochs,
 * ending at the conclusion of Epoch 612 (February 8, 2026).
 *
 * This means:
 * - 2025 NCL: ends at epoch 612 (inclusive)
 * - 2026 NCL: starts at epoch 613
 */
const NCL_YEAR_BOUNDARIES: Record<number, { startEpoch: number; endEpoch: number }> = {
  2025: { startEpoch: 539, endEpoch: 613 }, // Extended to epoch 612 (inclusive), so endEpoch is 613
  2026: { startEpoch: 613, endEpoch: 686 }, // Starts after 2025 extension ends
};

/**
 * Gets the epoch range for a given year
 * Returns the first epoch that starts in the year and the last epoch that ends in the year (exclusive)
 *
 * Special cases:
 * - 2025: Extended by 8 epochs, ends at epoch 612
 * - 2026: Starts at epoch 613
 */
function getEpochRangeForYear(year: number): { startEpoch: number; endEpoch: number } {
  // Check for special NCL year boundaries first
  if (NCL_YEAR_BOUNDARIES[year]) {
    return NCL_YEAR_BOUNDARIES[year];
  }

  // Default calculation for other years
  const yearStart = new Date(`${year}-01-01T00:00:00Z`).getTime();
  const yearEnd = new Date(`${year + 1}-01-01T00:00:00Z`).getTime();

  // Calculate approximate start epoch for the year
  const startEpoch = Math.ceil((yearStart - EPOCH_208_START) / EPOCH_DURATION_MS) + 208;
  // Calculate approximate end epoch (first epoch of next year)
  const endEpoch = Math.floor((yearEnd - EPOCH_208_START) / EPOCH_DURATION_MS) + 208;

  return { startEpoch, endEpoch };
}

/**
 * Calculates total treasury withdrawals from ratified/enacted proposals for a given year
 *
 * @param year - Calendar year to calculate withdrawals for
 * @returns Total withdrawal amount in lovelace
 */
async function calculateTreasuryWithdrawalsForYear(year: number): Promise<{
  totalLovelace: bigint;
  proposalCount: number;
}> {
  // Fetch all treasury withdrawal proposals from Koios
  const allProposals = await koiosGet<KoiosProposal[]>("/proposal_list");

  if (!allProposals || allProposals.length === 0) {
    return { totalLovelace: BigInt(0), proposalCount: 0 };
  }

  // Get epoch range for the given year
  const { startEpoch, endEpoch } = getEpochRangeForYear(year);
  console.log(`[NCL] Year ${year} epoch range: ${startEpoch} - ${endEpoch}`);

  // Filter for treasury withdrawals that are ratified or enacted within the year
  const treasuryProposals = allProposals.filter((p) => {
    // Must be TreasuryWithdrawals type
    if (p.proposal_type !== "TreasuryWithdrawals") {
      return false;
    }

    // Must be ratified or enacted
    const ratifiedEpoch = p.ratified_epoch;
    const enactedEpoch = p.enacted_epoch;

    const isRatified = ratifiedEpoch !== null && ratifiedEpoch !== undefined;
    const isEnacted = enactedEpoch !== null && enactedEpoch !== undefined;

    if (!isRatified && !isEnacted) {
      return false;
    }

    // Check if the enacted epoch (or ratified if not enacted) falls within the year
    // Use enacted_epoch if available, otherwise use ratified_epoch
    const relevantEpoch = isEnacted ? enactedEpoch : ratifiedEpoch;

    if (relevantEpoch === null || relevantEpoch === undefined) {
      return false;
    }

    // Check if the epoch falls within the year's epoch range
    const withinYear = relevantEpoch >= startEpoch && relevantEpoch < endEpoch;

    if (withinYear) {
      const epochDate = epochToDate(relevantEpoch);
      console.log(`[NCL] Including proposal ${p.proposal_id}: enacted/ratified epoch ${relevantEpoch} (${epochDate.toISOString()})`);
    }

    return withinYear;
  });

  // Calculate total withdrawal amount in lovelace
  let totalLovelace = BigInt(0);

  for (const proposal of treasuryProposals) {
    const withdrawal = (proposal as any).withdrawal;

    if (withdrawal) {
      if (Array.isArray(withdrawal)) {
        // Handle array of withdrawals
        for (const w of withdrawal) {
          if (w.amount) {
            totalLovelace += BigInt(w.amount);
          }
        }
      } else if (typeof withdrawal === 'object' && withdrawal.amount) {
        // Handle single withdrawal object: { amount: "...", stake_address: "..." }
        totalLovelace += BigInt(withdrawal.amount);
      }
    }
  }

  return {
    totalLovelace,
    proposalCount: treasuryProposals.length,
  };
}

/**
 * Updates the NCL record for a specific year
 * Creates a new record if one doesn't exist (with limit = 0, to be set by admin)
 *
 * @param year - The year to update NCL for
 * @param currentEpoch - Current epoch number
 * @returns Result of the update operation
 */
async function updateNCLForYear(year: number, currentEpoch: number): Promise<NCLUpdateResult> {
  console.log(`[NCL] Calculating treasury withdrawals for year ${year}...`);

  // Calculate current treasury withdrawals (in lovelace)
  const { totalLovelace, proposalCount } = await calculateTreasuryWithdrawalsForYear(year);

  // For logging, convert to ADA for readability
  const totalAda = Number(totalLovelace) / 1_000_000;
  console.log(
    `[NCL] Year ${year}: Found ${proposalCount} ratified/enacted treasury withdrawal proposals, ` +
    `total: ${totalAda.toLocaleString()} ADA (${totalLovelace.toString()} lovelace)`
  );

  // Check if NCL record exists for this year
  const existingNCL = await prisma.nCL.findUnique({
    where: { year },
  });

  if (existingNCL) {
    // Update existing record
    await prisma.nCL.update({
      where: { year },
      data: {
        epoch: currentEpoch,
        current: totalLovelace,
        updatedAt: new Date(),
      },
    });

    console.log(`[NCL] Updated NCL for ${year}: current=${totalLovelace.toString()} lovelace`);

    return {
      year,
      epoch: currentEpoch,
      currentValue: totalLovelace,
      proposalsIncluded: proposalCount,
      updated: true,
    };
  } else {
    // Create new record with limit = 0 (admin needs to set the limit)
    await prisma.nCL.create({
      data: {
        id: `ncl-${year}`,
        year,
        epoch: currentEpoch,
        current: totalLovelace,
        limit: BigInt(0), // Admin must set this manually
        updatedAt: new Date(),
      },
    });

    console.log(
      `[NCL] Created new NCL record for ${year}: current=${totalLovelace.toString()} lovelace, ` +
      `limit=0 (admin needs to set the limit)`
    );

    return {
      year,
      epoch: currentEpoch,
      currentValue: totalLovelace,
      proposalsIncluded: proposalCount,
      updated: true,
    };
  }
}

/**
 * Updates NCL records for all years with ongoing NCL periods
 * - Updates previous year if its NCL period is still ongoing (e.g., 2025 extended to epoch 612)
 * - Always updates current year
 *
 * @returns Results of the update operations for each year
 */
export async function updateNCL(): Promise<NCLUpdateResult> {
  const currentEpoch = await getCurrentEpoch();
  const currentYear = new Date().getUTCFullYear();
  const results: NCLUpdateResult[] = [];

  console.log(`[NCL] Current epoch: ${currentEpoch}, current year: ${currentYear}`);

  // Check if previous year's NCL period is still ongoing
  const prevYear = currentYear - 1;
  const prevYearBoundary = NCL_YEAR_BOUNDARIES[prevYear];

  if (prevYearBoundary && currentEpoch < prevYearBoundary.endEpoch) {
    console.log(`[NCL] Previous year (${prevYear}) NCL period is still ongoing (ends at epoch ${prevYearBoundary.endEpoch})`);
    const prevYearResult = await updateNCLForYear(prevYear, currentEpoch);
    results.push(prevYearResult);
  } else {
    console.log(`[NCL] Previous year (${prevYear}) NCL period has ended, skipping`);
  }

  // Always update current year
  const currentYearResult = await updateNCLForYear(currentYear, currentEpoch);
  results.push(currentYearResult);

  // Return the current year result for backwards compatibility
  // (the function signature expects a single NCLUpdateResult)
  return currentYearResult;
}

/**
 * Alternative calculation using database records instead of Koios API
 * This is more efficient if the database is already synced
 *
 * @param year - Calendar year to calculate withdrawals for
 * @returns Total withdrawal amount in lovelace
 */
export async function calculateNCLFromDatabase(year: number): Promise<{
  totalLovelace: bigint;
  proposalCount: number;
}> {
  // Get epoch range for the given year
  const { startEpoch, endEpoch } = getEpochRangeForYear(year);

  // Query ratified/enacted treasury withdrawal proposals from database
  // Filter by enacted or ratified epoch within the year
  const treasuryProposals = await prisma.proposal.findMany({
    where: {
      governanceActionType: GovernanceType.TREASURY_WITHDRAWALS,
      status: {
        in: [ProposalStatus.RATIFIED, ProposalStatus.ENACTED],
      },
      OR: [
        {
          enactedEpoch: {
            gte: startEpoch,
            lt: endEpoch,
          },
        },
        {
          AND: [
            { enactedEpoch: null },
            {
              ratifiedEpoch: {
                gte: startEpoch,
                lt: endEpoch,
              },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      proposalId: true,
      metadata: true,
      ratifiedEpoch: true,
      enactedEpoch: true,
    },
  });

  let totalLovelace = BigInt(0);

  for (const proposal of treasuryProposals) {
    if (proposal.metadata) {
      try {
        const metadata = JSON.parse(proposal.metadata);
        // The withdrawal array might be stored in the metadata
        // Structure depends on how Koios provides it
        if (metadata.withdrawal && Array.isArray(metadata.withdrawal)) {
          for (const withdrawal of metadata.withdrawal) {
            if (withdrawal.amount) {
              totalLovelace += BigInt(withdrawal.amount);
            }
          }
        }
      } catch (e) {
        console.warn(`[NCL] Failed to parse metadata for proposal ${proposal.proposalId}`);
      }
    }
  }

  return {
    totalLovelace,
    proposalCount: treasuryProposals.length,
  };
}
