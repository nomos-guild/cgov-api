import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  GetVotingTurnoutResponse,
  ProposalTurnout,
} from "../../responses/analytics.response";
import {
  SPO_FORMULA_TRANSITION_EPOCH,
  SPO_FORMULA_TRANSITION_GOV_ACTION,
  VOTING_THRESHOLDS,
  getVotingThreshold,
  toNumber,
} from "../../libs/proposalMapper";
import { GovernanceType } from "@prisma/client";

const isKnownGovernanceType = (
  value: string | null
): value is GovernanceType => {
  if (!value) return false;
  return Object.prototype.hasOwnProperty.call(VOTING_THRESHOLDS, value);
};

const shouldComputeSpoTurnout = (governanceActionType: string | null): boolean => {
  if (!isKnownGovernanceType(governanceActionType)) return false;
  return getVotingThreshold(governanceActionType).spoThreshold !== null;
};

const shouldUseNewSpoFormulaFromRow = (row: {
  proposalId: string;
  submissionEpoch: number | null;
}): boolean => {
  if (row.proposalId === SPO_FORMULA_TRANSITION_GOV_ACTION) {
    return true;
  }
  return (
    row.submissionEpoch !== null &&
    row.submissionEpoch !== undefined &&
    row.submissionEpoch >= SPO_FORMULA_TRANSITION_EPOCH
  );
};

const computeSpoTurnoutMetrics = (row: any) => {
  const spoActiveYes = toNumber(row.spoActiveYesVotePower);
  const spoActiveNo = toNumber(row.spoActiveNoVotePower);
  const spoActiveAbstain = toNumber(row.spoActiveAbstainVotePower);
  const spoAlwaysAbstain = toNumber(row.spoAlwaysAbstainVotePower);
  const spoAlwaysNoConfidence = toNumber(row.spoAlwaysNoConfidencePower);

  const spoActiveVotes = spoActiveYes + spoActiveNo + spoActiveAbstain;
  const spoDefaultStance = spoAlwaysAbstain + spoAlwaysNoConfidence;

  const storedTotal = toNumber(row.spoTotalVotePower);
  const koiosNoVotePowerRaw =
    row.spoNoVotePower === null || row.spoNoVotePower === undefined
      ? null
      : toNumber(row.spoNoVotePower);

  const useNewFormula = shouldUseNewSpoFormulaFromRow(row);
  const isHardForkInitiation =
    row.governanceActionType === GovernanceType.HARD_FORK_INITIATION;

  let effectiveTotal = storedTotal;
  let notVotedPower: number;

  // Prefer Koios pool_no_vote_power (consistent snapshot) when available.
  // This mirrors the approach in proposalMapper's SPO vote calculations.
  if (koiosNoVotePowerRaw !== null) {
    // effectiveTotal = yes + abstain + pool_no_vote_power
    // (pool_no_vote_power includes explicit no + alwaysNoConfidence + notVoted, and
    // for hard-fork initiation it can also include alwaysAbstain)
    effectiveTotal = spoActiveYes + spoActiveAbstain + koiosNoVotePowerRaw;

    notVotedPower =
      useNewFormula && isHardForkInitiation
        ? koiosNoVotePowerRaw -
          spoActiveNo -
          spoAlwaysNoConfidence -
          spoAlwaysAbstain
        : koiosNoVotePowerRaw - spoActiveNo - spoAlwaysNoConfidence;
  } else {
    notVotedPower =
      useNewFormula && isHardForkInitiation
        ? effectiveTotal - spoActiveYes - spoActiveNo - spoActiveAbstain
        : effectiveTotal -
          spoActiveYes -
          spoActiveNo -
          spoActiveAbstain -
          spoAlwaysAbstain -
          spoAlwaysNoConfidence;
  }

  const turnoutPct =
    effectiveTotal > 0
      ? Number(((spoActiveVotes / effectiveTotal) * 100).toFixed(2))
      : null;

  // Participating = active + default stance (aligned with API contract)
  const participating = spoActiveVotes + spoDefaultStance;
  const participatingPct =
    effectiveTotal > 0
      ? Number(((participating / effectiveTotal) * 100).toFixed(2))
      : null;

  return {
    effectiveTotal,
    turnoutPct,
    participatingPct,
    notVotedPower: Math.max(0, notVotedPower),
    participating,
    active: spoActiveVotes,
  };
};

/**
 * GET /analytics/voting-turnout
 * Returns voting turnout (% ada) for DRep and SPO per proposal
 *
 * Query params:
 * - page: Page number (default: 1)
 * - pageSize: Items per page (default: 20, max: 100)
 * - status: Filter by proposal status (optional, comma-separated)
 * - governanceActionType: Filter by action type (optional, comma-separated)
 * - epochStart: Filter proposals by submission epoch >= epochStart
 * - epochEnd: Filter proposals by submission epoch <= epochEnd
 */
export const getVotingTurnout = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(req.query.pageSize as string) || 20)
    );
    const statusFilter = (req.query.status as string)?.split(",").filter(Boolean);
    const typeFilter = (req.query.governanceActionType as string)
      ?.split(",")
      .filter(Boolean);
    const epochStart = req.query.epochStart
      ? parseInt(req.query.epochStart as string)
      : null;
    const epochEnd = req.query.epochEnd
      ? parseInt(req.query.epochEnd as string)
      : null;

    // Build where clause
    const whereClause: any = {};
    if (statusFilter && statusFilter.length > 0) {
      whereClause.status = { in: statusFilter };
    }
    if (typeFilter && typeFilter.length > 0) {
      whereClause.governanceActionType = { in: typeFilter };
    }
    if (epochStart !== null) {
      whereClause.submissionEpoch = { ...whereClause.submissionEpoch, gte: epochStart };
    }
    if (epochEnd !== null) {
      whereClause.submissionEpoch = { ...whereClause.submissionEpoch, lte: epochEnd };
    }

    // Get total count and proposals
    const [totalItems, proposals] = await Promise.all([
      prisma.proposal.count({ where: whereClause }),
      prisma.proposal.findMany({
        where: whereClause,
        orderBy: { submissionEpoch: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          proposalId: true,
          title: true,
          governanceActionType: true,
          submissionEpoch: true,
          status: true,
          // DRep fields
          drepActiveYesVotePower: true,
          drepActiveNoVotePower: true,
          drepActiveAbstainVotePower: true,
          drepTotalVotePower: true,
          drepAlwaysAbstainVotePower: true,
          drepAlwaysNoConfidencePower: true,
          drepInactiveVotePower: true,
          // SPO fields
          spoActiveYesVotePower: true,
          spoActiveNoVotePower: true,
          spoActiveAbstainVotePower: true,
          spoTotalVotePower: true,
          spoAlwaysAbstainVotePower: true,
          spoAlwaysNoConfidencePower: true,
          spoNoVotePower: true,
        },
      }),
    ]);

    // Calculate turnout for each proposal
    const proposalTurnouts: ProposalTurnout[] = proposals.map((p) => {
      // DRep calculations
      const drepActiveVotes = toNumber(p.drepActiveYesVotePower) +
        toNumber(p.drepActiveNoVotePower) +
        toNumber(p.drepActiveAbstainVotePower);
      const drepAlwaysAbstain = toNumber(p.drepAlwaysAbstainVotePower);
      const drepAlwaysNoConfidence = toNumber(p.drepAlwaysNoConfidencePower);
      const drepInactive = toNumber(p.drepInactiveVotePower);
      const drepTotal = toNumber(p.drepTotalVotePower);

      // Default stance = alwaysAbstain + alwaysNoConfidence
      const drepDefaultStance = drepAlwaysAbstain + drepAlwaysNoConfidence;

      // Not voted = total - active - defaultStance - inactive
      const drepNotVoted = drepTotal - drepActiveVotes - drepDefaultStance - drepInactive;

      // Turnout (active only) - backward compatible
      const drepTurnoutPct = drepTotal > 0
        ? Number(((drepActiveVotes / drepTotal) * 100).toFixed(2))
        : null;

      // Participating = active + default stance (not inactive, not notVoted)
      const drepParticipating = drepActiveVotes + drepDefaultStance;
      const drepParticipatingPct = drepTotal > 0
        ? Number(((drepParticipating / drepTotal) * 100).toFixed(2))
        : null;

      // SPO calculations
      const spoEligible = shouldComputeSpoTurnout(p.governanceActionType);

      const spoMetrics =
        spoEligible && p.spoTotalVotePower !== null && p.spoTotalVotePower !== undefined
          ? computeSpoTurnoutMetrics(p)
          : null;

      const spoTurnoutPct = spoMetrics?.turnoutPct ?? null;
      const spoParticipatingPct = spoMetrics?.participatingPct ?? null;

      return {
        proposalId: p.proposalId,
        title: p.title,
        governanceActionType: p.governanceActionType,
        submissionEpoch: p.submissionEpoch,
        status: p.status,
        // Backward compatible fields
        drepTurnoutPct,
        spoTurnoutPct,
        drepActiveYesVotePower: p.drepActiveYesVotePower?.toString() ?? null,
        drepActiveNoVotePower: p.drepActiveNoVotePower?.toString() ?? null,
        drepActiveAbstainVotePower: p.drepActiveAbstainVotePower?.toString() ?? null,
        drepTotalVotePower: p.drepTotalVotePower?.toString() ?? null,
        spoActiveYesVotePower: p.spoActiveYesVotePower?.toString() ?? null,
        spoActiveNoVotePower: p.spoActiveNoVotePower?.toString() ?? null,
        spoActiveAbstainVotePower: p.spoActiveAbstainVotePower?.toString() ?? null,
        spoTotalVotePower: p.spoTotalVotePower?.toString() ?? null,
        // NEW: DRep breakdown fields
        drepAlwaysAbstainVotePower: p.drepAlwaysAbstainVotePower?.toString() ?? null,
        drepAlwaysNoConfidencePower: p.drepAlwaysNoConfidencePower?.toString() ?? null,
        drepInactiveVotePower: p.drepInactiveVotePower?.toString() ?? null,
        drepNotVotedPower: Math.max(0, drepNotVoted).toString(),
        drepParticipatingPct,
        // NEW: SPO breakdown fields
        spoAlwaysAbstainVotePower: p.spoAlwaysAbstainVotePower?.toString() ?? null,
        spoAlwaysNoConfidencePower: p.spoAlwaysNoConfidencePower?.toString() ?? null,
        spoNotVotedPower: spoMetrics ? spoMetrics.notVotedPower.toString() : null,
        spoParticipatingPct,
      };
    });

    // Calculate aggregate turnout (weighted average by total vote power)
    let totalDrepActive = 0;
    let totalDrepParticipating = 0;
    let totalDrepPower = 0;
    let totalSpoActive = 0;
    let totalSpoParticipating = 0;
    let totalSpoPower = 0;

    for (const p of proposals) {
      if (p.drepTotalVotePower) {
        const drepActive =
          toNumber(p.drepActiveYesVotePower) +
          toNumber(p.drepActiveNoVotePower) +
          toNumber(p.drepActiveAbstainVotePower);
        const drepDefaultStance =
          toNumber(p.drepAlwaysAbstainVotePower) +
          toNumber(p.drepAlwaysNoConfidencePower);

        totalDrepActive += drepActive;
        totalDrepParticipating += drepActive + drepDefaultStance;
        totalDrepPower += toNumber(p.drepTotalVotePower);
      }
      const spoEligible = shouldComputeSpoTurnout(p.governanceActionType);
      if (spoEligible && p.spoTotalVotePower) {
        const metrics = computeSpoTurnoutMetrics(p);
        totalSpoActive += metrics.active;
        totalSpoParticipating += metrics.participating;
        totalSpoPower += metrics.effectiveTotal;
      }
    }

    const aggregateDrepTurnoutPct =
      totalDrepPower > 0
        ? Number(((totalDrepActive / totalDrepPower) * 100).toFixed(2))
        : null;
    const aggregateDrepParticipatingPct =
      totalDrepPower > 0
        ? Number(((totalDrepParticipating / totalDrepPower) * 100).toFixed(2))
        : null;
    const aggregateSpoTurnoutPct =
      totalSpoPower > 0
        ? Number(((totalSpoActive / totalSpoPower) * 100).toFixed(2))
        : null;
    const aggregateSpoParticipatingPct =
      totalSpoPower > 0
        ? Number(((totalSpoParticipating / totalSpoPower) * 100).toFixed(2))
        : null;

    const response: GetVotingTurnoutResponse = {
      proposals: proposalTurnouts,
      aggregateDrepTurnoutPct,
      aggregateDrepParticipatingPct,
      aggregateSpoTurnoutPct,
      aggregateSpoParticipatingPct,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching voting turnout", error);
    res.status(500).json({
      error: "Failed to fetch voting turnout",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
