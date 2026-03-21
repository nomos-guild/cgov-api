const mockGetKoiosProposalList = jest.fn();
const mockKoiosGet = jest.fn();
const mockKoiosPost = jest.fn();

jest.mock("../src/services/koios", () => ({
  getKoiosProposalList: (...args: unknown[]) => mockGetKoiosProposalList(...args),
  koiosGet: (...args: unknown[]) => mockKoiosGet(...args),
  koiosPost: (...args: unknown[]) => mockKoiosPost(...args),
}));

import {
  getAccountUpdateHistoryBatch,
  getCommitteeInfo,
  getCurrentEpochFromKoios,
  getTxInfoBatch,
  getProposalVotingSummary,
  getDrepInfoBatchFromKoios,
  listAllDrepIds,
  listAllDrepUpdates,
  listAllPoolGroups,
  listProposals,
  listVotes,
} from "../src/services/governanceProvider";

describe("governanceProvider", () => {
  beforeEach(() => {
    mockGetKoiosProposalList.mockReset();
    mockKoiosGet.mockReset();
    mockKoiosPost.mockReset();
  });

  function buildRows<T>(count: number, createRow: (index: number) => T): T[] {
    return Array.from({ length: count }, (_, index) => createRow(index));
  }

  it("uses interactive proposal list cache when requested", async () => {
    mockGetKoiosProposalList.mockResolvedValue([{ proposal_id: "gov_action1" }]);

    const proposals = await listProposals({
      source: "test.proposals",
      interactiveCache: true,
    });

    expect(proposals).toEqual([{ proposal_id: "gov_action1" }]);
    expect(mockGetKoiosProposalList).toHaveBeenCalledWith({
      context: { source: "test.proposals" },
      interactiveCache: true,
      forceRefresh: undefined,
    });
  });

  it("builds proposal-scoped vote queries", async () => {
    mockKoiosGet.mockResolvedValue([{ vote_tx_hash: "vote-1" }]);

    const votes = await listVotes({
      proposalId: "gov_action1",
      minEpoch: 123,
      offset: 10,
      limit: 50,
      source: "test.votes",
    });

    expect(votes).toEqual([{ vote_tx_hash: "vote-1" }]);
    expect(mockKoiosGet).toHaveBeenCalledWith(
      "/vote_list",
      {
        limit: 50,
        offset: 10,
        order: "block_time.asc,vote_tx_hash.asc",
        proposal_id: "eq.gov_action1",
        epoch_no: "gte.123",
      },
      { source: "test.votes" }
    );
  });

  it("returns the first proposal voting summary row", async () => {
    mockKoiosGet.mockResolvedValue([
      { drep_active_yes_vote_power: "1" },
      { drep_active_yes_vote_power: "2" },
    ]);

    await expect(
      getProposalVotingSummary("gov_action1", { source: "test.summary" })
    ).resolves.toEqual({ drep_active_yes_vote_power: "1" });
  });

  it("returns committee info and current epoch through the shared provider", async () => {
    mockKoiosGet
      .mockResolvedValueOnce([{ members: [], quorum_numerator: 2, quorum_denominator: 3 }])
      .mockResolvedValueOnce([{ epoch_no: 555 }]);

    await expect(
      getCommitteeInfo({ source: "test.committee" })
    ).resolves.toEqual({
      members: [],
      quorum_numerator: 2,
      quorum_denominator: 3,
    });
    await expect(
      getCurrentEpochFromKoios({ source: "test.tip" })
    ).resolves.toBe(555);
  });

  it("posts batched drep info lookups", async () => {
    mockKoiosPost.mockResolvedValue([{ drep_id: "drep1" }]);

    await expect(
      getDrepInfoBatchFromKoios(["drep1"], { source: "test.drep-info" })
    ).resolves.toEqual([{ drep_id: "drep1" }]);
    expect(mockKoiosPost).toHaveBeenCalledWith(
      "/drep_info",
      { _drep_ids: ["drep1"] },
      { source: "test.drep-info" }
    );
  });

  it("retrieves paged drep ids through the shared provider", async () => {
    mockKoiosGet
      .mockResolvedValueOnce(
        buildRows(1000, (index) => ({ drep_id: `drep${index}` }))
      )
      .mockResolvedValueOnce([{ drep_id: "drep1000" }]);

    await expect(listAllDrepIds({ source: "test.drep-list" })).resolves.toEqual([
      ...buildRows(1000, (index) => `drep${index}`),
      "drep1000",
    ]);

    expect(mockKoiosGet).toHaveBeenNthCalledWith(
      1,
      "/drep_list",
      { limit: 1000, offset: 0 },
      { source: "test.drep-list" }
    );
    expect(mockKoiosGet).toHaveBeenNthCalledWith(
      2,
      "/drep_list",
      { limit: 1000, offset: 1000 },
      { source: "test.drep-list" }
    );
  });

  it("retrieves paged drep updates until the final short page", async () => {
    mockKoiosGet
      .mockResolvedValueOnce(
        buildRows(1000, (index) => ({
          drep_id: "drep1",
          update_tx_hash: `tx${index}`,
          block_time: 1_700_000_000 + index,
        }))
      )
      .mockResolvedValueOnce([
        {
          drep_id: "drep1",
          update_tx_hash: "tx1000",
          block_time: 1_700_001_000,
        },
      ]);

    const updates = await listAllDrepUpdates("drep1", {
      source: "test.drep-updates",
    });

    expect(updates).toHaveLength(1001);
    expect(mockKoiosGet).toHaveBeenNthCalledWith(
      1,
      "/drep_updates",
      { _drep_id: "drep1", limit: 1000, offset: 0 },
      { source: "test.drep-updates" }
    );
    expect(mockKoiosGet).toHaveBeenNthCalledWith(
      2,
      "/drep_updates",
      { _drep_id: "drep1", limit: 1000, offset: 1000 },
      { source: "test.drep-updates" }
    );
  });

  it("batches tx info lookups and preserves request body flags", async () => {
    const txHashes = buildRows(11, (index) => `tx${index}`);
    mockKoiosPost
      .mockResolvedValueOnce(
        txHashes.slice(0, 10).map((txHash) => ({ tx_hash: txHash }))
      )
      .mockResolvedValueOnce([{ tx_hash: "tx10" }]);

    const rows = await getTxInfoBatch(txHashes, {
      includeMetadata: false,
      includeCerts: true,
      source: "test.tx-info",
    });

    expect(rows).toHaveLength(11);
    expect(mockKoiosPost).toHaveBeenNthCalledWith(
      1,
      "/tx_info",
      {
        _tx_hashes: txHashes.slice(0, 10),
        _metadata: false,
        _certs: true,
      },
      { source: "test.tx-info" }
    );
    expect(mockKoiosPost).toHaveBeenNthCalledWith(
      2,
      "/tx_info",
      {
        _tx_hashes: ["tx10"],
        _metadata: false,
        _certs: true,
      },
      { source: "test.tx-info" }
    );
  });

  it("pages account update history across combined stake-address result sets", async () => {
    mockKoiosPost
      .mockResolvedValueOnce(
        buildRows(1000, (index) => ({
          stake_address: index % 2 === 0 ? "stake_test1" : "stake_test2",
          action_type: "delegation_drep",
          epoch_no: index,
        }))
      )
      .mockResolvedValueOnce([
        {
          stake_address: "stake_test1",
          action_type: "delegation_drep",
          epoch_no: 1000,
        },
      ]);

    const rows = await getAccountUpdateHistoryBatch(
      ["stake_test1", "stake_test2"],
      { source: "test.account-history" }
    );

    expect(rows).toHaveLength(1001);
    expect(mockKoiosPost).toHaveBeenNthCalledWith(
      1,
      "/account_update_history?offset=0&limit=1000",
      { _stake_addresses: ["stake_test1", "stake_test2"] },
      { source: "test.account-history" }
    );
    expect(mockKoiosPost).toHaveBeenNthCalledWith(
      2,
      "/account_update_history?offset=1000&limit=1000",
      { _stake_addresses: ["stake_test1", "stake_test2"] },
      { source: "test.account-history" }
    );
  });

  it("retrieves the full paginated pool groups dataset", async () => {
    mockKoiosGet
      .mockResolvedValueOnce(
        buildRows(1000, (index) => ({
          pool_id_bech32: `pool${index}`,
          pool_group: `group${index}`,
        }))
      )
      .mockResolvedValueOnce([
        {
          pool_id_bech32: "pool1000",
          pool_group: "group1000",
        },
      ]);

    const rows = await listAllPoolGroups({ source: "test.pool-groups" });

    expect(rows).toHaveLength(1001);
    expect(mockKoiosGet).toHaveBeenNthCalledWith(
      1,
      "/pool_groups",
      { limit: 1000, offset: 0 },
      { source: "test.pool-groups" }
    );
    expect(mockKoiosGet).toHaveBeenNthCalledWith(
      2,
      "/pool_groups",
      { limit: 1000, offset: 1000 },
      { source: "test.pool-groups" }
    );
  });
});
