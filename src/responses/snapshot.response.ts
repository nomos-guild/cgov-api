/**
 * drep-lens snapshot wire format.
 *
 * IMPORTANT: field names match drep-lens's RawDataset / DRep / GovAction shape
 * (snake_case / camelCase mix is intentional — this is the bridge layer):
 *   - DRep.id  (NOT drepId)
 *   - power    (kADA = lovelace / 1e9, JS number — see ./lovelace.ts)
 *   - delegators (NOT delegatorCount)
 *   - vote enum is lowercase: "yes" | "no" | "abstain"
 *   - GovAction.type is the display label, NOT the DB enum
 *
 * Convention: this endpoint deliberately serialises lovelace as `Kada` /
 * `Ada` (lossy JS numbers) because drep-lens does its clustering arithmetic
 * in client-side JS where BigInt is awkward. The /migrations and /dreps
 * endpoints keep the precision-preserving `LovelaceString` form. See
 * ./lovelace.ts for the project-wide rationale.
 */

import type { Kada, Ada } from "./lovelace";

export type SnapshotVote = "yes" | "no" | "abstain";

/**
 * Chunk finality state. Exposed to consumers as two parallel booleans so
 * existing JSON readers don't need to change, but constructed via the
 * `chunkFinality()` helper so the illegal `{isFinal:false, isStable:true}`
 * combination is unrepresentable in the producer code path.
 *
 * Invariant: `isStable` ⇒ `isFinal`. Encoded via a discriminated union over
 * a `state` discriminator that the wire format strips.
 */
export type ChunkFinality =
  | { state: "live"; isFinal: false; isStable: false }
  | { state: "final-unstable"; isFinal: true; isStable: false }
  | { state: "stable"; isFinal: true; isStable: true };

/**
 * Build a {@link ChunkFinality} value from the underlying signals. Centralised
 * so every producer (composeChunk, composeManifest, snapshot-builder) gets the
 * same truth table.
 *
 *   isFinal     := chunkEnd < currentEpoch
 *   isStable    := isFinal AND allAmountsHistorical AND fullScanCompleted
 */
export function chunkFinality(input: {
  isFinal: boolean;
  allAmountsHistorical: boolean;
  fullScanCompleted: boolean;
}): ChunkFinality {
  if (!input.isFinal) {
    return { state: "live", isFinal: false, isStable: false };
  }
  if (input.allAmountsHistorical && input.fullScanCompleted) {
    return { state: "stable", isFinal: true, isStable: true };
  }
  return { state: "final-unstable", isFinal: true, isStable: false };
}

export type SnapshotManifestChunk = {
  startEpoch: number;
  endEpoch: number;
  url: string;
  actionCount: number;
  voteCount: number;
  migrationCount: number;
} & ChunkFinality;

export interface SnapshotManifest {
  schemaVersion: "v1";
  generatedAt: string;
  chunkSize: number;
  currentEpoch: number;
  firstGovEpoch: number;
  drepsUrl: string;
  drepCount: number;
  chunks: SnapshotManifestChunk[];
}

export interface SnapshotDrep {
  id: string;
  name: string;
  handle: string;
  /** kADA (= lovelace / 1e9). Lossy ≥ 9 PADA — see ./lovelace.ts. */
  power: Kada;
  delegators: number;
  /** Fraction in [0, 1], 4-decimal precision. */
  participation: number;
  joined: number;
  cluster: number;
  iconUrl: string | null;
  powerSeries?: Array<{ epoch: number; power: Kada; delegators: number }>;
}

export interface SnapshotDreps {
  schemaVersion: "v1";
  generatedAt: string;
  drepCount: number;
  DREPS: SnapshotDrep[];
  featuredIds: string[];
}

export interface SnapshotChunkAction {
  id: string;
  title: string;
  type: string;
  epoch: number;
}

export interface SnapshotChunkMigration {
  epoch: number;
  from: string;
  to: string;
  /** Always 0 — drep-lens analysis remaps clusters per-pass; this is the fallback */
  fromCluster: number;
  /** Always 0 — drep-lens analysis remaps clusters per-pass; this is the fallback */
  toCluster: number;
  /** ADA (= lovelace / 1e6). Lossy ≥ 9 EADA — see ./lovelace.ts. */
  ada: Ada;
  delegators: number;
}

/**
 * Cross product of static fields + the {@link ChunkFinality} discriminated
 * union. Producers MUST go through `chunkFinality()` so the illegal
 * `{isFinal:false, isStable:true}` combination cannot be constructed.
 *
 * On the wire each variant serialises as the same `{...isFinal, isStable, state}`
 * shape; the optional `state` discriminator is informational and the boolean
 * pair stays as the source of truth for legacy clients (drep-lens etc.).
 */
export type SnapshotChunk = {
  schemaVersion: "v1";
  generatedAt: string;
  epochStart: number;
  epochEnd: number;
  ACTIONS: SnapshotChunkAction[];
  /** Sparse: outer key drep_id, inner key gov_action_id */
  votes: Record<string, Record<string, SnapshotVote>>;
  MIGRATIONS: SnapshotChunkMigration[];
} & ChunkFinality;
