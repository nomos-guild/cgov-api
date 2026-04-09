import {
  getKoiosProposalList,
  getKoiosPressureState,
  koiosGet,
  koiosGetAll,
  koiosPost,
  type KoiosRequestContext,
} from "./koios";
import {
  KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_SIZE,
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
  onRetryAttempt?: KoiosRequestContext["onRetryAttempt"];
  signal?: KoiosRequestContext["signal"];
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
const KOIOS_MUTABLE_PAGE_OVERLAP_ROWS = 200;

// Delay between paginated pages to stay under Koios burst limits (100 req/10s).
const KOIOS_DREP_UPDATES_PAGE_DELAY_MS = parseInt(
  process.env.KOIOS_DREP_UPDATES_PAGE_DELAY_MS || "150",
  10
);
const KOIOS_DEFAULT_PAGE_DELAY_MS = parseInt(
  process.env.KOIOS_DEFAULT_PAGE_DELAY_MS || "100",
  10
);
const KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_DELAY_MS = parseInt(
  process.env.KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_DELAY_MS || "150",
  10
);
const KOIOS_TIMING_SLOW_MS = parseInt(
  process.env.KOIOS_TIMING_SLOW_MS || "2000",
  10
);

function toKoiosContext(
  options?: GovernanceProviderOptions
): KoiosRequestContext | undefined {
  if (!options?.source && !options?.onRetryAttempt && !options?.signal) {
    return undefined;
  }
  return {
    source: options.source,
    onRetryAttempt: options.onRetryAttempt,
    signal: options.signal,
  };
}

async function collectPaginated<T>(options: {
  pageSize: number;
  delayMs?: number;
  label?: string;
  adaptiveHighVolume?: boolean;
  fetchPage: (params: { offset: number; limit: number }) => Promise<T[]>;
}): Promise<T[]> {
  const startedAt = Date.now();
  const rows: T[] = [];
  let offset = 0;
  let hasMore = true;
  let isFirstPage = true;
  let pageCount = 0;

  while (hasMore) {
    const pressureState = getKoiosPressureState();
    const adaptiveLimit =
      options.adaptiveHighVolume && pressureState.active
        ? Math.max(200, Math.floor(options.pageSize / 2))
        : options.pageSize;
    const adaptiveDelayMs =
      (options.delayMs ?? 0) +
      (options.adaptiveHighVolume && pressureState.active ? 150 : 0);
    // Delay between pages to avoid burst-limit pressure on Koios.
    if (!isFirstPage && adaptiveDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, adaptiveDelayMs));
    }
    isFirstPage = false;

    const page = await options.fetchPage({
      offset,
      limit: adaptiveLimit,
    });
    pageCount += 1;

    if (!page || page.length === 0) {
      hasMore = false;
      continue;
    }

    rows.push(...page);
    offset += page.length;
    hasMore = page.length === adaptiveLimit;
  }

  const durationMs = Date.now() - startedAt;
  if (durationMs >= KOIOS_TIMING_SLOW_MS) {
    console.log(
      `[Koios Timing] label=${options.label ?? "paginate"} pages=${pageCount} rows=${rows.length} durationMs=${durationMs} pageSize=${options.pageSize} pageDelayMs=${options.delayMs ?? 0}`
    );
  }

  return rows;
}

function dedupeRowsByKey<T>(rows: T[], getKey: (row: T) => string): T[] {
  const deduped = new Map<string, T>();
  for (const row of rows) {
    deduped.set(getKey(row), row);
  }
  return Array.from(deduped.values());
}

async function collectPaginatedWithOverlap<T>(options: {
  pageSize: number;
  delayMs?: number;
  label?: string;
  adaptiveHighVolume?: boolean;
  overlapRows?: number;
  fetchPage: (params: { offset: number; limit: number }) => Promise<T[]>;
  getRowKey: (row: T) => string;
}): Promise<T[]> {
  const passOneRows = await collectPaginated({
    pageSize: options.pageSize,
    delayMs: options.delayMs,
    label: options.label ? `${options.label}:pass1` : undefined,
    adaptiveHighVolume: options.adaptiveHighVolume,
    fetchPage: options.fetchPage,
  });

  const overlapRows = Math.max(0, options.overlapRows ?? 0);
  if (passOneRows.length === 0 || overlapRows === 0) {
    return passOneRows;
  }

  const overlapOffset = Math.max(0, passOneRows.length - overlapRows);
  const passTwoRows: T[] = [];
  let offset = overlapOffset;
  let hasMore = true;
  let isFirstPage = true;

  while (hasMore) {
    const pressureState = getKoiosPressureState();
    const adaptiveLimit =
      options.adaptiveHighVolume && pressureState.active
        ? Math.max(200, Math.floor(options.pageSize / 2))
        : options.pageSize;
    const adaptiveDelayMs =
      (options.delayMs ?? 0) +
      (options.adaptiveHighVolume && pressureState.active ? 150 : 0);
    if (!isFirstPage && adaptiveDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, adaptiveDelayMs));
    }
    isFirstPage = false;

    const page = await options.fetchPage({ offset, limit: adaptiveLimit });
    if (!page || page.length === 0) {
      hasMore = false;
      continue;
    }

    passTwoRows.push(...page);
    offset += page.length;
    hasMore = page.length === adaptiveLimit;
  }

  const merged = dedupeRowsByKey(
    [...passOneRows, ...passTwoRows],
    options.getRowKey
  );
  if (merged.length !== passOneRows.length) {
    console.log(
      `[Koios Pagination] label=${options.label ?? "paginate"} pass1Rows=${passOneRows.length} pass2Rows=${passTwoRows.length} mergedRows=${merged.length} overlapRows=${overlapRows}`
    );
  }
  return merged;
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
  minBlockTime?: number;
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
  if (typeof options?.minBlockTime === "number") {
    params.block_time = `gte.${options.minBlockTime}`;
  }

  return koiosGet<KoiosVote[]>("/vote_list", params, toKoiosContext(options));
}

export async function listAllVotes(options?: {
  proposalId?: string;
  minEpoch?: number;
  minBlockTime?: number;
  source?: string;
}): Promise<KoiosVote[]> {
  const params: Record<string, string | number> = {
    order: "block_time.asc,vote_tx_hash.asc",
  };

  if (options?.proposalId) {
    params.proposal_id = `eq.${options.proposalId}`;
  }

  if (typeof options?.minEpoch === "number") {
    params.epoch_no = `gte.${options.minEpoch}`;
  }
  if (typeof options?.minBlockTime === "number") {
    params.block_time = `gte.${options.minBlockTime}`;
  }

  return koiosGetAll<KoiosVote>(
    "/vote_list",
    params,
    toKoiosContext(options),
    {
      overlapRows: KOIOS_MUTABLE_PAGE_OVERLAP_ROWS,
      dedupeKey: (vote) =>
        `${vote.vote_tx_hash ?? ""}|${vote.proposal_id ?? ""}|${vote.voter_role ?? ""}|${vote.voter_id ?? ""}|${vote.block_time ?? ""}`,
    }
  );
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
  return koiosGet<KoiosSpoVotingPower[]>(
    "/pool_voting_power_history",
    {
      _epoch_no: options.epochNo,
      order: "pool_id_bech32.asc",
      limit: options.limit ?? 1000,
      offset: options.offset ?? 0,
    },
    toKoiosContext(options)
  );
}

/**
 * Fetches ALL pool voting power records for an epoch, auto-paginating via
 * koiosGetAll. Use this instead of listPoolVotingPowerHistoryForEpoch +
 * a manual while loop.
 *
 * Ordering by pool_id_bech32.asc gives deterministic pages so offset-based
 * pagination never returns duplicates across page boundaries.
 *
 * Docs: GET /pool_voting_power_history — params: _epoch_no, _pool_bech32
 */
export async function getAllPoolVotingPowerHistoryForEpoch(options: {
  epochNo: number;
  source?: string;
}): Promise<KoiosSpoVotingPower[]> {
  return koiosGetAll<KoiosSpoVotingPower>(
    "/pool_voting_power_history",
    { _epoch_no: options.epochNo, order: "pool_id_bech32.asc" },
    toKoiosContext(options)
  );
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

/**
 * Fetches ALL DRep voting power records for an epoch, auto-paginating via
 * koiosGetAll. Use this for epoch-wide syncs instead of one-call-per-DRep.
 *
 * Ordering by drep_id.asc gives deterministic pages so offset pagination
 * remains stable across page boundaries.
 */
export async function getAllDrepVotingPowerHistoryForEpoch(options: {
  epochNo: number;
  source?: string;
}): Promise<KoiosDrepVotingPower[]> {
  return koiosGetAll<KoiosDrepVotingPower>(
    "/drep_voting_power_history",
    { _epoch_no: options.epochNo, order: "drep_id.asc" },
    toKoiosContext(options)
  );
}

export async function listDrepDelegators(options: {
  drepId: string;
  epochNo?: number;
  offset?: number;
  limit?: number;
  order?: string;
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
    {
      ...params,
      order: options.order ?? "epoch_no.asc,stake_address.asc",
      select: "stake_address,amount,epoch_no",
    },
    toKoiosContext(options)
  );
}

export async function listAllDrepDelegators(options: {
  drepId: string;
  epochNo?: number;
  source?: string;
}): Promise<KoiosDrepDelegator[]> {
  const params: Record<string, string | number> = {
    _drep_id: options.drepId,
    order: "epoch_no.asc,stake_address.asc",
    select: "stake_address,amount,epoch_no",
  };
  if (typeof options.epochNo === "number") {
    params.epoch_no = `eq.${options.epochNo}`;
  }
  return koiosGetAll<KoiosDrepDelegator>(
    "/drep_delegators",
    params,
    toKoiosContext(options),
    {
      overlapRows: KOIOS_MUTABLE_PAGE_OVERLAP_ROWS,
      dedupeKey: (row) =>
        `${row.stake_address ?? ""}|${row.epoch_no ?? ""}|${row.amount ?? ""}`,
    }
  );
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
      order: "drep_id.asc",
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
    delayMs: KOIOS_DEFAULT_PAGE_DELAY_MS,
    label: "drep_list",
    adaptiveHighVolume: true,
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
      order: "block_time.desc,update_tx_hash.desc",
      limit: options.limit ?? KOIOS_DREP_UPDATES_PAGE_SIZE,
      offset: options.offset ?? 0,
      select: "drep_id,action,block_time,update_tx_hash,meta_json",
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
    delayMs: KOIOS_DREP_UPDATES_PAGE_DELAY_MS,
    label: "drep_updates",
    adaptiveHighVolume: true,
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
    { _drep_id: drepId, select: "drep_id,action,block_time,update_tx_hash" },
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

  return collectPaginatedWithOverlap({
    pageSize: KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_SIZE,
    delayMs: KOIOS_ACCOUNT_UPDATE_HISTORY_PAGE_DELAY_MS,
    label: "account_update_history",
    adaptiveHighVolume: true,
    overlapRows: KOIOS_MUTABLE_PAGE_OVERLAP_ROWS,
    fetchPage: async ({ offset, limit }) =>
      koiosPost<KoiosAccountUpdateHistoryEntry[]>(
        `/account_update_history?offset=${offset}&limit=${limit}&order=epoch_no.asc,epoch_slot.asc,absolute_slot.asc,tx_hash.asc,stake_address.asc`,
        { _stake_addresses: uniqueStakeAddresses },
        toKoiosContext(options)
      ),
    getRowKey: (row) =>
      `${row.stake_address ?? ""}|${row.tx_hash ?? ""}|${row.epoch_no ?? ""}|${row.epoch_slot ?? ""}|${row.absolute_slot ?? ""}|${row.action_type ?? ""}`,
  });
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
  const txInfoBaseDelayMs = 75;

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    const pressureState = getKoiosPressureState();
    const delayMs = txInfoBaseDelayMs + (pressureState.active ? 150 : 0);
    if (index > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
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
      order: "pool_id_bech32.asc",
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
    delayMs: KOIOS_DEFAULT_PAGE_DELAY_MS,
    adaptiveHighVolume: true,
    fetchPage: ({ offset, limit }) =>
      listPoolGroups({
        offset,
        limit,
        source: options?.source,
      }),
  });
}
