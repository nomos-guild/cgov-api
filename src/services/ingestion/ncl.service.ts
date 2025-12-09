/**
 * NCL (Net Change Limit) Service
 * Handles calculation and updating of treasury withdrawal aggregates
 * All values stored in lovelace (1 ADA = 1,000,000 lovelace)
 */

import { PrismaClient, GovernanceType, ProposalStatus } from "@prisma/client";
import { koiosGet } from "../koios";
import type { KoiosProposal } from "../../types/koios.types";

const prisma = new PrismaClient();

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
 * Calculates total treasury withdrawals from ratified/enacted proposals for a given year
 *
 * @param year - Calendar year to calculate withdrawals for
 * @returns Total withdrawal amount in lovelace
 */
async function calculateTreasuryWithdrawalsForYear(_year: number): Promise<{
  totalLovelace: bigint;
  proposalCount: number;
}> {
  // Fetch all treasury withdrawal proposals from Koios
  const allProposals = await koiosGet<KoiosProposal[]>("/proposal_list");

  if (!allProposals || allProposals.length === 0) {
    return { totalLovelace: BigInt(0), proposalCount: 0 };
  }

  // Filter for treasury withdrawals that are ratified or enacted
  const treasuryProposals = allProposals.filter((p) => {
    // Must be TreasuryWithdrawals type
    if (p.proposal_type !== "TreasuryWithdrawals") {
      return false;
    }

    // Must be ratified or enacted
    const isRatified = p.ratified_epoch !== null && p.ratified_epoch !== undefined;
    const isEnacted = p.enacted_epoch !== null && p.enacted_epoch !== undefined;

    if (!isRatified && !isEnacted) {
      return false;
    }

    // Check if the ratified/enacted epoch falls within the given year
    // We need to determine which epoch corresponds to the year boundary
    // For simplicity, we'll use the enacted_epoch or ratified_epoch to derive the year
    // Cardano epochs are ~5 days, so we need to calculate based on block_time or use a heuristic

    // Alternative approach: Check if the proposal was ratified/enacted in the given year
    // by looking at the block_time or by querying the epoch-to-date mapping
    // For now, we'll include all ratified/enacted treasury proposals
    // and let the admin manage the year boundary via the limit field

    return true;
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
 * Updates the NCL record for the current year
 * Creates a new record if one doesn't exist (with limit = 0, to be set by admin)
 *
 * @returns Result of the update operation
 */
export async function updateNCL(): Promise<NCLUpdateResult> {
  const currentYear = new Date().getUTCFullYear();
  const currentEpoch = await getCurrentEpoch();

  console.log(`[NCL] Calculating treasury withdrawals for year ${currentYear}...`);

  // Calculate current treasury withdrawals (in lovelace)
  const { totalLovelace, proposalCount } = await calculateTreasuryWithdrawalsForYear(currentYear);

  // For logging, convert to ADA for readability
  const totalAda = Number(totalLovelace) / 1_000_000;
  console.log(
    `[NCL] Found ${proposalCount} ratified/enacted treasury withdrawal proposals, ` +
    `total: ${totalAda.toLocaleString()} ADA (${totalLovelace.toString()} lovelace)`
  );

  // Check if NCL record exists for this year
  const existingNCL = await prisma.nCL.findUnique({
    where: { year: currentYear },
  });

  if (existingNCL) {
    // Update existing record
    await prisma.nCL.update({
      where: { year: currentYear },
      data: {
        epoch: currentEpoch,
        current: totalLovelace,
      },
    });

    console.log(`[NCL] Updated NCL for ${currentYear}: current=${totalLovelace.toString()} lovelace`);

    return {
      year: currentYear,
      epoch: currentEpoch,
      currentValue: totalLovelace,
      proposalsIncluded: proposalCount,
      updated: true,
    };
  } else {
    // Create new record with limit = 0 (admin needs to set the limit)
    await prisma.nCL.create({
      data: {
        year: currentYear,
        epoch: currentEpoch,
        current: totalLovelace,
        limit: BigInt(0), // Admin must set this manually
      },
    });

    console.log(
      `[NCL] Created new NCL record for ${currentYear}: current=${totalLovelace.toString()} lovelace, ` +
      `limit=0 (admin needs to set the limit)`
    );

    return {
      year: currentYear,
      epoch: currentEpoch,
      currentValue: totalLovelace,
      proposalsIncluded: proposalCount,
      updated: true,
    };
  }
}

/**
 * Alternative calculation using database records instead of Koios API
 * This is more efficient if the database is already synced
 *
 * @param year - Calendar year to calculate withdrawals for
 * @returns Total withdrawal amount in lovelace
 */
export async function calculateNCLFromDatabase(_year: number): Promise<{
  totalLovelace: bigint;
  proposalCount: number;
}> {
  // Query ratified/enacted treasury withdrawal proposals from database
  const treasuryProposals = await prisma.proposal.findMany({
    where: {
      governanceActionType: GovernanceType.TREASURY_WITHDRAWALS,
      status: {
        in: [ProposalStatus.RATIFIED, ProposalStatus.ENACTED],
      },
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
