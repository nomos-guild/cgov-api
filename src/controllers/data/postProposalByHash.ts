import { Request, Response } from "express";
import { AxiosInstance } from "axios";
import {
  GovernanceType,
  ProposalStatus,
  VoteType,
  VoterType,
} from "@prisma/client";
import { prisma, getKoiosService } from "../../services";

const CARDANO_GENESIS_UNIX = 1506203091;
const EPOCH_DURATION_SECONDS = 432000;
const DEFAULT_PAGE_SIZE = 100;
const BULK_REQUEST_CHUNK = 50;

interface KoiosProposalListItem {
  block_time?: number;
  proposal_id: string;
  proposal_tx_hash: string;
  proposal_index: number;
  proposal_type?: string;
  proposal_description?: unknown;
  deposit?: string | null;
  return_address?: string | null;
  proposed_epoch?: number | null;
  ratified_epoch?: number | null;
  enacted_epoch?: number | null;
  dropped_epoch?: number | null;
  expired_epoch?: number | null;
  expiration?: number | null;
  meta_url?: string | null;
  meta_hash?: string | null;
  meta_json?: unknown;
}

interface KoiosProposalVote {
  block_time?: number;
  voter_role: string;
  voter_id: string;
  voter_hex?: string | null;
  voter_has_script?: boolean | null;
  vote: string;
  meta_url?: string | null;
  meta_hash?: string | null;
}

interface KoiosDrepVote {
  proposal_id: string;
  proposal_tx_hash: string;
  proposal_index: number;
  vote_tx_hash: string;
  block_time?: number;
  vote: string;
  meta_url?: string | null;
  meta_hash?: string | null;
}

interface KoiosPoolVote extends KoiosDrepVote {}

interface KoiosCommitteeVote extends KoiosDrepVote {}

interface KoiosDrepInfo {
  drep_id: string;
  hex?: string | null;
  amount?: string | null;
}

interface KoiosPoolMetadata {
  name?: string | null;
  ticker?: string | null;
}

interface KoiosPoolInfo {
  pool_id_bech32: string;
  pool_id_hex?: string | null;
  active_stake?: string | null;
  meta_json?: KoiosPoolMetadata | null;
}

interface KoiosCommitteeMember {
  status?: string | null;
  cc_hot_id: string;
  cc_cold_id?: string | null;
  cc_hot_hex?: string | null;
  cc_cold_hex?: string | null;
}

interface KoiosCommitteeInfo {
  members?: KoiosCommitteeMember[];
}

interface KoiosVotingPowerEntry {
  amount?: string | null;
  epoch_no?: number;
}

interface VotePayload {
  txHash: string;
  vote: VoteType;
  voterType: VoterType;
  votingPower: string | null;
  votingPowerAda: number | null;
  anchorUrl: string | null;
  anchorHash: string | null;
  votedAt: Date;
  drepKey?: string;
  spoKey?: string;
  ccKey?: string;
}

const governanceTypeMap: Record<string, GovernanceType> = {
  ParameterChange: GovernanceType.PROTOCOL_PARAMETER_CHANGE,
  HardForkInitiation: GovernanceType.HARD_FORK,
  TreasuryWithdrawals: GovernanceType.TREASURY,
  NoConfidence: GovernanceType.NO_CONFIDENCE,
  NewCommittee: GovernanceType.UPDATE_COMMITTEE,
  NewConstitution: GovernanceType.CONSTITUTION,
  InfoAction: GovernanceType.INFO,
};

const drepVoteCache = new Map<string, Map<string, KoiosDrepVote>>();
const poolVoteCache = new Map<string, Map<string, KoiosPoolVote>>();
const committeeVoteCache = new Map<string, Map<string, KoiosCommitteeVote>>();
const drepVotingPowerCache = new Map<string, Map<number, string | null>>();
const poolVotingPowerCache = new Map<string, Map<number, string | null>>();

const chunkArray = <T,>(items: T[], size: number): T[][] => {
  if (size <= 0) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const toEpochFromUnix = (value?: number | null): number | undefined => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }

  const delta = value - CARDANO_GENESIS_UNIX;
  if (delta < 0) {
    return undefined;
  }

  return Math.floor(delta / EPOCH_DURATION_SECONDS);
};

const toDateFromUnix = (value?: number | null): Date => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000);
  }
  return new Date();
};

const lovelaceToAda = (value?: string | null): number | null => {
  if (!value) {
    return null;
  }

  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return null;
  }

  return numeric / 1_000_000;
};

const mapGovernanceType = (value?: string | null): GovernanceType => {
  if (value && governanceTypeMap[value]) {
    return governanceTypeMap[value];
  }
  return GovernanceType.INFO;
};

const deriveStatus = (proposal: KoiosProposalListItem): ProposalStatus => {
  if (proposal.expired_epoch !== null && proposal.expired_epoch !== undefined) {
    return ProposalStatus.EXPIRED;
  }

  if (proposal.dropped_epoch !== null && proposal.dropped_epoch !== undefined) {
    return ProposalStatus.NOT_APPROVED;
  }

  if (proposal.enacted_epoch !== null && proposal.enacted_epoch !== undefined) {
    return ProposalStatus.APPROVED;
  }

  if (proposal.ratified_epoch !== null && proposal.ratified_epoch !== undefined) {
    return ProposalStatus.RATIFIED;
  }

  return ProposalStatus.ACTIVE;
};

const mapVoteType = (value?: string | null): VoteType => {
  if (value === "Yes") {
    return VoteType.YES;
  }
  if (value === "No") {
    return VoteType.NO;
  }
  return VoteType.ABSTAIN;
};

const mapVoterType = (value?: string | null): VoterType => {
  if (value === "DRep") {
    return VoterType.DREP;
  }
  if (value === "SPO") {
    return VoterType.SPO;
  }
  return VoterType.CC;
};

const parseMetadataFields = (
  metadata: unknown
): { title?: string; description?: string; rationale?: string } => {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }

  const metaObj = metadata as Record<string, unknown>;
  const bodyCandidate =
    metaObj.body && typeof metaObj.body === "object"
      ? (metaObj.body as Record<string, unknown>)
      : undefined;

  const contents = Array.isArray(metaObj.contents)
    ? (metaObj.contents as unknown[])
    : undefined;

  const firstContentBody =
    contents && contents.length && contents[0]
      ? (contents[0] as Record<string, unknown>)
      : undefined;

  const resolvedBody =
    firstContentBody && typeof firstContentBody.body === "object"
      ? (firstContentBody.body as Record<string, unknown>)
      : bodyCandidate;

  const title =
    (resolvedBody?.title as string) ??
    (metaObj.title as string) ??
    undefined;

  const description =
    (resolvedBody?.abstract as string) ??
    (resolvedBody?.motivation as string) ??
    undefined;

  const rationale = resolvedBody?.rationale as string | undefined;

  return {
    title,
    description,
    rationale,
  };
};

const normalizeIdentifier = (value: string) => value.trim();

const proposalMatchesIdentifier = (
  proposal: KoiosProposalListItem,
  identifier: string,
  txFragment?: string,
  idxFragment?: string
) => {
  if (proposal.proposal_id === identifier) {
    return true;
  }

  if (proposal.proposal_tx_hash === identifier) {
    return true;
  }

  if (
    txFragment
    && idxFragment !== undefined
    && proposal.proposal_tx_hash === txFragment
    && proposal.proposal_index?.toString() === idxFragment
  ) {
    return true;
  }

  return false;
};

const fetchProposalByIdentifier = async (
  client: AxiosInstance,
  identifier: string
): Promise<KoiosProposalListItem | null> => {
  const normalized = normalizeIdentifier(identifier);
  if (!normalized) {
    return null;
  }

  const [hashSegment, indexSegment] = normalized.split(":");

  let offset = 0;
  while (true) {
    const { data } = await client.get<KoiosProposalListItem[]>(
      "/proposal_list",
      {
        params: {
          limit: DEFAULT_PAGE_SIZE,
          offset,
        },
      }
    );

    if (!Array.isArray(data) || !data.length) {
      break;
    }

    const match = data.find((proposal) =>
      proposalMatchesIdentifier(
        proposal,
        normalized,
        hashSegment,
        indexSegment
      )
    );

    if (match) {
      return match;
    }

    if (data.length < DEFAULT_PAGE_SIZE) {
      break;
    }

    offset += DEFAULT_PAGE_SIZE;
  }

  return null;
};

const fetchProposalVotes = async (
  client: AxiosInstance,
  proposalId: string
): Promise<KoiosProposalVote[]> => {
  const results: KoiosProposalVote[] = [];
  let offset = 0;

  while (true) {
    const { data } = await client.get<KoiosProposalVote[]>(
      "/proposal_votes",
      {
        params: {
          _proposal_id: proposalId,
          limit: DEFAULT_PAGE_SIZE,
          offset,
        },
      }
    );

    if (!Array.isArray(data) || !data.length) {
      break;
    }

    results.push(...data);

    if (data.length < DEFAULT_PAGE_SIZE) {
      break;
    }

    offset += DEFAULT_PAGE_SIZE;
  }

  return results;
};

const fetchDrepVoteDetail = async (
  client: AxiosInstance,
  drepId: string,
  proposalId: string
): Promise<KoiosDrepVote | null> => {
  const cached = drepVoteCache.get(drepId)?.get(proposalId);
  if (cached) {
    return cached;
  }

  let offset = 0;
  let found: KoiosDrepVote | null = null;

  while (!found) {
    const { data } = await client.get<KoiosDrepVote[]>("/drep_votes", {
      params: {
        _drep_id: drepId,
        limit: DEFAULT_PAGE_SIZE,
        offset,
      },
    });

    if (!Array.isArray(data) || !data.length) {
      break;
    }

    let cache = drepVoteCache.get(drepId);
    if (!cache) {
      cache = new Map();
      drepVoteCache.set(drepId, cache);
    }

    for (const entry of data) {
      cache.set(entry.proposal_id, entry);
      if (!found && entry.proposal_id === proposalId) {
        found = entry;
      }
    }

    if (data.length < DEFAULT_PAGE_SIZE) {
      break;
    }

    offset += DEFAULT_PAGE_SIZE;
  }

  return found;
};

const fetchPoolVoteDetail = async (
  client: AxiosInstance,
  poolId: string,
  proposalId: string
): Promise<KoiosPoolVote | null> => {
  const cached = poolVoteCache.get(poolId)?.get(proposalId);
  if (cached) {
    return cached;
  }

  let offset = 0;
  let found: KoiosPoolVote | null = null;

  while (!found) {
    const { data } = await client.get<KoiosPoolVote[]>("/pool_votes", {
      params: {
        _pool_bech32: poolId,
        limit: DEFAULT_PAGE_SIZE,
        offset,
      },
    });

    if (!Array.isArray(data) || !data.length) {
      break;
    }

    let cache = poolVoteCache.get(poolId);
    if (!cache) {
      cache = new Map();
      poolVoteCache.set(poolId, cache);
    }

    for (const entry of data) {
      cache.set(entry.proposal_id, entry);
      if (!found && entry.proposal_id === proposalId) {
        found = entry;
      }
    }

    if (data.length < DEFAULT_PAGE_SIZE) {
      break;
    }

    offset += DEFAULT_PAGE_SIZE;
  }

  return found;
};

const fetchCommitteeVoteDetail = async (
  client: AxiosInstance,
  ccHotId: string,
  proposalId: string
): Promise<KoiosCommitteeVote | null> => {
  const cached = committeeVoteCache.get(ccHotId)?.get(proposalId);
  if (cached) {
    return cached;
  }

  let offset = 0;
  let found: KoiosCommitteeVote | null = null;

  while (!found) {
    const { data } = await client.get<KoiosCommitteeVote[]>(
      "/committee_votes",
      {
        params: {
          _cc_hot_id: ccHotId,
          limit: DEFAULT_PAGE_SIZE,
          offset,
        },
      }
    );

    if (!Array.isArray(data) || !data.length) {
      break;
    }

    let cache = committeeVoteCache.get(ccHotId);
    if (!cache) {
      cache = new Map();
      committeeVoteCache.set(ccHotId, cache);
    }

    for (const entry of data) {
      cache.set(entry.proposal_id, entry);
      if (!found && entry.proposal_id === proposalId) {
        found = entry;
      }
    }

    if (data.length < DEFAULT_PAGE_SIZE) {
      break;
    }

    offset += DEFAULT_PAGE_SIZE;
  }

  return found;
};

const fetchDrepVotingPower = async (
  client: AxiosInstance,
  drepId: string,
  epoch?: number
): Promise<string | null> => {
  if (epoch === undefined) {
    return null;
  }

  let cache = drepVotingPowerCache.get(drepId);
  if (cache && cache.has(epoch)) {
    return cache.get(epoch) ?? null;
  }

  const { data } = await client.get<KoiosVotingPowerEntry[]>(
    "/drep_voting_power_history",
    {
      params: {
        _drep_id: drepId,
        _epoch_no: epoch,
      },
    }
  );

  const amount = Array.isArray(data) && data.length ? data[0]?.amount ?? null : null;

  if (!cache) {
    cache = new Map();
    drepVotingPowerCache.set(drepId, cache);
  }
  cache.set(epoch, amount);

  return amount;
};

const fetchPoolVotingPower = async (
  client: AxiosInstance,
  poolId: string,
  epoch?: number
): Promise<string | null> => {
  if (epoch === undefined) {
    return null;
  }

  let cache = poolVotingPowerCache.get(poolId);
  if (cache && cache.has(epoch)) {
    return cache.get(epoch) ?? null;
  }

  const { data } = await client.get<KoiosVotingPowerEntry[]>(
    "/pool_voting_power_history",
    {
      params: {
        _pool_bech32: poolId,
        _epoch_no: epoch,
      },
    }
  );

  const amount = Array.isArray(data) && data.length ? data[0]?.amount ?? null : null;

  if (!cache) {
    cache = new Map();
    poolVotingPowerCache.set(poolId, cache);
  }
  cache.set(epoch, amount);

  return amount;
};

const fetchDrepInfoMap = async (
  client: AxiosInstance,
  drepIds: string[]
): Promise<Map<string, KoiosDrepInfo>> => {
  const map = new Map<string, KoiosDrepInfo>();
  if (!drepIds.length) {
    return map;
  }

  for (const chunk of chunkArray(drepIds, BULK_REQUEST_CHUNK)) {
    const { data } = await client.post<KoiosDrepInfo[]>("/drep_info", {
      _drep_ids: chunk,
    });

    if (Array.isArray(data)) {
      data.forEach((entry) => map.set(entry.drep_id, entry));
    }
  }

  return map;
};

const fetchPoolInfoMap = async (
  client: AxiosInstance,
  poolIds: string[]
): Promise<Map<string, KoiosPoolInfo>> => {
  const map = new Map<string, KoiosPoolInfo>();
  if (!poolIds.length) {
    return map;
  }

  for (const chunk of chunkArray(poolIds, BULK_REQUEST_CHUNK)) {
    const { data } = await client.post<KoiosPoolInfo[]>("/pool_info", {
      _pool_bech32_ids: chunk,
    });

    if (Array.isArray(data)) {
      data.forEach((entry) => map.set(entry.pool_id_bech32, entry));
    }
  }

  return map;
};

const fetchCommitteeInfoMap = async (
  client: AxiosInstance,
  ccIds: string[]
): Promise<Map<string, KoiosCommitteeMember>> => {
  const map = new Map<string, KoiosCommitteeMember>();
  if (!ccIds.length) {
    return map;
  }

  const targets = new Set(ccIds);
  const { data } = await client.get<KoiosCommitteeInfo[]>("/committee_info");

  if (!Array.isArray(data)) {
    return map;
  }

  data.forEach((entry) => {
    entry.members?.forEach((member) => {
      if (targets.has(member.cc_hot_id)) {
        map.set(member.cc_hot_id, member);
      }
    });
  });

  return map;
};

const buildVotePayloads = async (
  client: AxiosInstance,
  proposal: KoiosProposalListItem,
  votes: KoiosProposalVote[]
): Promise<VotePayload[]> => {
  const payloads = await Promise.all(
    votes.map(async (vote) => {
      const voteType = mapVoteType(vote.vote);
      const voterType = mapVoterType(vote.voter_role);

      if (voterType === VoterType.DREP) {
        const detail = await fetchDrepVoteDetail(
          client,
          vote.voter_id,
          proposal.proposal_id
        );
        const blockTime = detail?.block_time ?? vote.block_time;
        const epoch = toEpochFromUnix(blockTime);
        const votingPower = await fetchDrepVotingPower(
          client,
          vote.voter_id,
          epoch
        );

        return {
          txHash:
            detail?.vote_tx_hash ?? `${proposal.proposal_tx_hash}:${vote.voter_id}`,
          vote: voteType,
          voterType,
          votingPower,
          votingPowerAda: lovelaceToAda(votingPower),
          anchorUrl: vote.meta_url ?? detail?.meta_url ?? null,
          anchorHash: vote.meta_hash ?? detail?.meta_hash ?? null,
          votedAt: toDateFromUnix(blockTime),
          drepKey: vote.voter_id,
        } satisfies VotePayload;
      }

      if (voterType === VoterType.SPO) {
        const detail = await fetchPoolVoteDetail(
          client,
          vote.voter_id,
          proposal.proposal_id
        );
        const blockTime = detail?.block_time ?? vote.block_time;
        const epoch = toEpochFromUnix(blockTime);
        const votingPower = await fetchPoolVotingPower(
          client,
          vote.voter_id,
          epoch
        );

        return {
          txHash:
            detail?.vote_tx_hash ?? `${proposal.proposal_tx_hash}:${vote.voter_id}`,
          vote: voteType,
          voterType,
          votingPower,
          votingPowerAda: lovelaceToAda(votingPower),
          anchorUrl: vote.meta_url ?? detail?.meta_url ?? null,
          anchorHash: vote.meta_hash ?? detail?.meta_hash ?? null,
          votedAt: toDateFromUnix(blockTime),
          spoKey: vote.voter_id,
        } satisfies VotePayload;
      }

      const detail = await fetchCommitteeVoteDetail(
        client,
        vote.voter_id,
        proposal.proposal_id
      );
      const blockTime = detail?.block_time ?? vote.block_time;

      return {
        txHash:
          detail?.vote_tx_hash ?? `${proposal.proposal_tx_hash}:${vote.voter_id}`,
        vote: voteType,
        voterType,
        votingPower: null,
        votingPowerAda: null,
        anchorUrl: vote.meta_url ?? detail?.meta_url ?? null,
        anchorHash: vote.meta_hash ?? detail?.meta_hash ?? null,
        votedAt: toDateFromUnix(blockTime),
        ccKey: vote.voter_id,
      } satisfies VotePayload;
    })
  );

  return payloads;
};

export const postProposalByHash = async (req: Request, res: Response) => {
  try {
    const proposalIdentifier = req.params.proposal_hash;

    if (!proposalIdentifier) {
      return res.status(400).json({
        error: "Missing proposal identifier",
        message: "Provide a proposal hash, CIP id, or txHash:index",
      });
    }

    const koios = getKoiosService();

    const proposal = await fetchProposalByIdentifier(koios, proposalIdentifier);

    if (!proposal) {
      return res.status(404).json({
        error: "Proposal not found",
        message: `No Koios proposal found for identifier ${proposalIdentifier}`,
      });
    }

    const votes = await fetchProposalVotes(koios, proposal.proposal_id);
    const votePayloads = votes.length
      ? await buildVotePayloads(koios, proposal, votes)
      : [];

    const drepIds = Array.from(
      new Set(
        votePayloads
          .filter((payload) => payload.drepKey)
          .map((payload) => payload.drepKey as string)
      )
    );
    const poolIds = Array.from(
      new Set(
        votePayloads
          .filter((payload) => payload.spoKey)
          .map((payload) => payload.spoKey as string)
      )
    );
    const committeeIds = Array.from(
      new Set(
        votePayloads
          .filter((payload) => payload.ccKey)
          .map((payload) => payload.ccKey as string)
      )
    );

    const [drepInfoMap, poolInfoMap, committeeInfoMap] = await Promise.all([
      fetchDrepInfoMap(koios, drepIds),
      fetchPoolInfoMap(koios, poolIds),
      fetchCommitteeInfoMap(koios, committeeIds),
    ]);

    const proposalData = (() => {
      const metadataFields = parseMetadataFields(proposal.meta_json);
      return {
        proposalId: proposal.proposal_id,
        txHash: proposal.proposal_tx_hash,
        certIndex: proposal.proposal_index.toString(),
        title:
          metadataFields.title ?? proposal.proposal_type ?? proposal.proposal_id,
        description: metadataFields.description ?? null,
        rationale: metadataFields.rationale ?? null,
        governanceActionType: mapGovernanceType(proposal.proposal_type),
        status: deriveStatus(proposal),
        submissionEpoch: proposal.proposed_epoch ?? null,
        expiryEpoch: proposal.expiration ?? null,
        metadata: proposal.meta_json ? JSON.stringify(proposal.meta_json) : null,
      };
    })();

    const result = await prisma.$transaction(async (tx) => {
      const storedProposal = await tx.proposal.upsert({
        where: { proposalId: proposalData.proposalId },
        update: proposalData,
        create: proposalData,
      });

      const drepRecords = new Map<string, { id: string }>();
      for (const drepId of drepIds) {
        const info = drepInfoMap.get(drepId);
        const stakeKey = info?.hex ?? drepId;
        const record = await tx.drep.upsert({
          where: { drepId },
          update: {
            stakeKey,
            votingPower: lovelaceToAda(info?.amount) ?? 0,
          },
          create: {
            drepId,
            stakeKey,
            votingPower: lovelaceToAda(info?.amount) ?? 0,
          },
        });
        drepRecords.set(drepId, record);
      }

      const spoRecords = new Map<string, { id: string }>();
      for (const poolId of poolIds) {
        const info = poolInfoMap.get(poolId);
        const meta = info?.meta_json;
        const poolName = meta?.name ?? poolId;
        const ticker = meta?.ticker ?? null;
        const votingPower = lovelaceToAda(info?.active_stake) ?? 0;

        const record = await tx.sPO.upsert({
          where: { poolId },
          update: {
            poolName,
            ticker,
            votingPower,
          },
          create: {
            poolId,
            poolName,
            ticker,
            votingPower,
          },
        });
        spoRecords.set(poolId, record);
      }

      const committeeRecords = new Map<string, { id: string }>();
      for (const ccId of committeeIds) {
        const info = committeeInfoMap.get(ccId);

        const record = await tx.cC.upsert({
          where: { ccId },
          update: {
            memberName: info?.cc_cold_id ?? ccId,
            hotCredential: info?.cc_hot_hex ?? null,
            coldCredential: info?.cc_cold_hex ?? null,
            status: info?.status ?? null,
          },
          create: {
            ccId,
            memberName: info?.cc_cold_id ?? ccId,
            hotCredential: info?.cc_hot_hex ?? null,
            coldCredential: info?.cc_cold_hex ?? null,
            status: info?.status ?? null,
          },
        });
        committeeRecords.set(ccId, record);
      }

      await tx.onchainVote.deleteMany({ where: { proposalId: storedProposal.id } });

      if (votePayloads.length) {
        await tx.onchainVote.createMany({
          data: votePayloads.map((payload) => ({
            txHash: payload.txHash,
            vote: payload.vote,
            voterType: payload.voterType,
            votingPower: payload.votingPower,
            votingPowerAda: payload.votingPowerAda,
            anchorUrl: payload.anchorUrl,
            anchorHash: payload.anchorHash,
            votedAt: payload.votedAt,
            proposalId: storedProposal.id,
            drepId: payload.drepKey
              ? drepRecords.get(payload.drepKey)?.id ?? null
              : null,
            spoId: payload.spoKey
              ? spoRecords.get(payload.spoKey)?.id ?? null
              : null,
            ccId: payload.ccKey
              ? committeeRecords.get(payload.ccKey)?.id ?? null
              : null,
          })),
        });
      }

      return { storedProposal, voteCount: votePayloads.length };
    });

    return res.status(200).json({
      proposalId: result.storedProposal.proposalId,
      txHash: result.storedProposal.txHash,
      votesIngested: result.voteCount,
    });
  } catch (error) {
    console.error("Failed to ingest proposal", error);
    return res.status(500).json({
      error: "Failed to ingest proposal",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
