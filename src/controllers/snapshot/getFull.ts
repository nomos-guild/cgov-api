import { Request, Response } from "express";
import {
  snapshotService,
  SNAPSHOT_CHUNK_SIZE,
  SNAPSHOT_SCHEMA_VERSION,
} from "../../services/snapshot.service";
import {
  SnapshotChunkAction,
  SnapshotChunkMigration,
  SnapshotDrep,
  SnapshotVote,
} from "../../responses";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";
import { parseIntegerQueryOpt } from "../../utils/query-params";

/**
 * GET /snapshot/full
 *
 * Convenience composer for non-browser callers (offline pipelines, research
 * notebooks). Stitches manifest+dreps+chunks into one RawDataset blob in the
 * shape drep-lens's offline `data-snapshot.json` file uses.
 *
 * Browsers should use the chunked endpoints directly.
 */
export const getSnapshotFull = async (req: Request, res: Response) => {
  try {
    const epochStartR = parseIntegerQueryOpt(req.query.epochStart, "epochStart", { min: 0 });
    if (!epochStartR.ok) return res.status(epochStartR.status).json(epochStartR);
    const epochStart = epochStartR.value;

    const epochEndR = parseIntegerQueryOpt(req.query.epochEnd, "epochEnd", { min: 0 });
    if (!epochEndR.ok) return res.status(epochEndR.status).json(epochEndR);
    const epochEnd = epochEndR.value;

    const includeHistory = req.query.includeHistory === "true";

    const [manifestCached, drepsCached] = await Promise.all([
      snapshotService.getManifest({ epochStart, epochEnd }),
      snapshotService.getDreps({ includeHistory }),
    ]);
    const manifest = manifestCached.data;
    const dreps = drepsCached.data;

    const wantedChunks = manifest.chunks.filter((c) => {
      if (epochStart != null && c.endEpoch < epochStart) return false;
      if (epochEnd != null && c.startEpoch > epochEnd) return false;
      return true;
    });

    const chunkResults = await Promise.all(
      wantedChunks.map((c) => snapshotService.getChunk(c.startEpoch))
    );

    const ACTIONS: SnapshotChunkAction[] = [];
    const MIGRATIONS: SnapshotChunkMigration[] = [];
    // Outer key drep_id, inner key gov_action_id — merge across chunks
    const votesByDrep = new Map<string, Record<string, SnapshotVote>>();

    // Clip each chunk's contents to the caller-requested epoch window so callers
    // that pass a sub-chunk range (e.g. epochStart=620&epochEnd=625 inside a
    // 600-649 chunk) don't get out-of-range data while EPOCHS only advertises
    // the requested bounds.
    const lo = epochStart ?? Number.NEGATIVE_INFINITY;
    const hi = epochEnd ?? Number.POSITIVE_INFINITY;
    const keptActionIds = new Set<string>();
    for (const ch of chunkResults) {
      const c = ch.data;
      for (const a of c.ACTIONS) {
        if (a.epoch < lo || a.epoch > hi) continue;
        ACTIONS.push(a);
        keptActionIds.add(a.id);
      }
      for (const m of c.MIGRATIONS) {
        if (m.epoch < lo || m.epoch > hi) continue;
        MIGRATIONS.push(m);
      }
      for (const [drepId, voteMap] of Object.entries(c.votes)) {
        let bucket = votesByDrep.get(drepId);
        for (const [proposalId, vote] of Object.entries(voteMap)) {
          if (!keptActionIds.has(proposalId)) continue;
          if (!bucket) {
            bucket = {};
            votesByDrep.set(drepId, bucket);
          }
          bucket[proposalId] = vote;
        }
      }
    }

    // Attach votes to each DRep (RawDataset.DREPS[i].votes shape)
    const DREPS = dreps.DREPS.map((d: SnapshotDrep) => ({
      ...d,
      votes: votesByDrep.get(d.id) ?? {},
    }));

    ACTIONS.sort((a, b) => a.epoch - b.epoch || a.id.localeCompare(b.id));

    const epochsMin =
      epochStart ?? manifest.firstGovEpoch ?? wantedChunks[0]?.startEpoch ?? 0;
    const epochsMax =
      epochEnd ??
      manifest.currentEpoch ??
      wantedChunks[wantedChunks.length - 1]?.endEpoch ??
      0;

    const datasetHash = `cgov-api-${SNAPSHOT_SCHEMA_VERSION}-${epochsMin}-${epochsMax}-${ACTIONS.length}`;

    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");

    res.json({
      meta: {
        generatedAt: manifest.generatedAt,
        source: "cgov-api",
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        chunkSize: SNAPSHOT_CHUNK_SIZE,
        drepCount: DREPS.length,
        actionCount: ACTIONS.length,
        voteCount: [...votesByDrep.values()].reduce(
          (acc, m) => acc + Object.keys(m).length,
          0
        ),
        migrationCount: MIGRATIONS.length,
      },
      DREPS,
      ACTIONS,
      MIGRATIONS,
      EPOCHS: { min: epochsMin, max: epochsMax },
      datasetHash,
      featuredIds: dreps.featuredIds,
    });
  } catch (error) {
    console.error("Error fetching snapshot/full", formatAxiosLikeError(error));
    res.status(500).json({
      error: "Failed to fetch full snapshot",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
