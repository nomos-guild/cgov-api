// Real PR service functions and cip-179@0.2.0; only DB/provider boundaries are simulated.
// Native transaction decoding has separate real-CBOR tests; this suite controls provider/storage failures.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as codec from "cip-179";
import * as domain from "cip-179/domain";
import * as tally from "cip-179/tally";

const mock = vi.hoisted(() => ({
  txs: new Map<string, any>(),
  artifacts: new Map<string, any>(),
  proposals: [] as any[],
  labels: [] as any[],
  raw: [] as any[],
  failWrite: false,
  limited: false,
  requests: [] as any[],
  finalized: 0,
  tip: {} as any,
  stakeUpdates: [] as any[],
  stakes: [] as any[],
  remoteJson: null as any,
  drepUpdates: [] as any[],
  positions: new Map<string, any>(),
  get: vi.fn(),
  post: vi.fn(),
  proof: vi.fn(),
  release: vi.fn(),
  update: vi.fn(),
  syncStatus: { isRunning: false, lastResult: "success" },
}));
vi.mock("../src/services/prisma", () => ({
  prisma: {
    proposal: {
      findFirst: vi.fn(async () => mock.proposals[0] ?? null),
      findMany: vi.fn(async () => mock.proposals),
    },
    cip179Transaction: {
      findUnique: vi.fn(
        async ({ where }) => mock.txs.get(where.txHash) ?? null,
      ),
      findMany: vi.fn(async ({ where } = {}) =>
        [...mock.txs.values()].filter(
          (row) =>
            (!where?.txHash?.in || where.txHash.in.includes(row.txHash)) &&
            (where?.proof !== null || row.proof === null) &&
            (where?.txBlockIndex !== null || row.txBlockIndex === null) &&
            (!where?.payload?.contains ||
              row.payload.includes(where.payload.contains)),
        ),
      ),
      upsert: vi.fn(async ({ where, create, update }) => {
        if (mock.failWrite)
          throw new Error("simulated transient database write failure");
        const row = mock.txs.has(where.txHash)
          ? { ...mock.txs.get(where.txHash), ...update }
          : { proof: null, txBlockIndex: null, ...create };
        mock.txs.set(where.txHash, row);
        return row;
      }),
      update: mock.update,
      deleteMany: vi.fn(async ({ where } = {}) => {
        for (const key of mock.txs.keys())
          if (!where || !where.txHash.notIn.includes(key)) mock.txs.delete(key);
      }),
    },
    syncStatus: { findUnique: vi.fn(async () => mock.syncStatus) },
    cip179Artifact: {
      deleteMany: vi.fn(async () => {
        mock.artifacts.clear();
      }),
      findUnique: vi.fn(
        async ({ where }) => mock.artifacts.get(where.surveyKey) ?? null,
      ),
      findMany: vi.fn(async () => [...mock.artifacts.values()]),
      create: vi.fn(async ({ data }) => {
        mock.artifacts.set(data.surveyKey, data);
        mock.finalized++;
        return data;
      }),
    },
    $transaction: vi.fn(async (values) => Promise.all(values)),
  },
}));
vi.mock("../src/services/koios", () => ({
  koiosGet: mock.get,
  koiosPost: mock.post,
  getKoiosMaxBodyBytes: () => 1024,
}));
vi.mock("../src/services/cip179/anchor.service", () => ({
  fetchVerifiedAnchor: vi.fn(async (_uri, hash) => {
    if (hash === "00".repeat(32)) throw Error("hash mismatch");
    return mock.remoteJson ?? JSON.parse(mock.proposals[0].metadata);
  }),
}));
vi.mock("../src/services/remoteMetadata.service", () => ({
  fetchJsonWithBrowserLikeClient: vi.fn(async () => mock.remoteJson),
}));
vi.mock("../src/services/ingestion/syncLock", () => ({
  acquireJobLock: vi.fn(async () => true),
  releaseJobLock: mock.release,
}));
vi.mock("../src/services/cip179/proof.service", () => ({
  transactionProof: mock.proof,
}));
vi.mock("../src/libs/cip179Package.mts", async () => ({
  decodeNativeTransaction: async (cbor: string) => ({
    payload: (await import("cip-179/tally")).fromJsonSafe(JSON.parse(cbor)),
    proof: { requiredSigners: ["44".repeat(28)], nativeScripts: [], votes: [] },
  }),
  loadCip179: async () => ({
    codec: await import("cip-179"),
    domain: await import("cip-179/domain"),
    tally: await import("cip-179/tally"),
    evolution: {
      evolutionCodec: {
        drepId: () => "fixture-drep",
        stakeAddress: (_c, network) => `${network}-fixture-stake`,
      },
    },
  }),
}));

import { syncCip179Metadata } from "../src/services/cip179/sync.service";
import { responseProven } from "../src/services/cip179/binding.service";
import { finalizeLinkedSurveys } from "../src/services/cip179/finalize.service";
import {
  proposalSurvey,
  proposalSurveyTally,
} from "../src/services/cip179/survey.service";
import { parseCip179Link } from "../src/libs/cip179Link";
import { koiosJsonToMetadatum } from "../src/services/cip179/metadatum";
import { extractProposalMetadata } from "../src/services/ingestion/proposalMetadata.service";

const context = JSON.parse(
  readFileSync("test/fixtures/cip179-anchor.json", "utf8"),
)["@context"];
const TX = "11".repeat(32),
  RESPONSE = "22".repeat(32),
  CANCEL = "33".repeat(32),
  OWNER = "44".repeat(28);
const ref = { txId: domain.hexToBytes(TX), index: 0 };
const credential = { type: "key" as const, keyHash: domain.hexToBytes(OWNER) };
const proof = { requiredSigners: [OWNER], nativeScripts: [], votes: [] };
const definition = (role = 0): codec.SurveyDefinition => ({
  specVersion: 5,
  owner: credential,
  title: "Audit",
  description: "Public survey",
  eligibleRoles: [role],
  endEpoch: 500,
  submissionMode: { type: "public" },
  questions: [
    {
      type: "singleChoice",
      prompt: "Choose",
      options: { type: "options", labels: ["A", "B"] },
    },
  ],
});
const response = (role = 0) => ({
  specVersion: 5,
  surveyRef: ref,
  role,
  credential,
  answers: {
    type: "public" as const,
    answers: [
      { type: "singleChoice" as const, questionIndex: 0, optionIndex: 1 },
    ],
  },
});
function put(txHash: string, payload: any, epochNo: number, slot: number) {
  mock.txs.set(txHash, {
    txHash,
    blockHash: "77".repeat(32),
    payload: JSON.stringify(tally.toJsonSafe(payload)),
    epochNo,
    absoluteSlot: BigInt(slot),
    txBlockIndex: 0,
    proof: JSON.stringify(tally.toJsonSafe(proof)),
  });
}
function populate(role = 0) {
  mock.proposals.push({
    proposalId: "aa".repeat(32) + ":0",
    txHash: "aa".repeat(32),
    certIndex: 0,
    expirationEpoch: 501,
    metaUrl: "https://fixture.invalid/anchor",
    metaHash: "aa".repeat(32),
    metadata: JSON.stringify({
      "@context": context,
      body: {
        cip179: {
          specVersion: 5,
          kind: "survey-link",
          surveyTxId: TX,
          surveyIndex: 0,
        },
      },
    }),
    linkedSurveyTxId: TX,
    linkedSurveyIndex: 0,
  });
  put(TX, { type: "definitions", definitions: [definition(role)] }, 498, 100);
  put(RESPONSE, { type: "responses", responses: [response(role)] }, 499, 200);
  mock.labels = [...mock.txs.values()].map((row) => ({
    tx_hash: row.txHash,
    epoch_no: row.epochNo,
    absolute_slot: Number(row.absoluteSlot),
  }));
}
function artifact() {
  return JSON.parse([...mock.artifacts.values()][0].artifact);
}
function toKoios(value: any): any {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return "0x" + domain.bytesToHex(value);
  if (value instanceof Map)
    return Object.fromEntries(
      [...value].map(([key, v]) => [String(key), toKoios(v)]),
    );
  if (Array.isArray(value)) return value.map(toKoios);
  return value;
}
const koiosSource = readFileSync("src/services/koios.ts", "utf8");
const guardSource = koiosSource.slice(
  koiosSource.indexOf("function getKoiosMaxBodyBytes"),
  koiosSource.indexOf("function clampKoiosPaginationLimit"),
);
const guardJs = ts.transpileModule(guardSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  },
}).outputText;
const payloadGuard = new Function(
  "process",
  "Buffer",
  "getBoundedIntEnv",
  "KOIOS_REGISTERED_MAX_BODY_BYTES",
  "KOIOS_PUBLIC_MAX_BODY_BYTES",
  "normalizeKoiosEndpoint",
  guardJs + ";return enforceKoiosPayloadLimit;",
)(
  { env: {} },
  Buffer,
  (_key, value) => value,
  5120,
  1024,
  (url) => url,
);
beforeEach(() => {
  vi.clearAllMocks();
  mock.txs.clear();
  mock.artifacts.clear();
  mock.proposals = [];
  mock.syncStatus = { isRunning: false, lastResult: "success" };
  mock.labels = [];
  mock.raw = [];
  mock.failWrite = false;
  mock.limited = false;
  mock.requests = [];
  mock.finalized = 0;
  mock.positions.clear();
  mock.drepUpdates = [
    { action: "registered", update_tx_hash: "66".repeat(32), cert_index: 0 },
  ];
  mock.positions.set("66".repeat(32), {
    absolute_slot: 50,
    epoch_no: 498,
    tx_block_index: 0,
  });
  mock.stakeUpdates = [];
  mock.stakes = [];
  mock.remoteJson = null;
  mock.tip = {
    hash: "77".repeat(32),
    epoch_no: 502,
    abs_slot: 2_000_000,
    epoch_slot: 1000,
    block_time: Math.floor(Date.now() / 1000),
  };
  mock.proof.mockResolvedValue(proof);
  mock.update.mockImplementation(async ({ where, data }) => {
    const row = { ...mock.txs.get(where.txHash), ...data };
    mock.txs.set(where.txHash, row);
    return row;
  });
  mock.get.mockImplementation(async (url, params) => {
    mock.requests.push({ url, params });
    if (url === "/tip") return [mock.tip];
    if (url === "/tx_by_metalabel")
      return params.offset === 0 ? mock.labels : [];
    if (url === "/drep_updates")
      return params.offset === 0 ? mock.drepUpdates : [];
    if (url === "/drep_voting_power_history")
      return params.epoch_no === "eq.500" ? [{ amount: "100" }] : [];
    if (url === "/drep_epoch_summary") return [{ amount: "1000" }];
    if (url === "/epoch_info") return [{ active_stake: "1000" }];
    throw new Error("Unexpected GET " + url);
  });
  mock.post.mockImplementation(async (url, body) => {
    mock.requests.push({ url, body });
    if (mock.limited) payloadGuard(url, body);
    if (url.startsWith("/tx_metadata")) return mock.raw;
    if (url === "/block_info") return [{ hash: mock.tip.hash }];
    if (url === "/tx_cbor")
      return mock.labels
        .filter((row) => body._tx_hashes.includes(row.tx_hash))
        .map((row) => ({
          ...row,
          block_hash: mock.tip.hash,
          cbor:
            mock.txs.get(row.tx_hash)?.payload ??
            JSON.stringify(
              tally.toJsonSafe(
                codec.decodePayload(
                  koiosJsonToMetadatum(
                    mock.raw.find((raw) => raw.tx_hash === row.tx_hash)
                      .metadata[17],
                  ),
                ),
              ),
            ),
        }));
    if (url.startsWith("/tx_info"))
      return body._tx_hashes.map((tx_hash) => ({
        tx_hash,
        tx_block_index: 0,
        absolute_slot: Number(mock.txs.get(tx_hash)?.absoluteSlot ?? 0),
        epoch_no: mock.txs.get(tx_hash)?.epochNo ?? 0,
        ...mock.positions.get(tx_hash),
      }));
    if (url.startsWith("/account_update_history")) return mock.stakeUpdates;
    if (url.startsWith("/account_stake_history")) return mock.stakes;
    throw new Error("Unexpected POST " + url);
  });
});

describe("API pipeline positive controls", () => {
  it("withholds artifacts while a sync is running, failed or partial", async () => {
    populate(4);
    await finalizeLinkedSurveys();
    for (const status of [
      { isRunning: true, lastResult: "success" },
      { isRunning: false, lastResult: "failed" },
      { isRunning: false, lastResult: "partial" },
    ]) {
      mock.syncStatus = status;
      expect(
        (await proposalSurveyTally(mock.proposals[0].proposalId))?.artifact,
      ).toBeNull();
    }
    mock.syncStatus = { isRunning: false, lastResult: "success" };
    expect(
      (await proposalSurveyTally(mock.proposals[0].proposalId))?.phase,
    ).toBe("finalized");
  });
  it("resolves a previously unindexed mechanism-B link using its verified anchor", async () => {
    populate();
    const binding = {
      requiredSigners: [],
      nativeScripts: [],
      votes: [
        {
          voterTag: 2,
          credentialHash: OWNER,
          actionIds: [mock.proposals[0].proposalId],
        },
      ],
    };
    expect(await responseProven(response(), binding, 500, [])).toBe(true);
    mock.proposals[0].metaHash = "00".repeat(32);
    await expect(responseProven(response(), binding, 500, [])).rejects.toThrow(
      "hash mismatch",
    );
  });
  it("keeps missing mechanism-B action data unresolved and ignores the wrong voter role", async () => {
    const binding = {
      requiredSigners: [],
      nativeScripts: [],
      votes: [
        {
          voterTag: 2,
          credentialHash: OWNER,
          actionIds: ["aa".repeat(32) + ":0"],
        },
      ],
    };
    await expect(responseProven(response(), binding, 500, [])).rejects.toThrow(
      "has not been indexed",
    );
    binding.votes[0].voterTag = 4;
    expect(await responseProven(response(), binding, 500, [])).toBe(false);
  });
  it("finalizes a structurally valid, proven keyholder response", async () => {
    populate(4);
    expect(await finalizeLinkedSurveys()).toBe(1);
    expect(artifact().tally.perRole[0].responders[0].txHash).toBe(RESPONSE);
  });
  it("does not finalize when a response proof is unavailable", async () => {
    populate(4);
    mock.proof.mockResolvedValue(null);
    expect(await finalizeLinkedSurveys()).toBe(0);
  });
  it("does not finalize missing block positions", async () => {
    populate(4);
    mock.txs.get(RESPONSE).txBlockIndex = null;
    expect(await finalizeLinkedSurveys()).toBe(0);
  });
  it("excludes unproven responses", async () => {
    populate(4);
    mock.proof.mockResolvedValue({
      requiredSigners: [],
      nativeScripts: [],
      votes: [],
    });
    expect(await finalizeLinkedSurveys()).toBe(1);
    expect(artifact().tally.perRole).toEqual([]);
  });
  it("does not let a later structurally invalid answer supersede an earlier valid answer", async () => {
    populate(4);
    const bad = response(4);
    bad.answers.answers[0].optionIndex = 99;
    put(CANCEL, { type: "responses", responses: [bad] }, 500, 300);
    expect(await finalizeLinkedSurveys()).toBe(1);
    expect(artifact().tally.perRole[0].responders[0].txHash).toBe(RESPONSE);
  });
  it("honors an on-time owner-proven cancellation and rejects a late cancellation", async () => {
    populate(4);
    put(CANCEL, { type: "cancellations", cancellations: [ref] }, 500, 300);
    expect(await finalizeLinkedSurveys()).toBe(1);
    expect(artifact().tally.cancelled.txHash).toBe(CANCEL);
    expect(artifact().tally.perRole).toEqual([]);
    mock.artifacts.clear();
    mock.txs.get(CANCEL).epochNo = 501;
    expect(await finalizeLinkedSurveys()).toBe(1);
    expect(artifact().tally.cancelled).toBeUndefined();
  });
});

describe("API safety regressions", () => {
  it("A01: a failed database write must suspend finalization", async () => {
    populate(4);
    mock.txs.delete(RESPONSE);
    mock.failWrite = true;
    mock.raw = [
      {
        tx_hash: RESPONSE,
        metadata: {
          17: toKoios(
            codec.encodePayload({
              type: "responses",
              responses: [response(4)],
            }),
          ),
        },
      },
    ];
    const result = await syncCip179Metadata();
    expect({
      complete: result.complete,
      artifacts: mock.artifacts.size,
    }).toEqual({ complete: false, artifacts: 0 });
  });
  it("A02: cached positions must refresh if the same transaction is re-included after rollback", async () => {
    populate(4);
    mock.labels[1].absolute_slot = 300;
    mock.labels[1].epoch_no = 501;
    await syncCip179Metadata();
    expect(mock.txs.get(RESPONSE).epochNo).toBe(501);
  });
  it("A03: rollback of a counted response must invalidate its finalized artifact", async () => {
    populate(4);
    await finalizeLinkedSurveys();
    mock.labels = mock.labels.filter((row) => row.tx_hash !== RESPONSE);
    await syncCip179Metadata();
    expect(mock.txs.has(RESPONSE)).toBe(false);
    const result = await proposalSurveyTally(mock.proposals[0].proposalId);
    expect(JSON.stringify(result?.artifact ?? {})).not.toContain(RESPONSE);
  });
  it("A04: public-tier requests must fit the API client body limit", async () => {
    mock.limited = true;
    mock.labels = Array.from({ length: 50 }, (_, i) => ({
      tx_hash: i.toString(16).padStart(64, "0"),
      absolute_slot: 100 + i,
      epoch_no: 499,
    }));
    mock.raw = mock.labels.map((row) => ({
      tx_hash: row.tx_hash,
      metadata: {
        17: toKoios(
          codec.encodePayload({ type: "responses", responses: [response(4)] }),
        ),
      },
    }));
    const result = await syncCip179Metadata();
    expect(result.complete).toBe(true);
    expect(result.stored).toBe(50);
  });
  it("A05: DRep mechanism-A responses require membership at inclusion, not only at end_epoch", async () => {
    populate(0);
    mock.positions.set("66".repeat(32), {
      absolute_slot: 250,
      epoch_no: 500,
      tx_block_index: 0,
    });
    await finalizeLinkedSurveys();
    // Provider has no membership/weight row at response epoch 499; registration only exists at 500.
    expect(
      artifact().tally.perRole.flatMap((role: any) => role.responders),
    ).toEqual([]);
  });
  it("A06: a registered stake credential with no delegated stake is not an eligible Stakeholder", async () => {
    populate(3);
    mock.stakeUpdates = [
      {
        action_type: "registration",
        tx_hash: "66".repeat(32),
        absolute_slot: 50,
      },
    ];
    mock.stakes = [];
    await finalizeLinkedSurveys();
    expect(
      artifact().tally.perRole.flatMap((role: any) => role.responders),
    ).toEqual([]);
  });
  it("A07: a link index must fit uint16", () => {
    expect(
      parseCip179Link({
        body: {
          cip179: {
            specVersion: 5,
            kind: "survey-link",
            surveyTxId: TX,
            surveyIndex: 65536,
          },
        },
      }).surveyRef,
    ).toBeNull();
  });
  it("A08: a missing CIP-179 context must not be marked as a valid governance link", async () => {
    populate(4);
    const metadata = JSON.parse(mock.proposals[0].metadata);
    delete metadata["@context"];
    mock.proposals[0].metadata = JSON.stringify(metadata);
    const result = await proposalSurvey(mock.proposals[0].proposalId);
    expect(result?.linkValidation.valid).toBe(false);
  });
  it("A09: a verified cancellation remains cancelled after end_epoch", async () => {
    populate(4);
    put(CANCEL, { type: "cancellations", cancellations: [ref] }, 500, 300);
    const result = await proposalSurvey(mock.proposals[0].proposalId);
    expect(result?.phase).toBe("cancelled");
  });
  it("A10: invalid boolean metadatum must not silently become a map", () => {
    expect(() => koiosJsonToMetadatum(false as never)).toThrow();
  });
  it("A11: a DRep registered in end_epoch with zero voting power must not be excluded", async () => {
    populate(0);
    mock.txs.get(RESPONSE).epochNo = 500;
    mock.txs.get(RESPONSE).absoluteSlot = 300n;
    mock.positions.set("66".repeat(32), {
      absolute_slot: 250,
      epoch_no: 500,
      tx_block_index: 0,
    });
    const original = mock.get.getMockImplementation()!;
    // Koios source joins epochs strictly AFTER first registration; its history has no row at registration epoch.
    mock.get.mockImplementation(async (url, params) =>
      url === "/drep_voting_power_history" ? [] : original(url, params),
    );
    await finalizeLinkedSurveys();
    expect(
      artifact().tally.perRole.flatMap((role: any) => role.responders),
    ).toHaveLength(1);
  });
  it("A12: native metadata retains valid int64 constraints (lossy JSON is refused)", () => {
    const def = {
      ...definition(4),
      questions: [
        {
          type: "numericRange" as const,
          prompt: "Large integer",
          constraints: { min: 0n, max: 9007199254740992n },
        },
      ],
    };
    expect(codec.validateDefinition(def)).toEqual([]);
    const raw = codec.encodePayload({
      type: "definitions",
      definitions: [def],
    });
    expect(codec.decodePayload(raw)).toEqual({
      type: "definitions",
      definitions: [def],
    });
    expect(() => koiosJsonToMetadatum(9007199254740992)).toThrow();
  });
  it("A14: metadata fetched from an anchor URL must match the on-chain anchor hash before its link is trusted", async () => {
    populate(4);
    mock.remoteJson = JSON.parse(
      readFileSync("test/fixtures/cip179-anchor.json", "utf8"),
    );
    mock.remoteJson.body.cip179 = {
      specVersion: 5,
      kind: "survey-link",
      surveyTxId: TX,
      surveyIndex: 0,
    };
    const extracted = await extractProposalMetadata({
      meta_url: "https://fixture.invalid/changed-anchor.json",
      meta_hash: "00".repeat(32),
      meta_json: null,
    } as any);
    mock.proposals[0].metadata = extracted.metadata;
    mock.proposals[0].metaHash = "00".repeat(32);
    const result = await proposalSurvey(mock.proposals[0].proposalId);
    expect(result?.linkValidation.valid).toBe(false);
  });
});

it("validates membership before latest-response selection across a registration gap", async () => {
  populate(0);
  mock.txs.get(RESPONSE).absoluteSlot = 120n;
  mock.drepUpdates = [
    { action: "registered", update_tx_hash: "66".repeat(32), cert_index: 0 },
    { action: "deregistered", update_tx_hash: "88".repeat(32), cert_index: 0 },
    { action: "registered", update_tx_hash: "99".repeat(32), cert_index: 0 },
  ];
  mock.positions.set("88".repeat(32), {
    absolute_slot: 150,
    epoch_no: 499,
    tx_block_index: 0,
  });
  mock.positions.set("99".repeat(32), {
    absolute_slot: 250,
    epoch_no: 500,
    tx_block_index: 0,
  });
  put(CANCEL, { type: "responses", responses: [response(0)] }, 499, 200);
  expect(await finalizeLinkedSurveys()).toBe(1);
  expect(artifact().tally.perRole[0].responders[0].txHash).toBe(RESPONSE);
});
