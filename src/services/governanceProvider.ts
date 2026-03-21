import {
  getKoiosProposalList,
  koiosGet,
  koiosPost,
  type KoiosRequestContext,
} from "./koios";
import {
  KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_SIZE,
  KOIOS_DREP_DELEGATORS_PAGE_SIZE,
  KOIOS_DREP_LIST_PAGE_SIZE,
  KOIOS_TX_INFO_BATCH_SIZE,
  chunkArray,
} from "./ingestion/sync-utils";
import type {
  KoiosAccountUpdateHistoryEntry,
  KoiosCommitteeInfo,
  KoiosDrepDelegator,
  KoiosDrepEpochSummary,
  KoiosDrepInfo,
  KoiosDrepListEntry,
  KoiosDrepUpdate,
  KoiosDrepVotingPower,
  KoiosEpochInfo,
  KoiosPoolGroup,
  KoiosProposal,
  KoiosProposalVotingSummary,
  KoiosSpoVotingPower,
  KoiosTip,
  KoiosTotals,
  KoiosTxInfo,
  KoiosVote,
} from "../types/koios.types";

export interface GovernanceProviderOptions {
  source?: string;
}

export interface TxInfoBatchOptions extends GovernanceProviderOptions {
  includeInputs?: boolean;
  includeMetadata?: boolean;
  includeAssets?: boolean;
  includeWithdrawals?: boolean;
  includeCerts?: boolean;
  includeScripts?: boolean;
  includeBytecode?: boolean;
}

const KOIOS_DREP_UPDATES_PAGE_SIZE = 1000;
const KOIOS_POOL_GROUPS_PAGE_SIZE = 1000;

function toKoiosContext(
  options?: GovernanceProviderOptions
): KoiosRequestContext | undefined {
  if (!options?.source) {
    return undefined;
  }
  return { source: options.source };
}

async function collectPaginated<T>(options: {
  pageSize: number;
  fetchPage: (params: { offset: number; limit: number }) => Promise<T[]>;
}): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await options.fetchPage({
      offset,
      limit: options.pageSize,
    });

    if (!page || page.length === 0) {
      hasMore = false;
      continue;
    }

    rows.push(...page);
    offset += page.length;
    hasMore = page.length === options.pageSize;
  }

  return rows;
}

export async function listProposals(options?: {
  source?: string;
  interactiveCache?: boolean;
  forceRefresh?: boolean;
}): Promise<KoiosProposal[]> {
  if (options?.interactiveCache) {
    return getKoiosProposalList({
      context: toKoiosContext(options),
      interactiveCache: true,
      forceRefresh: options.forceRefresh,
    });
  }

  return koiosGet<KoiosProposal[]>(
    "/proposal_list",
    undefined,
    toKoiosContext(options)
  );
}

export async function listVotes(options?: {
  proposalId?: string;
  minEpoch?: number;
  offset?: number;
  limit?: number;
  order?: string;
  source?: string;
}): Promise<KoiosVote[]> {
  const params: Record<string, string | number> = {
    limit: options?.limit ?? 1000,
    offset: options?.offset ?? 0,
    order: options?.order ?? "block_time.asc,vote_tx_hash.asc",
  };

  if (options?.proposalId) {
    params.proposal_id = `eq.${options.proposalId}`;
  }

  if (typeof options?.minEpoch === "number") {
    params.epoch_no = `gte.${options.minEpoch}`;
  }

  return koiosGet<KoiosVote[]>("/vote_list", params, toKoiosContext(options));
}

export async function getProposalVotingSummary(
  proposalId: string,
  options?: GovernanceProviderOptions
): Promise<KoiosProposalVotingSummary | null> {
  const summaries = await koiosGet<KoiosProposalVotingSummary[]>(
    `/proposal_voting_summary?_proposal_id=${proposalId}`,
    undefined,
    toKoiosContext(options)
  );
  return summaries?.[0] ?? null;
}

async function getEpochScopedFirstRow<T extends { epoch_no: number }>(
  endpoint: string,
  epochNo: number,
  options?: GovernanceProviderOptions
): Promise<T | null> {
  const attempts: Array<() => Promise<T[]>> = [
    () =>
      koiosGet<T[]>(
        endpoint,
        { _epoch_no: epochNo },
        toKoiosContext(options)
      ),
    () =>
      koiosGet<T[]>(
        endpoint,
        { epoch_no: `eq.${epochNo}` },
        toKoiosContext(options)
      ),
  ];

  for (const attempt of attempts) {
    try {
      const rows = await attempt();
      const row = rows?.find((entry) => entry?.epoch_no === epochNo) ?? rows?.[0];
      if (row?.epoch_no === epochNo) {
        return row;
      }
    } catch {
      // Try the next filtering style when Koios rejects one form.
    }
  }

  return null;
}

export async function getDrepEpochSummary(
  epochNo: number,
  options?: GovernanceProviderOptions
): Promise<KoiosDrepEpochSummary | null> {
  const summaries = await koiosGet<KoiosDrepEpochSummary[]>(
    `/drep_epoch_summary?_epoch_no=${epochNo}`,
    undefined,
    toKoiosContext(options)
  );
  return summaries?.[0] ?? null;
}

export async function getTotalsForEpoch(
  epochNo: number,
  options?: GovernanceProviderOptions
): Promise<KoiosTotals | null> {
  return getEpochScopedFirstRow<KoiosTotals>("/totals", epochNo, options);
}

export async function getEpochInfo(
  epochNo: number,
  options?: GovernanceProviderOptions
): Promise<KoiosEpochInfo | null> {
  return getEpochScopedFirstRow<KoiosEpochInfo>("/epoch_info", epochNo, options);
}

export async function listPoolVotingPowerHistory(options: {
  epochNo: number;
  poolId?: string;
  offset?: number;
  limit?: number;
  source?: string;
}): Promise<KoiosSpoVotingPower[]> {
  const params: Record<string, string | number> = {
    _epoch_no: options.epochNo,
    limit: options.limit ?? 1000,
    offset: options.offset ?? 0,
  };

  if (options.poolId) {
    params._pool_bech32 = options.poolId;
  }

  return koiosGet<KoiosSpoVotingPower[]>(
    "/pool_voting_power_history",
    params,
    toKoiosContext(options)
  );
}

export async function listPoolVotingPowerHistoryForEpoch(options: {
  epochNo: number;
  offset?: number;
  limit?: number;
  source?: string;
}): Promise<KoiosSpoVotingPower[]> {
  const attempts: Array<() => Promise<KoiosSpoVotingPower[]>> = [
    () =>
      koiosGet<KoiosSpoVotingPower[]>(
        "/pool_voting_power_history",
        {
          epoch_no: `eq.${options.epochNo}`,
          order: "pool_id_bech32.asc",
          limit: options.limit ?? 1000,
          offset: options.offset ?? 0,
        },
        toKoiosContext(options)
      ),
    () =>
      koiosGet<KoiosSpoVotingPower[]>(
        "/pool_voting_power_history",
        {
          epoch_no: `eq.${options.epochNo}`,
          limit: options.limit ?? 1000,
          offset: options.offset ?? 0,
        },
        toKoiosContext(options)
      ),
    () =>
      koiosGet<KoiosSpoVotingPower[]>(
        "/pool_voting_power_history",
        {
          _epoch_no: options.epochNo,
          order: "pool_id_bech32.asc",
          limit: options.limit ?? 1000,
          offset: options.offset ?? 0,
        },
        toKoiosContext(options)
      ),
    () =>
      koiosGet<KoiosSpoVotingPower[]>(
        "/pool_voting_power_history",
        {
          _epoch_no: options.epochNo,
          limit: options.limit ?? 1000,
          offset: options.offset ?? 0,
        },
        toKoiosContext(options)
      ),
  ];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export async function listDrepVotingPowerHistory(options: {
  epochNo: number;
  drepId?: string;
  offset?: number;
  limit?: number;
  source?: string;
}): Promise<KoiosDrepVotingPower[]> {
  const params: Record<string, string | number> = {
    _epoch_no: options.epochNo,
    limit: options.limit ?? 1000,
    offset: options.offset ?? 0,
  };

  if (options.drepId) {
    params._drep_id = options.drepId;
  }

  return koiosGet<KoiosDrepVotingPower[]>(
    "/drep_voting_power_history",
    params,
    toKoiosContext(options)
  );
}

export async function listDrepDelegators(options: {
  drepId: string;
  epochNo?: number;
  offset?: number;
  limit?: number;
  source?: string;
}): Promise<KoiosDrepDelegator[]> {
  const params: Record<string, string | number> = {
    _drep_id: options.drepId,
    limit: options.limit ?? 1000,
    offset: options.offset ?? 0,
  };

  if (typeof options.epochNo === "number") {
    params.epoch_no = `eq.${options.epochNo}`;
  }

  return koiosGet<KoiosDrepDelegator[]>(
    "/drep_delegators",
    params,
    toKoiosContext(options)
  );
}

export async function listAllDrepDelegators(options: {
  drepId: string;
  epochNo?: number;
  source?: string;
}): Promise<KoiosDrepDelegator[]> {
  return collectPaginated({
    pageSize: KOIOS_DREP_DELEGATORS_PAGE_SIZE,
    fetchPage: ({ offset, limit }) =>
      listDrepDelegators({
        ...options,
        offset,
        limit,
      }),
  });
}

export async function getCommitteeInfo(
  options?: GovernanceProviderOptions
): Promise<KoiosCommitteeInfo | null> {
  const committeeInfo = await koiosGet<KoiosCommitteeInfo[]>(
    "/committee_info",
    undefined,
    toKoiosContext(options)
  );
  return committeeInfo?.[0] ?? null;
}

export async function getDrepInfoBatchFromKoios(
  drepIds: string[],
  options?: GovernanceProviderOptions
): Promise<KoiosDrepInfo[]> {
  if (drepIds.length === 0) {
    return [];
  }

  return koiosPost<KoiosDrepInfo[]>(
    "/drep_info",
    { _drep_ids: drepIds },
    toKoiosContext(options)
  );
}

export async function listDreps(options?: {
  offset?: number;
  limit?: number;
  source?: string;
}): Promise<KoiosDrepListEntry[]> {
  return koiosGet<KoiosDrepListEntry[]>(
    "/drep_list",
    {
      limit: options?.limit ?? KOIOS_DREP_LIST_PAGE_SIZE,
      offset: options?.offset ?? 0,
    },
    toKoiosContext(options)
  );
}

export async function listAllDrepIds(
  options?: GovernanceProviderOptions
): Promise<string[]> {
  const rows = await collectPaginated({
    pageSize: KOIOS_DREP_LIST_PAGE_SIZE,
    fetchPage: ({ offset, limit }) =>
      listDreps({
        offset,
        limit,
        source: options?.source,
      }),
  });

  return rows
    .map((row) => row?.drep_id)
    .filter((drepId): drepId is string => typeof drepId === "string" && drepId.length > 0);
}

export async function listDrepUpdates(options: {
  drepId: string;
  offset?: number;
  limit?: number;
  source?: string;
}): Promise<KoiosDrepUpdate[]> {
  return koiosGet<KoiosDrepUpdate[]>(
    "/drep_updates",
    {
      _drep_id: options.drepId,
      limit: options.limit ?? KOIOS_DREP_UPDATES_PAGE_SIZE,
      offset: options.offset ?? 0,
    },
    toKoiosContext(options)
  );
}

export async function listAllDrepUpdates(
  drepId: string,
  options?: GovernanceProviderOptions
): Promise<KoiosDrepUpdate[]> {
  return collectPaginated({
    pageSize: KOIOS_DREP_UPDATES_PAGE_SIZE,
    fetchPage: ({ offset, limit }) =>
      listDrepUpdates({
        drepId,
        offset,
        limit,
        source: options?.source,
      }),
  });
}

export async function getDrepUpdates(
  drepId: string,
  options?: GovernanceProviderOptions
): Promise<KoiosDrepUpdate[]> {
  return koiosGet<KoiosDrepUpdate[]>(
    "/drep_updates",
    { _drep_id: drepId },
    toKoiosContext(options)
  );
}

export async function getCurrentEpochFromKoios(
  options?: GovernanceProviderOptions
): Promise<number> {
  const tip = await koiosGet<KoiosTip[]>("/tip", undefined, toKoiosContext(options));
  return tip?.[0]?.epoch_no ?? 0;
}

export async function getAccountUpdateHistoryBatch(
  stakeAddresses: string[],
  options?: GovernanceProviderOptions
): Promise<KoiosAccountUpdateHistoryEntry[]> {
  const uniqueStakeAddresses = Array.from(
    new Set(stakeAddresses.filter((address): address is string => Boolean(address)))
  );
  if (uniqueStakeAddresses.length === 0) {
    return [];
  }

  const rows: KoiosAccountUpdateHistoryEntry[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await koiosPost<KoiosAccountUpdateHistoryEntry[]>(
      `/account_update_history?offset=${offset}&limit=${KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_SIZE}`,
      { _stake_addresses: uniqueStakeAddresses },
      toKoiosContext(options)
    );

    if (!page || page.length === 0) {
      hasMore = false;
      continue;
    }

    rows.push(...page);
    offset += page.length;
    hasMore = page.length === KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_SIZE;
  }

  return rows;
}

function buildTxInfoRequestBody(
  txHashes: string[],
  options?: TxInfoBatchOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    _tx_hashes: txHashes,
  };

  if (typeof options?.includeInputs === "boolean") {
    body._inputs = options.includeInputs;
  }
  if (typeof options?.includeMetadata === "boolean") {
    body._metadata = options.includeMetadata;
  }
  if (typeof options?.includeAssets === "boolean") {
    body._assets = options.includeAssets;
  }
  if (typeof options?.includeWithdrawals === "boolean") {
    body._withdrawals = options.includeWithdrawals;
  }
  if (typeof options?.includeCerts === "boolean") {
    body._certs = options.includeCerts;
  }
  if (typeof options?.includeScripts === "boolean") {
    body._scripts = options.includeScripts;
  }
  if (typeof options?.includeBytecode === "boolean") {
    body._bytecode = options.includeBytecode;
  }

  return body;
}

export async function getTxInfoBatch(
  txHashes: string[],
  options?: TxInfoBatchOptions
): Promise<KoiosTxInfo[]> {
  const uniqueTxHashes = Array.from(
    new Set(txHashes.filter((txHash): txHash is string => Boolean(txHash)))
  );
  if (uniqueTxHashes.length === 0) {
    return [];
  }

  const results: KoiosTxInfo[] = [];
  const batches = chunkArray(uniqueTxHashes, KOIOS_TX_INFO_BATCH_SIZE);

  for (const batch of batches) {
    const page = await koiosPost<KoiosTxInfo[]>(
      "/tx_info",
      buildTxInfoRequestBody(batch, options),
      toKoiosContext(options)
    );

    if (page?.length) {
      results.push(...page);
    }
  }

  return results;
}

export async function listPoolGroups(options?: {
  offset?: number;
  limit?: number;
  source?: string;
}): Promise<KoiosPoolGroup[]> {
  return koiosGet<KoiosPoolGroup[]>(
    "/pool_groups",
    {
      limit: options?.limit ?? KOIOS_POOL_GROUPS_PAGE_SIZE,
      offset: options?.offset ?? 0,
    },
    toKoiosContext(options)
  );
}

export async function listAllPoolGroups(
  options?: GovernanceProviderOptions
): Promise<KoiosPoolGroup[]> {
  return collectPaginated({
    pageSize: KOIOS_POOL_GROUPS_PAGE_SIZE,
    fetchPage: ({ offset, limit }) =>
      listPoolGroups({
        offset,
        limit,
        source: options?.source,
      }),
  });
}
