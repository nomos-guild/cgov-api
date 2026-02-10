import { Request, Response } from "express";
import { VoterType } from "@prisma/client";
import { prisma } from "../../services";
import { koiosGet } from "../../services/koios";
import { KoiosCommitteeInfo, KoiosTip } from "../../types/koios.types";
import {
  GetCCParticipationResponse,
  CCMemberParticipation,
} from "../../responses/analytics.response";

type KoiosCcMemberInfo = {
  status: "authorized" | "resigned";
  ccHotId: string | null;
  ccColdId: string;
  expirationEpoch: number;
};

/**
 * GET /analytics/cc-participation
 * Returns CC member participation metrics.
 *
 * Participation rate is computed both:
 * - globally: proposalsVoted / totalProposals in scope
 * - within an inferred "active window": proposals voted within the member's window / proposals whose epoch window overlaps it
 *
 * When available, committee eligibility and expiration epochs are sourced from Koios; otherwise they are inferred from DB state.
 *
 * Query params:
 * - status: Filter by proposal status (optional, comma-separated)
 */
export const getCCParticipation = async (req: Request, res: Response) => {
  try {
    const statusFilter = (req.query.status as string)?.split(",").filter(Boolean);

    // Build proposal where clause
    const proposalWhere: any = {};
    if (statusFilter && statusFilter.length > 0) {
      proposalWhere.status = { in: statusFilter };
    }

    // Try to fetch committee roster from Koios so we can:
    // - determine current eligibility per member
    // - get member expiration_epoch (used for active-window calculations)
    // Fallback to cached DB count if Koios is unavailable.
    let eligibleMembers = 7;
    let eligibleCcIds: string[] | null = null;
    let currentEpoch: number | null = null;
    let koiosMemberInfoByColdId: Map<string, KoiosCcMemberInfo> | null = null;
    let koiosMemberInfoByHotId: Map<string, KoiosCcMemberInfo> | null = null;
    try {
      const [committeeInfo, tip] = await Promise.all([
        koiosGet<KoiosCommitteeInfo[]>("/committee_info"),
        koiosGet<KoiosTip[]>("/tip"),
      ]);

      currentEpoch = tip?.[0]?.epoch_no ?? 0;
      const members = committeeInfo?.[0]?.members ?? [];

      const normalizedMembers: KoiosCcMemberInfo[] = members.map((m) => ({
        status: m.status,
        ccHotId: m.cc_hot_id,
        ccColdId: m.cc_cold_id,
        expirationEpoch: m.expiration_epoch,
      }));

      const eligible = normalizedMembers.filter(
        (m) => m.status === "authorized" && m.expirationEpoch > currentEpoch!
      );

      eligibleMembers = eligible.length;
      eligibleCcIds = eligible
        .map((m) => m.ccHotId)
        .filter((id): id is string => Boolean(id));

      koiosMemberInfoByColdId = new Map(
        normalizedMembers.map((m) => [m.ccColdId, m])
      );
      koiosMemberInfoByHotId = new Map(
        normalizedMembers
          .filter((m) => Boolean(m.ccHotId))
          .map((m) => [m.ccHotId as string, m])
      );
    } catch (_e) {
      const committeeState = await prisma.committeeState.findUnique({
        where: { id: "current" },
      });
      eligibleMembers = committeeState?.eligibleMembers ?? 7;
      eligibleCcIds = null;
      currentEpoch = committeeState?.epoch ?? null;
      koiosMemberInfoByColdId = null;
      koiosMemberInfoByHotId = null;
    }

    const eligibleCcSet = new Set(eligibleCcIds ?? []);

    // Get total proposals in scope
    const totalProposals = await prisma.proposal.count({
      where: proposalWhere,
    });

    // Get all CC members
    const ccMembers = await prisma.cC.findMany({
      select: { ccId: true, memberName: true, status: true, coldCredential: true },
    });

    // Get proposal IDs in scope (+ metadata for first/last vote proposal lookups)
    const proposals = await prisma.proposal.findMany({
      where: proposalWhere,
      select: {
        proposalId: true,
        title: true,
        submissionEpoch: true,
        expirationEpoch: true,
        status: true,
      },
    });
    const proposalIds = proposals.map((p) => p.proposalId);
    const proposalById = new Map(proposals.map((p) => [p.proposalId, p]));

    // Get CC votes for proposals in scope (ordered latest-first)
    // We reuse this list for:
    // - proposals-voted counting (latest per member per proposal)
    // - lastVoteAt (first seen per member)
    // - firstVoteAt (last seen per member when iterating reverse)
    const ccVotes = await prisma.onchainVote.findMany({
      where: {
        proposalId: { in: proposalIds },
        voterType: VoterType.CC,
        ccId: { not: null },
        votedAt: { not: null },
      },
      select: {
        proposalId: true,
        ccId: true,
        votedAt: true,
        createdAt: true,
      },
      orderBy: [{ votedAt: "desc" }, { createdAt: "desc" }],
    });

    // Count distinct proposals voted per CC member (latest vote only)
    const ccProposalVotes = new Map<string, Set<string>>();
    const seenVotes = new Set<string>(); // ccId-proposalId combinations

    for (const vote of ccVotes) {
      const key = `${vote.ccId}-${vote.proposalId}`;
      if (!seenVotes.has(key)) {
        seenVotes.add(key);
        if (!ccProposalVotes.has(vote.ccId!)) {
          ccProposalVotes.set(vote.ccId!, new Set());
        }
        ccProposalVotes.get(vote.ccId!)!.add(vote.proposalId);
      }
    }

    // Compute last vote per CC member (latest-first list => first seen per ccId)
    const lastVoteByCc = new Map<string, { votedAt: Date; proposalId: string }>();
    for (const vote of ccVotes) {
      if (!vote.ccId || !vote.votedAt) continue;
      if (!lastVoteByCc.has(vote.ccId)) {
        lastVoteByCc.set(vote.ccId, {
          votedAt: vote.votedAt,
          proposalId: vote.proposalId,
        });
      }
    }

    // Compute first vote per CC member (scan reverse for earliest)
    const firstVoteByCc = new Map<string, { votedAt: Date; proposalId: string }>();
    for (let i = ccVotes.length - 1; i >= 0; i--) {
      const vote = ccVotes[i];
      if (!vote.ccId || !vote.votedAt) continue;
      if (!firstVoteByCc.has(vote.ccId)) {
        firstVoteByCc.set(vote.ccId, {
          votedAt: vote.votedAt,
          proposalId: vote.proposalId,
        });
      }
    }

    // Precompute proposal voting windows in epochs.
    // We use submissionEpoch as start and expirationEpoch as end; if missing, we can't reliably place it in a member window.
    // (This avoids penalizing members for proposals we can't confidently time-bound.)
    const proposalEpochWindows = proposals
      .map((p) => {
        if (p.submissionEpoch === null) return null;
        const endEpoch =
          p.expirationEpoch !== null
            ? p.expirationEpoch
            : currentEpoch !== null
            ? currentEpoch
            : null;
        if (endEpoch === null) return null;
        return {
          proposalId: p.proposalId,
          startEpoch: p.submissionEpoch,
          endEpoch,
        };
      })
      .filter(
        (
          v
        ): v is { proposalId: string; startEpoch: number; endEpoch: number } =>
          Boolean(v)
      );

    // Build member participation list
    const members: CCMemberParticipation[] = ccMembers.map((cc) => {
      const proposalsVoted = ccProposalVotes.get(cc.ccId)?.size ?? 0;
      const first = firstVoteByCc.get(cc.ccId);
      const last = lastVoteByCc.get(cc.ccId);

      const firstProposal = first ? proposalById.get(first.proposalId) : null;
      const lastProposal = last ? proposalById.get(last.proposalId) : null;

      // Determine eligibility + expiration epoch (when we can)
      const koiosInfo =
        cc.coldCredential && koiosMemberInfoByColdId
          ? koiosMemberInfoByColdId.get(cc.coldCredential)
          : null;
      const koiosInfoFallback =
        !koiosInfo && koiosMemberInfoByHotId
          ? koiosMemberInfoByHotId.get(cc.ccId)
          : null;
      const memberKoiosInfo = koiosInfo ?? koiosInfoFallback ?? null;

      const isEligible = eligibleCcIds ? eligibleCcSet.has(cc.ccId) : null;

      // Active window start: submission epoch of the first proposal they voted on (best available proxy for when they joined).
      // Active window end: if we can get their expiration_epoch from Koios, use it; otherwise if active, use currentEpoch.
      const firstWindowStartEpoch = firstProposal?.submissionEpoch ?? null;
      // If Koios roster is not available, we cannot know eligibility/expiration.
      // In that case, we infer a conservative end-of-window from the last epoch we observed them voting.
      const inferredLastVoteEpoch = lastProposal?.submissionEpoch ?? null;
      const windowEndEpoch =
        memberKoiosInfo?.expirationEpoch ??
        inferredLastVoteEpoch ??
        (currentEpoch !== null ? currentEpoch : null);

      let activeWindowTotalProposals = 0;
      let activeWindowProposalsVoted = 0;

      if (firstWindowStartEpoch !== null && windowEndEpoch !== null) {
        for (const w of proposalEpochWindows) {
          const overlaps =
            w.startEpoch <= windowEndEpoch && w.endEpoch >= firstWindowStartEpoch;
          if (!overlaps) continue;

          activeWindowTotalProposals++;

          // Count voted proposals within the same overlap window
          const votedProposals = ccProposalVotes.get(cc.ccId);
          if (votedProposals && votedProposals.has(w.proposalId)) {
            activeWindowProposalsVoted++;
          }
        }
      }

      const participationRatePctGlobal =
        totalProposals > 0
          ? Math.round((proposalsVoted / totalProposals) * 10000) / 100
          : 0;

      const participationRatePct =
        activeWindowTotalProposals > 0
          ? Math.round(
              (activeWindowProposalsVoted / activeWindowTotalProposals) * 10000
            ) / 100
          : 0;

      return {
        ccId: cc.ccId,
        memberName: cc.memberName,
        isEligible,
        dbStatus: cc.status ?? null,
        proposalsVoted,
        totalProposals,
        activeWindowProposalsVoted,
        activeWindowTotalProposals,
        participationRatePct,
        participationRatePctGlobal,

        firstVoteAt: first?.votedAt ? first.votedAt.toISOString() : null,
        firstVoteProposalId: first?.proposalId ?? null,
        firstVoteProposalTitle: firstProposal?.title ?? null,
        firstVoteProposalSubmissionEpoch: firstProposal?.submissionEpoch ?? null,
        firstVoteProposalStatus: firstProposal?.status ?? null,

        lastVoteAt: last?.votedAt ? last.votedAt.toISOString() : null,
        lastVoteProposalId: last?.proposalId ?? null,
        lastVoteProposalTitle: lastProposal?.title ?? null,
        lastVoteProposalSubmissionEpoch: lastProposal?.submissionEpoch ?? null,
        lastVoteProposalStatus: lastProposal?.status ?? null,
      };
    });

    // Sort by (window-based) participation rate descending
    members.sort((a, b) => b.participationRatePct - a.participationRatePct);

    // Calculate aggregate participation (window-based)
    const totalMemberVotes = members.reduce(
      (acc, m) => acc + m.activeWindowProposalsVoted,
      0
    );
    const totalPossibleVotes = members.reduce(
      (acc, m) => acc + m.activeWindowTotalProposals,
      0
    );
    const aggregateParticipationPct =
      totalPossibleVotes > 0
        ? Math.round((totalMemberVotes / totalPossibleVotes) * 10000) / 100
        : 0;

    const response: GetCCParticipationResponse = {
      members,
      aggregateParticipationPct,
      eligibleMembers,
      eligibleCcIds,
      totalProposals,
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching CC participation", error);
    res.status(500).json({
      error: "Failed to fetch CC participation",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
