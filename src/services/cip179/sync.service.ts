import { cip179Network } from "./network";
import { prisma } from "../prisma";
import { koiosGet, koiosPost, getKoiosMaxBodyBytes } from "../koios";
import { acquireJobLock, releaseJobLock } from "../ingestion/syncLock";
import { finalizeLinkedSurveys } from "./finalize.service";
import { transactionProof } from "./proof.service";

const JOB_NAME = "cip179-sync";
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

async function loadCip179() {
  return (await import("../../libs/cip179Package.mjs")).loadCip179();
}

interface KoiosTip {
  abs_slot: number;
  block_time: number;
  hash: string;
}

interface LabelRow {
  tx_hash: string;
  absolute_slot: number;
  epoch_no: number;
}

interface NativeRow extends LabelRow {
  cbor: string | null;
  block_hash: string;
}

interface TxInfoRow {
  tx_hash: string;
  tx_block_index: number | null;
}

function configuredSinceUnix(): number {
  const value = process.env.CIP179_SINCE_ISO ?? "2026-06-01T00:00:00Z";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid CIP179_SINCE_ISO: ${value}`);
  }
  return Math.floor(parsed / 1000);
}

export function hashBatchSize(): number {
  // Account for the exact JSON envelope, quotes and comma for each 64-char hash.
  return Math.max(
    1,
    Math.floor(
      (getKoiosMaxBodyBytes() - Buffer.byteLength('{"_tx_hashes":[]}') + 1) /
        67,
    ),
  );
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function scanLabelRows(): Promise<{
  rows: LabelRow[];
  complete: boolean;
  tipHash: string;
}> {
  const [tip] = await koiosGet<KoiosTip[]>("/tip", undefined, {
    source: "cip179.tip",
  });
  if (!tip) throw new Error("Koios tip is unavailable");
  const sinceSlot = Math.max(
    0,
    Math.floor(tip.abs_slot - (tip.block_time - configuredSinceUnix())),
  );

  const byHash = new Map<string, LabelRow>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await koiosGet<LabelRow[]>(
      "/tx_by_metalabel",
      {
        _label: 17,
        select: "tx_hash,absolute_slot,epoch_no",
        and: `(absolute_slot.gte.${sinceSlot},absolute_slot.lte.${tip.abs_slot})`,
        order: "absolute_slot.desc,tx_hash.desc",
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      },
      { source: "cip179.label-scan" },
    );
    for (const row of rows) byHash.set(row.tx_hash, row);
    if (rows.length < PAGE_SIZE) {
      return { rows: [...byHash.values()], complete: true, tipHash: tip.hash };
    }
  }
  return { rows: [...byHash.values()], complete: false, tipHash: tip.hash };
}

async function cacheBatch(
  batch: LabelRow[],
  assertLease: () => void,
): Promise<{ stored: number; resolved: number }> {
  const { tally, domain } = await loadCip179();
  const { decodeNativeTransaction } = await import(
    "../../libs/cip179Package.mjs"
  );
  const rows = await koiosPost<NativeRow[]>(
    "/tx_cbor",
    { _tx_hashes: batch.map((row) => row.tx_hash) },
    { source: "cip179.native" },
  );
  const positions = new Map(batch.map((row) => [row.tx_hash, row]));
  const resolved = new Set<string>();
  let stored = 0;
  for (const row of rows) {
    const chain = positions.get(row.tx_hash);
    if (!chain || !row.cbor || resolved.has(row.tx_hash)) continue;
    if (
      chain.absolute_slot !== row.absolute_slot ||
      chain.epoch_no !== row.epoch_no
    )
      throw new Error("Chain moved during metadata resolution");
    const { payload, proof } = await decodeNativeTransaction(
      row.cbor,
      row.tx_hash,
    );
    const surveyKeys =
      payload?.type === "definitions"
        ? payload.definitions.map((_, index) => `${row.tx_hash}:${index}`)
        : payload?.type === "responses"
          ? payload.responses.map((r) => domain.refKey(r.surveyRef))
          : payload?.type === "cancellations"
            ? payload.cancellations.map(domain.refKey)
            : [];
    const data = {
      absoluteSlot: BigInt(chain.absolute_slot),
      epochNo: chain.epoch_no,
      blockHash: row.block_hash,
      txBlockIndex: null,
      payload: JSON.stringify(tally.toJsonSafe(payload ?? { type: "invalid" })),
      proof: proof ? JSON.stringify(tally.toJsonSafe(proof)) : null,
      surveyKeys: [...new Set(surveyKeys)],
    };
    assertLease();
    // Storage failure must propagate; it is never a malformed-payload outcome.
    await prisma.cip179Transaction.upsert({
      where: { txHash: row.tx_hash },
      create: { txHash: row.tx_hash, ...data },
      update: data,
    });
    stored++;
    resolved.add(row.tx_hash);
  }
  return { stored, resolved: resolved.size };
}

async function removeRolledBackTransactions(rows: LabelRow[]): Promise<void> {
  const txHashes = rows.map((row) => row.tx_hash);
  if (txHashes.length === 0) {
    await prisma.cip179Transaction.deleteMany();
    return;
  }
  await prisma.cip179Transaction.deleteMany({
    where: { txHash: { notIn: txHashes } },
  });
}

async function enrichBlockIndexes(assertLease: () => void): Promise<void> {
  const pending = await prisma.cip179Transaction.findMany({
    where: {
      txBlockIndex: null,
      payload: { contains: '"type":"responses"' },
    },
    select: { txHash: true },
  });
  for (const batch of chunk(pending, hashBatchSize())) {
    try {
      const rows = await koiosPost<TxInfoRow[]>(
        "/tx_info?select=tx_hash,tx_block_index",
        { _tx_hashes: batch.map((row) => row.txHash) },
        { source: "cip179.block-index" },
      );
      assertLease();
      await prisma.$transaction(
        rows.flatMap((row) =>
          row.tx_block_index === null
            ? []
            : [
                prisma.cip179Transaction.update({
                  where: { txHash: row.tx_hash },
                  data: { txBlockIndex: row.tx_block_index },
                }),
              ],
        ),
      );
    } catch (error) {
      console.warn(
        "[CIP-179] Transaction block-index enrichment will be retried:",
        error,
      );
    }
  }
}

async function enrichLinkedDefinitionProofs(): Promise<void> {
  const proposals = await prisma.proposal.findMany({
    where: { linkedSurveyTxId: { not: null } },
    select: { linkedSurveyTxId: true },
  });
  const txHashes = new Set(
    proposals.flatMap((proposal) =>
      proposal.linkedSurveyTxId ? [proposal.linkedSurveyTxId] : [],
    ),
  );
  for (const txHash of txHashes) await transactionProof(txHash);
}

async function enrichCancellationProofs(): Promise<void> {
  const pending = await prisma.cip179Transaction.findMany({
    where: {
      proof: null,
      payload: { contains: '"type":"cancellations"' },
    },
    select: { txHash: true },
  });
  for (const { txHash } of pending) await transactionProof(txHash);
}

export interface Cip179SyncResult {
  complete: boolean;
  discovered: number;
  stored: number;
  skipped: boolean;
}

export async function syncCip179Metadata(): Promise<Cip179SyncResult> {
  cip179Network();
  const acquired = await acquireJobLock(JOB_NAME, "CIP-179 Metadata Sync", {
    ttlMs: 15 * 60 * 1000,
  });
  if (!acquired)
    return { complete: false, discovered: 0, stored: 0, skipped: true };

  const deadline = Date.now() + 12 * 60 * 1000;
  const assertLease = () => {
    if (Date.now() >= deadline)
      throw new Error(
        "CIP-179 sync exceeded its work budget; retry before finalizing",
      );
  };
  try {
    const scan = await scanLabelRows();
    // An artifact is derived data. Rebuild it from every complete authoritative scan.
    // Readers are gated on this job's successful completion, including after a crash.
    assertLease();
    await prisma.cip179Artifact.deleteMany();
    let stored = 0;
    let complete = scan.complete;

    for (const batch of chunk(scan.rows, hashBatchSize())) {
      try {
        const result = await cacheBatch(batch, assertLease);
        stored += result.stored;
        if (result.resolved !== batch.length) complete = false;
      } catch (error) {
        complete = false;
        console.warn(
          "[CIP-179] Metadata batch failed; finalization is suspended:",
          error,
        );
      }
    }

    assertLease();
    const checkpoints = await koiosPost<Array<{ hash: string }>>(
      "/block_info",
      { _block_hashes: [scan.tipHash] },
      { source: "cip179.checkpoint" },
    );
    if (
      !scan.tipHash ||
      !checkpoints.some((block) => block.hash === scan.tipHash)
    )
      complete = false;
    if (complete) await removeRolledBackTransactions(scan.rows);
    await enrichBlockIndexes(assertLease);
    await enrichLinkedDefinitionProofs();
    await enrichCancellationProofs();
    if (complete) await finalizeLinkedSurveys(assertLease);
    assertLease();
    await releaseJobLock(
      JOB_NAME,
      complete ? "success" : "partial",
      stored,
      complete ? null : "Label-17 scan or metadata resolution was incomplete",
    );
    return { complete, discovered: scan.rows.length, stored, skipped: false };
  } catch (error) {
    if (Date.now() < deadline + 3 * 60 * 1000)
      await releaseJobLock(
        JOB_NAME,
        "failed",
        0,
        error instanceof Error ? error.message : String(error),
      );
    throw error;
  }
}
