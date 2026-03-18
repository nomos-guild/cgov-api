import type { VoterType } from "@prisma/client";
import { DRepID, PoolId, TxCBOR } from "@meshsdk/core-cst";
import { prisma } from "./prisma";
import { getBlockfrostService } from "./blockfrost";
import { koiosGet, koiosPost } from "./koios";
import { processInParallel } from "./ingestion/parallel";
import { getKoiosCurrentEpoch } from "./ingestion/sync-utils";
import type {
  ResponderRole,
  SurveyLinkedActionId,
  SurveyLinkedVoteEvidence,
  SurveyTallyVote,
  WeightingMode,
} from "../libs/surveyMetadata";

const DEFAULT_SURVEY_TALLY_KOIOS_CONCURRENCY = 5;
const MAX_SURVEY_TALLY_KOIOS_CONCURRENCY = 20;

function getSurveyTallyKoiosConcurrency(): number {
  const rawValue = process.env.SURVEY_TALLY_KOIOS_CONCURRENCY;
  if (!rawValue) {
    return DEFAULT_SURVEY_TALLY_KOIOS_CONCURRENCY;
  }

  const parsed = parseInt(rawValue, 10);
  if (
    Number.isInteger(parsed) &&
    parsed > 0 &&
    parsed <= MAX_SURVEY_TALLY_KOIOS_CONCURRENCY
  ) {
    return parsed;
  }

  return DEFAULT_SURVEY_TALLY_KOIOS_CONCURRENCY;
}

interface KoiosTxInfoRow {
  tx_hash: string;
  epoch_no?: number | null;
  absolute_slot?: number | null;
  tx_block_index?: number | null;
  voting_procedures?: unknown;
  proposal_procedures?: unknown;
}

type VoteCoreEntry = {
  voter?: unknown;
  govActionId?: unknown;
  votingProcedure?: unknown;
};

export async function enrichSurveyTallyVotes(
  votes: SurveyTallyVote[],
  linkedActionId: SurveyLinkedActionId
): Promise<SurveyTallyVote[]> {
  if (votes.length === 0) {
    return [];
  }

  const txInfoMap = await fetchTxInfoByHashes(votes.map((vote) => vote.txHash));

  const enrichedVotes = await Promise.all(
    votes.map(async (vote) => {
      const txInfo = txInfoMap.get(vote.txHash) ?? null;
      const coreVoteEntries =
        extractVoteEntriesFromKoiosTxInfo(txInfo?.voting_procedures) ??
        (await extractVoteEntriesFromBlockfrostCbor(vote.txHash));
      const linkedVoteEvidence = buildLinkedVoteEvidence(
        coreVoteEntries,
        linkedActionId,
        vote.voterType,
        vote.voterId
      );

      return {
        ...vote,
        absoluteSlot: txInfo?.absolute_slot ?? vote.absoluteSlot ?? null,
        txBlockIndex: txInfo?.tx_block_index ?? vote.txBlockIndex ?? null,
        metadataPosition: vote.metadataPosition ?? 0,
        responseCredential:
          linkedVoteEvidence.responseCredential ?? vote.responseCredential ?? null,
        linkedVoteEvidence,
      };
    })
  );

  return enrichedVotes;
}

export async function applyEndEpochWeights(
  votes: SurveyTallyVote[],
  roleWeighting: Partial<Record<ResponderRole, WeightingMode>>,
  endEpoch: number
): Promise<SurveyTallyVote[]> {
  if (votes.length === 0) {
    return [];
  }

  const currentEpoch = await getCurrentEpoch();
  const drepWeights = await loadDrepWeights(votes, roleWeighting, endEpoch);
  const spoWeights = await loadSpoWeights(votes, roleWeighting, endEpoch, currentEpoch);

  return votes.map((vote) => {
    const role = mapVoterTypeToResponderRole(vote.voterType);
    const weightingMode = roleWeighting[role];

    if (!weightingMode || weightingMode === "CredentialBased") {
      return vote;
    }

    if (role === "DRep") {
      const weight = drepWeights.get(vote.voterId);
      return {
        ...vote,
        snapshotWeight: weight?.weight ?? null,
        snapshotWeightError: weight?.error ?? null,
      };
    }

    if (role === "SPO") {
      const weight = spoWeights.get(vote.voterId);
      return {
        ...vote,
        snapshotWeight: weight?.weight ?? null,
        snapshotWeightError: weight?.error ?? null,
      };
    }

    return vote;
  });
}

export async function applyProvisionalWeights(
  votes: SurveyTallyVote[],
  roleWeighting: Partial<Record<ResponderRole, WeightingMode>>,
  currentEpoch: number
): Promise<SurveyTallyVote[]> {
  if (votes.length === 0) {
    return [];
  }

  const drepWeights = await loadDrepWeights(votes, roleWeighting, currentEpoch, {
    provisional: true,
  });
  const spoWeights = await loadSpoWeights(votes, roleWeighting, currentEpoch, currentEpoch, {
    provisional: true,
  });

  return votes.map((vote) => {
    const role = mapVoterTypeToResponderRole(vote.voterType);
    const weightingMode = roleWeighting[role];

    if (!weightingMode || weightingMode === "CredentialBased") {
      return vote;
    }

    if (role === "DRep") {
      const weight = drepWeights.get(vote.voterId);
      return {
        ...vote,
        snapshotWeight:
          weight?.weight ??
          (vote.votingPower ? Number(vote.votingPower) / 1_000_000 : null),
        snapshotWeightError: undefined,
      };
    }

    if (role === "SPO") {
      const weight = spoWeights.get(vote.voterId);
      return {
        ...vote,
        snapshotWeight:
          weight?.weight ??
          (vote.votingPower ? Number(vote.votingPower) / 1_000_000 : null),
        snapshotWeightError: undefined,
      };
    }

    return vote;
  });
}

export const getCurrentEpoch = getKoiosCurrentEpoch;

export function collectPendingFinalizationWarnings(
  votes: SurveyTallyVote[]
): string[] {
  const warnings = new Set<string>();

  for (const vote of votes) {
    for (const warning of vote.linkedVoteEvidence?.warnings ?? []) {
      warnings.add(warning);
    }
    if (vote.snapshotWeightError) {
      warnings.add(vote.snapshotWeightError);
    }
  }

  return Array.from(warnings);
}

async function fetchTxInfoByHashes(
  txHashes: string[]
): Promise<Map<string, KoiosTxInfoRow>> {
  const uniqueHashes = Array.from(new Set(txHashes.filter(Boolean)));
  if (uniqueHashes.length === 0) {
    return new Map();
  }

  const rows = await koiosPost<KoiosTxInfoRow[]>("/tx_info", {
    _tx_hashes: uniqueHashes,
  }, {
    source: "proposal-survey-tally.tx-info",
  });

  return new Map((rows ?? []).map((row) => [row.tx_hash, row]));
}

async function extractVoteEntriesFromBlockfrostCbor(
  txHash: string
): Promise<VoteCoreEntry[] | null> {
  try {
    const blockfrost = getBlockfrostService();
    const response = await blockfrost.get<{ cbor?: string }>(`/txs/${txHash}/cbor`);
    const cborHex = response.data?.cbor;
    if (!cborHex) {
      return null;
    }

    const coreTx = TxCBOR.deserialize(TxCBOR(cborHex)) as {
      body?: {
        votingProcedures?: unknown;
      };
    };

    return extractVoteEntriesFromCoreVotingProcedures(
      coreTx.body?.votingProcedures
    );
  } catch {
    return null;
  }
}

function extractVoteEntriesFromKoiosTxInfo(
  rawVotingProcedures: unknown
): VoteCoreEntry[] | null {
  if (!Array.isArray(rawVotingProcedures) || rawVotingProcedures.length === 0) {
    return null;
  }

  const flattened: VoteCoreEntry[] = [];
  for (const entry of rawVotingProcedures) {
    if (!isObject(entry)) {
      continue;
    }

    if ("voter" in entry && "govActionId" in entry) {
      flattened.push(entry as VoteCoreEntry);
      continue;
    }

    const nestedProcedures =
      asArray((entry as Record<string, unknown>).procedures) ??
      asArray((entry as Record<string, unknown>).votes) ??
      asArray((entry as Record<string, unknown>).voting_procedures);
    if (!nestedProcedures || !("voter" in entry)) {
      continue;
    }

    for (const nested of nestedProcedures) {
      if (!isObject(nested)) {
        continue;
      }

      flattened.push({
        voter: (entry as Record<string, unknown>).voter,
        govActionId:
          (nested as Record<string, unknown>).govActionId ??
          (nested as Record<string, unknown>).gov_action_id,
        votingProcedure:
          (nested as Record<string, unknown>).votingProcedure ?? nested,
      });
    }
  }

  return flattened.length > 0 ? flattened : null;
}

function extractVoteEntriesFromCoreVotingProcedures(
  rawVotingProcedures: unknown
): VoteCoreEntry[] | null {
  if (!Array.isArray(rawVotingProcedures) || rawVotingProcedures.length === 0) {
    return null;
  }

  return rawVotingProcedures
    .filter(isObject)
    .map((entry) => entry as VoteCoreEntry);
}

function buildLinkedVoteEvidence(
  voteEntries: VoteCoreEntry[] | null,
  linkedActionId: SurveyLinkedActionId,
  fallbackVoterType: VoterType,
  fallbackVoterId: string
): SurveyLinkedVoteEvidence {
  const fallbackRole = mapVoterTypeToResponderRole(fallbackVoterType);
  const errors: string[] = [];

  if (!voteEntries || voteEntries.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [
        "Linked vote transaction body could not be inspected for voting_procedures; cgov-api fell back to Koios vote_list identity for this response.",
      ],
      responderRole: fallbackRole,
      responseCredential: fallbackVoterId,
      linkedActionId: null,
    };
  }

  if (voteEntries.length !== 1) {
    errors.push(
      "Linked survey responses must contain exactly one voting_procedures voter entry."
    );
  }

  const firstEntry = voteEntries[0];
  const parsedVoter = parseVoteEntryVoter(firstEntry?.voter);
  const parsedActionId = parseGovActionId(firstEntry?.govActionId);

  if (!parsedVoter) {
    errors.push("Could not derive responder role and credential from voting_procedures.");
  }

  if (!parsedActionId) {
    errors.push("Could not derive the linked govActionId from voting_procedures.");
  } else if (
    parsedActionId.txId !== linkedActionId.txId ||
    parsedActionId.govActionIx !== linkedActionId.govActionIx
  ) {
    errors.push(
      "Linked survey response voting_procedures govActionId does not match the referenced governance action."
    );
  }

  if (
    parsedVoter &&
    (parsedVoter.responderRole !== fallbackRole ||
      parsedVoter.responseCredential !== fallbackVoterId)
  ) {
    errors.push(
      "Koios vote_list identity does not match the transaction voting_procedures voter."
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    responderRole: parsedVoter?.responderRole ?? fallbackRole,
    responseCredential: parsedVoter?.responseCredential ?? fallbackVoterId,
    linkedActionId: parsedActionId,
  };
}

async function loadDrepWeights(
  votes: SurveyTallyVote[],
  roleWeighting: Partial<Record<ResponderRole, WeightingMode>>,
  epochNo: number,
  options?: {
    provisional?: boolean;
  }
): Promise<Map<string, { weight: number; error?: string }>> {
  const drepIds = Array.from(
    new Set(
      votes
        .filter(
          (vote) =>
            mapVoterTypeToResponderRole(vote.voterType) === "DRep" &&
            roleWeighting.DRep === "StakeBased"
        )
        .map((vote) => vote.voterId)
    )
  );

  const result = new Map<string, { weight: number; error?: string }>();
  if (drepIds.length === 0) {
    return result;
  }

  const snapshots = await prisma.drepEpochSnapshot.findMany({
    where: {
      drepId: { in: drepIds },
      epoch: epochNo,
    },
    select: {
      drepId: true,
      votingPower: true,
    },
  });

  for (const snapshot of snapshots) {
    result.set(snapshot.drepId, {
      weight: Number(snapshot.votingPower) / 1_000_000,
    });
  }

  const missingIds = drepIds.filter((drepId) => !result.has(drepId));
  const drepLoadResult = await processInParallel(
    missingIds,
    (drepId) => drepId,
    async (drepId) => {
      const rows = await koiosGet<Array<{ amount?: string | null }>>(
        "/drep_voting_power_history",
        {
          _epoch_no: epochNo,
          _drep_id: drepId,
        },
        {
          source: "proposal-survey-tally.drep-weight.drep-voting-power",
        }
      );
      const amount = rows?.[0]?.amount;
      return {
        drepId,
        weight: amount ? Number(BigInt(amount)) / 1_000_000 : 0,
        error: amount
          ? undefined
          : options?.provisional
          ? undefined
          : `Missing endEpoch DRep voting power snapshot for ${drepId}.`,
      };
    },
    getSurveyTallyKoiosConcurrency()
  );
  for (const loaded of drepLoadResult.successful) {
    result.set(loaded.drepId, {
      weight: loaded.weight,
      error: loaded.error,
    });
  }
  for (const failed of drepLoadResult.failed) {
    result.set(failed.id, {
      weight: 0,
      error:
        options?.provisional
          ? undefined
          : failed.error ||
            `Failed to fetch endEpoch DRep voting power for ${failed.id}.`,
    });
  }

  return result;
}

async function loadSpoWeights(
  votes: SurveyTallyVote[],
  roleWeighting: Partial<Record<ResponderRole, WeightingMode>>,
  epochNo: number,
  currentEpoch: number
  ,
  options?: {
    provisional?: boolean;
  }
): Promise<Map<string, { weight: number; error?: string }>> {
  const spoIds = Array.from(
    new Set(
      votes
        .filter((vote) => mapVoterTypeToResponderRole(vote.voterType) === "SPO")
        .map((vote) => vote.voterId)
    )
  );

  const result = new Map<string, { weight: number; error?: string }>();
  if (spoIds.length === 0) {
    return result;
  }

  const weightingMode = roleWeighting.SPO;
  if (!weightingMode || weightingMode === "CredentialBased") {
    return result;
  }

  const spoLoadResult = await processInParallel(
    spoIds,
    (poolId) => poolId,
    async (poolId) => {
      if (weightingMode === "StakeBased") {
        const rows = await koiosGet<Array<{ amount?: string | null }>>(
          "/pool_voting_power_history",
          {
            _epoch_no: epochNo,
            _pool_bech32: poolId,
          },
          {
            source: "proposal-survey-tally.spo-weight.pool-voting-power",
          }
        );
        const amount = rows?.[0]?.amount;
        return {
          poolId,
          weight: amount ? Number(BigInt(amount)) / 1_000_000 : 0,
          error: amount
            ? undefined
            : options?.provisional
            ? undefined
            : `Missing endEpoch SPO voting power snapshot for ${poolId}.`,
        };
      }

      const rows = await koiosPost<Array<Record<string, unknown>>>("/pool_info", {
        _pool_bech32_ids: [poolId],
      }, {
        source: "proposal-survey-tally.spo-weight.pool-info",
      });
      const row = rows?.[0];
      const rawLivePledge = row?.live_pledge ?? row?.livePledge ?? row?.pledge;
      const parsed =
        typeof rawLivePledge === "string" || typeof rawLivePledge === "number"
          ? Number(rawLivePledge) / 1_000_000
          : 0;
      return {
        poolId,
        weight: Number.isFinite(parsed) ? parsed : 0,
        error:
          options?.provisional || currentEpoch === epochNo
            ? undefined
            : "PledgeBased tally uses current live pledge because historical pledge snapshots are unavailable in cgov-api.",
      };
    },
    getSurveyTallyKoiosConcurrency()
  );
  for (const loaded of spoLoadResult.successful) {
    result.set(loaded.poolId, {
      weight: loaded.weight,
      error: loaded.error,
    });
  }
  for (const failed of spoLoadResult.failed) {
    result.set(failed.id, {
      weight: 0,
      error:
        options?.provisional
          ? undefined
          : failed.error || `Failed to fetch endEpoch SPO voting power for ${failed.id}.`,
    });
  }

  return result;
}

function parseVoteEntryVoter(
  voter: unknown
): { responderRole: ResponderRole; responseCredential: string } | null {
  if (!isObject(voter)) {
    return null;
  }

  if (voter.type === "DRep" && typeof voter.drepId === "string") {
    try {
      return {
        responderRole: "DRep",
        responseCredential: DRepID.toCip105DRepID(voter.drepId as any),
      };
    } catch {
      return {
        responderRole: "DRep",
        responseCredential: voter.drepId,
      };
    }
  }

  if (voter.type === "StakingPool" && typeof voter.keyHash === "string") {
    try {
      return {
        responderRole: "SPO",
        responseCredential: PoolId.fromKeyHash(voter.keyHash as any),
      };
    } catch {
      return {
        responderRole: "SPO",
        responseCredential: voter.keyHash,
      };
    }
  }

  if (voter.type === "ConstitutionalCommittee" && isObject(voter.hotCred)) {
    const hash =
      typeof voter.hotCred.hash === "string"
        ? voter.hotCred.hash
        : typeof voter.hotCred.keyHash === "string"
        ? voter.hotCred.keyHash
        : null;
    if (!hash) {
      return null;
    }

    return {
      responderRole: "CC",
      responseCredential: hash,
    };
  }

  return null;
}

function parseGovActionId(value: unknown): SurveyLinkedActionId | null {
  if (!isObject(value)) {
    return null;
  }

  const txId =
    typeof value.txHash === "string"
      ? value.txHash
      : typeof value.transactionId === "string"
      ? value.transactionId
      : typeof value.id === "string"
      ? value.id
      : null;
  const govActionIx =
    typeof value.txIndex === "number"
      ? value.txIndex
      : typeof value.govActionIx === "number"
      ? value.govActionIx
      : typeof value.govActionIndex === "number"
      ? value.govActionIndex
      : typeof value.actionIndex === "number"
      ? value.actionIndex
      : null;

  if (!txId || govActionIx === null) {
    return null;
  }

  return {
    txId,
    govActionIx,
  };
}

function mapVoterTypeToResponderRole(voterType: VoterType): ResponderRole {
  if (voterType === "DREP") {
    return "DRep";
  }
  if (voterType === "SPO") {
    return "SPO";
  }
  return "CC";
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
