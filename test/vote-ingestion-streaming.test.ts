const mockListVotes = jest.fn();
const mockEnsureVoterExists = jest.fn();
const mockPreloadVotersForVotes = jest.fn();
const mockGetKoiosPressureState = jest.fn();
const mockShouldFailFastForDb = jest.fn();
const mockRecordDbFailureForFailFast = jest.fn();

jest.mock("../src/services/governanceProvider", () => ({
  listVotes: (...args: unknown[]) => mockListVotes(...args),
}));

jest.mock("../src/services/ingestion/voterIngestion.service", () => ({
  ensureVoterExists: (...args: unknown[]) => mockEnsureVoterExists(...args),
  preloadVotersForVotes: (...args: unknown[]) =>
    mockPreloadVotersForVotes(...args),
}));

jest.mock("../src/services/koios", () => ({
  getKoiosPressureState: (...args: unknown[]) => mockGetKoiosPressureState(...args),
}));

jest.mock("../src/services/remoteMetadata.service", () => ({
  fetchJsonWithBrowserLikeClient: jest.fn(),
}));

jest.mock("../src/services/txMetadata.service", () => ({
  fetchTxMetadataByHash: jest.fn(),
}));

jest.mock("../src/services/ingestion/dbFailFast", () => ({
  shouldFailFastForDb: (...args: unknown[]) => mockShouldFailFastForDb(...args),
  recordDbFailureForFailFast: (...args: unknown[]) =>
    mockRecordDbFailureForFailFast(...args),
}));

jest.mock("../src/services/prisma", () => ({
  prisma: {
    syncStatus: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
  withDbRead: jest.fn(async (_scope: string, operation: () => Promise<unknown>) =>
    operation()
  ),
  withDbWrite: jest.fn(async (_scope: string, operation: () => Promise<unknown>) =>
    operation()
  ),
}));

import {
  createVoteIngestionRunCache,
  ingestVotesForProposal,
} from "../src/services/ingestion/vote.service";
import { prisma, withDbRead, withDbWrite } from "../src/services/prisma";

function createDbMock() {
  return {
    $transaction: jest.fn(),
    proposal: {
      findUnique: jest.fn().mockResolvedValue({ linkedSurveyTxId: null }),
    },
    drep: {
      findUnique: jest.fn().mockResolvedValue({ votingPower: BigInt(100) }),
    },
    sPO: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    cC: {
      update: jest.fn().mockResolvedValue({}),
    },
    onchainVote: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    syncStatus: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

describe("vote ingestion streaming/preload behavior", () => {
  beforeEach(() => {
    mockListVotes.mockReset();
    mockEnsureVoterExists.mockReset();
    mockPreloadVotersForVotes.mockReset();
    mockGetKoiosPressureState.mockReset();
    mockShouldFailFastForDb.mockReset();
    mockRecordDbFailureForFailFast.mockReset();

    mockGetKoiosPressureState.mockReturnValue({ active: false });
    mockShouldFailFastForDb.mockReturnValue(false);
    mockPreloadVotersForVotes.mockResolvedValue(
      new Map([
        ["DRep:drep1", { voterId: "drep1", created: false, updated: false }],
      ])
    );
    (prisma as any).syncStatus.findUnique.mockReset();
    (prisma as any).syncStatus.upsert.mockReset();
    (prisma as any).syncStatus.findUnique.mockResolvedValue(null);
    (prisma as any).syncStatus.upsert.mockResolvedValue({});
    (withDbRead as jest.Mock).mockClear();
    (withDbWrite as jest.Mock).mockClear();
  });

  it("uses preloaded voters for prefetched vote windows", async () => {
    const db = createDbMock();
    mockPreloadVotersForVotes.mockResolvedValue(
      new Map([
        [
          "DRep:drep1",
          {
            voterId: "drep1",
            created: false,
            updated: false,
            votingPower: BigInt(333),
          },
        ],
      ])
    );

    const result = await ingestVotesForProposal("proposal1", db, undefined, {
      prefetchedVotes: [
        {
          vote_tx_hash: "tx1",
          voter_role: "DRep",
          voter_id: "drep1",
          vote: "Yes",
          epoch_no: 600,
          block_time: 1_700_000_000,
        },
        {
          vote_tx_hash: "tx2",
          voter_role: "DRep",
          voter_id: "drep1",
          vote: "No",
          epoch_no: 600,
          block_time: 1_700_000_010,
        },
      ] as any,
      useCache: false,
    });

    expect(result.success).toBe(true);
    expect(mockPreloadVotersForVotes).toHaveBeenCalledTimes(1);
    expect(mockEnsureVoterExists).not.toHaveBeenCalled();
    expect(db.onchainVote.upsert).toHaveBeenCalledTimes(2);
    expect(db.drep.findUnique).not.toHaveBeenCalled();
    expect(withDbRead).toHaveBeenCalledWith(
      "vote.ingest.proposal-context.proposal1",
      expect.any(Function)
    );
    expect(withDbWrite).toHaveBeenCalledWith(
      expect.stringMatching(/^vote\.ingest\.upsert\./),
      expect.any(Function)
    );
  });

  it("reconciles overlap windows without double processing duplicate votes", async () => {
    const db = createDbMock();
    mockListVotes
      .mockResolvedValueOnce([
        {
          vote_tx_hash: "tx1",
          voter_role: "DRep",
          voter_id: "drep1",
          vote: "Yes",
          epoch_no: 600,
          block_time: 100,
        },
        {
          vote_tx_hash: "tx2",
          voter_role: "DRep",
          voter_id: "drep1",
          vote: "No",
          epoch_no: 600,
          block_time: 101,
        },
      ])
      .mockResolvedValueOnce([
        {
          vote_tx_hash: "tx2",
          voter_role: "DRep",
          voter_id: "drep1",
          vote: "No",
          epoch_no: 600,
          block_time: 101,
        },
        {
          vote_tx_hash: "tx3",
          voter_role: "DRep",
          voter_id: "drep1",
          vote: "Yes",
          epoch_no: 600,
          block_time: 101,
        },
      ]);

    const result = await ingestVotesForProposal("proposal1", db, undefined, {
      useCache: false,
    });

    expect(result.success).toBe(true);
    expect(db.onchainVote.upsert).toHaveBeenCalledTimes(3);
    expect(mockListVotes).toHaveBeenCalledTimes(2);
    expect(mockListVotes).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ offset: 0, minBlockTime: undefined })
    );
    expect(mockListVotes).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offset: 0, minBlockTime: 0 })
    );
  });

  it("returns the originating in-flight result to joiners", async () => {
    const db = createDbMock();
    const runCache = createVoteIngestionRunCache();
    const prefetchedVotes = [
      {
        vote_tx_hash: "tx-join",
        voter_role: "DRep",
        voter_id: "drep1",
        vote: "Yes",
        epoch_no: 600,
        block_time: 1_700_000_000,
      },
    ] as any;
    let releaseUpsert: () => void = () => undefined;
    let upsertBlocked = false;
    db.onchainVote.upsert.mockImplementation(
      () =>
        new Promise((resolve) => {
          upsertBlocked = true;
          releaseUpsert = () => resolve({});
        })
    );

    const first = ingestVotesForProposal("proposal1", db, undefined, {
      useCache: false,
      prefetchedVotes,
      runCache,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const joined = ingestVotesForProposal("proposal1", db, undefined, {
      useCache: false,
      prefetchedVotes,
      runCache,
    });

    expect(upsertBlocked).toBe(true);
    releaseUpsert();
    const [firstResult, joinedResult] = await Promise.all([first, joined]);

    expect(firstResult.success).toBe(true);
    expect(joinedResult.success).toBe(true);
    expect(joinedResult.stats.votesProcessed).toBe(1);
    expect(joinedResult.stats.votesUpserted).toBe(1);
  });
});

