import { prisma } from "../prisma";
import { koiosGet, koiosPost } from "../koios";
import { acquireJobLock, releaseJobLock } from "../ingestion/syncLock";
import { koiosJsonToMetadatum, type KoiosMetadatum } from "./metadatum";
import { finalizeLinkedSurveys } from "./finalize.service";
import { transactionProof } from "./proof.service";

const JOB_NAME = "cip179-sync";
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const METADATA_BATCH_SIZE = 50;

async function loadCip179() {
  return (await import("../../libs/cip179Package.mjs")).loadCip179();
}

interface KoiosTip {
  abs_slot: number;
  block_time: number;
}

interface LabelRow {
  tx_hash: string;
  absolute_slot: number;
  epoch_no: number;
}

interface MetadataRow {
  tx_hash: string;
  metadata: Record<string, KoiosMetadatum> | null;
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

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function scanLabelRows(): Promise<{ rows: LabelRow[]; complete: boolean }> {
  const [tip] = await koiosGet<KoiosTip[]>("/tip", undefined, {
    source: "cip179.tip",
  });
  if (!tip) throw new Error("Koios tip is unavailable");
  const sinceSlot = Math.max(
    0,
    Math.floor(tip.abs_slot - (tip.block_time - configuredSinceUnix()))
  );

  const byHash = new Map<string, LabelRow>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await koiosGet<LabelRow[]>(
      "/tx_by_metalabel",
      {
        _label: 17,
        select: "tx_hash,absolute_slot,epoch_no",
        absolute_slot: `gte.${sinceSlot}`,
        order: "absolute_slot.desc",
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      },
      { source: "cip179.label-scan" }
    );
    for (const row of rows) byHash.set(row.tx_hash, row);
    if (rows.length < PAGE_SIZE) {
      return { rows: [...byHash.values()], complete: true };
    }
  }
  return { rows: [...byHash.values()], complete: false };
}

async function cacheBatch(
  batch: LabelRow[]
): Promise<{ stored: number; resolved: number }> {
  const { codec, tally } = await loadCip179();
  const rows = await koiosPost<MetadataRow[]>(
    "/tx_metadata?select=tx_hash,metadata",
    { _tx_hashes: batch.map((row) => row.tx_hash) },
    { source: "cip179.metadata" }
  );
  const position = new Map(batch.map((row) => [row.tx_hash, row]));
  let stored = 0;
  let resolved = 0;

  for (const row of rows) {
    const raw = row.metadata?.["17"];
    const chain = position.get(row.tx_hash);
    if (raw === undefined || !chain) continue;
    resolved += 1;
    try {
      const payload = codec.decodePayload(koiosJsonToMetadatum(raw));
      await prisma.cip179Transaction.upsert({
        where: { txHash: row.tx_hash },
        create: {
          txHash: row.tx_hash,
          absoluteSlot: BigInt(chain.absolute_slot),
          epochNo: chain.epoch_no,
          payload: JSON.stringify(tally.toJsonSafe(payload)),
        },
        update: {
          absoluteSlot: BigInt(chain.absolute_slot),
          epochNo: chain.epoch_no,
          payload: JSON.stringify(tally.toJsonSafe(payload)),
        },
      });
      stored += 1;
    } catch (error) {
      console.warn(`[CIP-179] Ignoring malformed label-17 tx ${row.tx_hash}:`, error);
    }
  }
  return { stored, resolved };
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

async function enrichBlockIndexes(): Promise<void> {
  const pending = await prisma.cip179Transaction.findMany({
    where: {
      txBlockIndex: null,
      payload: { contains: '"type":"responses"' },
    },
    select: { txHash: true },
  });
  for (const batch of chunk(pending, METADATA_BATCH_SIZE)) {
    try {
      const rows = await koiosPost<TxInfoRow[]>(
        "/tx_info?select=tx_hash,tx_block_index",
        { _tx_hashes: batch.map((row) => row.txHash) },
        { source: "cip179.block-index" }
      );
      await prisma.$transaction(
        rows.flatMap((row) =>
          row.tx_block_index === null
            ? []
            : [
                prisma.cip179Transaction.update({
                  where: { txHash: row.tx_hash },
                  data: { txBlockIndex: row.tx_block_index },
                }),
              ]
        )
      );
    } catch (error) {
      console.warn(
        "[CIP-179] Transaction block-index enrichment will be retried:",
        error
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
      proposal.linkedSurveyTxId ? [proposal.linkedSurveyTxId] : []
    )
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
  const acquired = await acquireJobLock(JOB_NAME, "CIP-179 Metadata Sync", {
    ttlMs: 15 * 60 * 1000,
  });
  if (!acquired) return { complete: false, discovered: 0, stored: 0, skipped: true };

  try {
    const scan = await scanLabelRows();
    const existing = await prisma.cip179Transaction.findMany({
      where: { txHash: { in: scan.rows.map((row) => row.tx_hash) } },
      select: { txHash: true },
    });
    const known = new Set(existing.map((row) => row.txHash));
    const missing = scan.rows.filter((row) => !known.has(row.tx_hash));
    let stored = 0;
    let complete = scan.complete;

    for (const batch of chunk(missing, METADATA_BATCH_SIZE)) {
      try {
        const result = await cacheBatch(batch);
        stored += result.stored;
        if (result.resolved !== batch.length) complete = false;
      } catch (error) {
        complete = false;
        console.warn("[CIP-179] Metadata batch failed; finalization is suspended:", error);
      }
    }

    if (scan.complete) await removeRolledBackTransactions(scan.rows);
    await enrichBlockIndexes();
    await enrichLinkedDefinitionProofs();
    await enrichCancellationProofs();
    if (complete) await finalizeLinkedSurveys();
    await releaseJobLock(
      JOB_NAME,
      complete ? "success" : "partial",
      stored,
      complete ? null : "Label-17 scan or metadata resolution was incomplete"
    );
    return { complete, discovered: scan.rows.length, stored, skipped: false };
  } catch (error) {
    await releaseJobLock(
      JOB_NAME,
      "failed",
      0,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}
