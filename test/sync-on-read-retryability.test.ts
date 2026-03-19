import { ProposalStatus } from "@prisma/client";
import type { ProposalIngestionResult } from "../src/services/ingestion/proposal.service";

type HarnessOptions = {
  dbStatus: ProposalStatus;
  koiosVoteCount?: number;
  dbVoteCount?: number;
  ingestResult?: ProposalIngestionResult;
  useActualFinalize?: boolean;
};

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function loadSyncOnReadHarness(options: HarnessOptions) {
  jest.resetModules();

  const koiosVoteCount = options.koiosVoteCount ?? 1;
  const dbVoteCount = options.dbVoteCount ?? 0;
  const proposalId = "gov_action1test";
  const koiosProposal = {
    proposal_id: proposalId,
    proposal_tx_hash: "proposal-tx-hash",
    proposal_index: 0,
    proposal_type: "InfoAction",
    proposed_epoch: 100,
    ratified_epoch: null,
    enacted_epoch: null,
    dropped_epoch: null,
    expired_epoch: null,
    expiration: 120,
  };

  const syncStatusTx = {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
  };

  const mockPrisma = {
    proposal: {
      findUnique: jest.fn().mockResolvedValue({
        proposalId,
        status: options.dbStatus,
        drepActiveYesVotePower: null,
        drepActiveNoVotePower: null,
        drepActiveAbstainVotePower: null,
        spoActiveYesVotePower: null,
        spoActiveNoVotePower: null,
        spoActiveAbstainVotePower: null,
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    onchainVote: {
      count: jest.fn().mockResolvedValue(dbVoteCount),
    },
    syncStatus: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ isRunning: false }),
    },
    $transaction: jest.fn(async (callback: any) =>
      callback({
        syncStatus: syncStatusTx,
      })
    ),
  };

  const mockKoiosGet = jest.fn(async (path: string) => {
    if (path === "/vote_list") {
      return Array.from({ length: koiosVoteCount }, (_, index) => ({
        vote_tx_hash: `vote-${index}`,
      }));
    }

    if (path.startsWith("/proposal_voting_summary")) {
      return [];
    }

    throw new Error(`Unexpected koiosGet path: ${path}`);
  });

  const mockGetKoiosProposalList = jest.fn().mockResolvedValue([koiosProposal]);
  const ingestResult: ProposalIngestionResult = options.ingestResult ?? {
    success: true,
    downstream: {
      votes: { success: true },
      votingPower: { success: true, summaryFound: true },
    },
    proposal: {
      id: 1,
      proposalId,
      status: ProposalStatus.ACTIVE,
    },
    stats: {
      votesProcessed: 1,
      votesIngested: 1,
      votesUpdated: 0,
      votersCreated: { dreps: 0, spos: 0, ccs: 0 },
      votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
      metadata: {
        attempts: 0,
        success: 0,
        failed: 0,
        skipped: 0,
      },
    },
  };
  const mockIngestProposalData = jest.fn().mockResolvedValue(ingestResult);
  const mockFinalizeProposalStatusAfterVoteSync = jest.fn();

  jest.doMock("../src/services/prisma", () => ({
    prisma: mockPrisma,
  }));
  jest.doMock("../src/services/koios", () => ({
    getKoiosPressureState: jest.fn(() => ({
      active: false,
      remainingMs: 0,
      observedErrors: 0,
      threshold: 0,
      windowMs: 0,
    })),
    getKoiosProposalList: mockGetKoiosProposalList,
    koiosGet: mockKoiosGet,
  }));
  jest.doMock("../src/services/ingestion/proposal.service", () => {
    const actual = jest.requireActual("../src/services/ingestion/proposal.service");
    const finalizeImpl = options.useActualFinalize
      ? actual.finalizeProposalStatusAfterVoteSync
      : async (result: ProposalIngestionResult) => result;

    mockFinalizeProposalStatusAfterVoteSync.mockImplementation(finalizeImpl);

    return {
      ...actual,
      ingestProposalData: mockIngestProposalData,
      finalizeProposalStatusAfterVoteSync: mockFinalizeProposalStatusAfterVoteSync,
      getCurrentEpoch: jest.fn().mockResolvedValue(100),
    };
  });
  jest.doMock("../src/services/ingestion/proposalSyncLock", () => ({
    isProposalSyncLockActive: jest.fn().mockResolvedValue(false),
    releaseProposalSyncLock: jest.fn().mockResolvedValue(undefined),
    tryAcquireProposalSyncLock: jest.fn().mockResolvedValue(true),
  }));

  const syncOnRead = await import("../src/services/syncOnRead");
  return {
    syncOnRead,
    mockPrisma,
    mockIngestProposalData,
    mockFinalizeProposalStatusAfterVoteSync,
  };
}

describe("sync-on-read retryability", () => {
  it("re-ingests ACTIVE proposals when drift is detected", async () => {
    const harness = await loadSyncOnReadHarness({
      dbStatus: ProposalStatus.ACTIVE,
      koiosVoteCount: 1,
      dbVoteCount: 0,
    });

    harness.syncOnRead.syncProposalDetailsOnRead("gov_action1test");
    await flushPromises();
    await flushPromises();

    expect(harness.mockIngestProposalData).toHaveBeenCalledTimes(1);
    expect(harness.mockFinalizeProposalStatusAfterVoteSync).toHaveBeenCalledTimes(1);
  });

  it("skips sync-on-read re-ingestion for non-retryable stored statuses", async () => {
    const harness = await loadSyncOnReadHarness({
      dbStatus: ProposalStatus.RATIFIED,
      koiosVoteCount: 1,
      dbVoteCount: 0,
    });

    harness.syncOnRead.syncProposalDetailsOnRead("gov_action1test");
    await flushPromises();
    await flushPromises();

    expect(harness.mockIngestProposalData).not.toHaveBeenCalled();
    expect(harness.mockFinalizeProposalStatusAfterVoteSync).not.toHaveBeenCalled();
  });

  it("does not finalize deferred status after a partial sync failure", async () => {
    const harness = await loadSyncOnReadHarness({
      dbStatus: ProposalStatus.ACTIVE,
      koiosVoteCount: 1,
      dbVoteCount: 0,
      useActualFinalize: true,
      ingestResult: {
        success: false,
        downstream: {
          votes: { success: false, error: "vote sync failed" },
          votingPower: { success: true, summaryFound: true },
        },
        proposal: {
          id: 1,
          proposalId: "gov_action1test",
          status: ProposalStatus.ACTIVE,
        },
        stats: {
          votesProcessed: 1,
          votesIngested: 0,
          votesUpdated: 0,
          votersCreated: { dreps: 0, spos: 0, ccs: 0 },
          votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
          metadata: {
            attempts: 0,
            success: 0,
            failed: 0,
            skipped: 0,
          },
        },
        intendedStatus: ProposalStatus.RATIFIED,
      },
    });

    harness.syncOnRead.syncProposalDetailsOnRead("gov_action1test");
    await flushPromises();
    await flushPromises();

    expect(harness.mockIngestProposalData).toHaveBeenCalledTimes(1);
    expect(harness.mockFinalizeProposalStatusAfterVoteSync).toHaveBeenCalledTimes(1);
    expect(harness.mockPrisma.proposal.update).not.toHaveBeenCalled();
  });

  it("finalizes deferred status after a successful sync", async () => {
    const harness = await loadSyncOnReadHarness({
      dbStatus: ProposalStatus.ACTIVE,
      koiosVoteCount: 1,
      dbVoteCount: 0,
      useActualFinalize: true,
      ingestResult: {
        success: true,
        downstream: {
          votes: { success: true },
          votingPower: { success: true, summaryFound: true },
        },
        proposal: {
          id: 1,
          proposalId: "gov_action1test",
          status: ProposalStatus.ACTIVE,
        },
        stats: {
          votesProcessed: 1,
          votesIngested: 1,
          votesUpdated: 0,
          votersCreated: { dreps: 0, spos: 0, ccs: 0 },
          votersUpdated: { dreps: 0, spos: 0, ccs: 0 },
          metadata: {
            attempts: 0,
            success: 0,
            failed: 0,
            skipped: 0,
          },
        },
        intendedStatus: ProposalStatus.RATIFIED,
      },
    });

    harness.syncOnRead.syncProposalDetailsOnRead("gov_action1test");
    await flushPromises();
    await flushPromises();

    expect(harness.mockIngestProposalData).toHaveBeenCalledTimes(1);
    expect(harness.mockFinalizeProposalStatusAfterVoteSync).toHaveBeenCalledTimes(1);
    expect(harness.mockPrisma.proposal.update).toHaveBeenCalledWith({
      where: { proposalId: "gov_action1test" },
      data: { status: ProposalStatus.RATIFIED },
    });
  });
});
