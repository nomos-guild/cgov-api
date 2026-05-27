import { Request, Response } from "express";
import {
  snapshotService,
  SNAPSHOT_CHUNK_SIZE,
} from "../../services/snapshot.service";
import { prisma } from "../../services";
import { sendCachedSnapshot } from "./sendCachedSnapshot";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";

// Strict integer-only — `parseInt("12abc", 10)` returns 12 silently which would
// let "/snapshot/chunks/12abc-49xyz" pass the chunk-boundary check below.
const CHUNK_RANGE_RE = /^(\d+)-(\d+)$/;

/**
 * GET /snapshot/chunks/{startEpoch}-{endEpoch}
 */
export const getSnapshotChunk = async (req: Request, res: Response) => {
  try {
    const range = req.params.range as string;
    const m = range.match(CHUNK_RANGE_RE);
    if (!m) {
      return res.status(400).json({
        error: "Invalid chunk range",
        message: `Expected /snapshot/chunks/{start}-{end}; got ${range}`,
      });
    }
    const startEpoch = parseInt(m[1], 10);
    const endEpoch = parseInt(m[2], 10);
    const expectedStart =
      Math.floor(startEpoch / SNAPSHOT_CHUNK_SIZE) * SNAPSHOT_CHUNK_SIZE;
    const expectedEnd = expectedStart + SNAPSHOT_CHUNK_SIZE - 1;
    if (startEpoch !== expectedStart || endEpoch !== expectedEnd) {
      return res.status(400).json({
        error: "Invalid chunk range",
        message: `Chunk boundaries must align with chunkSize=${SNAPSHOT_CHUNK_SIZE}. Canonical: /snapshot/chunks/${expectedStart}-${expectedEnd}`,
      });
    }

    // Reject chunks that fall outside the data range — otherwise a request for
    // /snapshot/chunks/1000000-1000049 would compose an empty payload AND persist
    // a SnapshotCache row, letting an attacker grow the cache table unboundedly.
    const tip = await prisma.epochTotals.aggregate({ _max: { epoch: true } });
    const currentEpoch = tip._max.epoch ?? 0;
    if (startEpoch > currentEpoch) {
      return res.status(404).json({
        error: "Chunk out of range",
        message: `Requested chunk start ${startEpoch} is past the current epoch tip ${currentEpoch}`,
      });
    }

    const cached = await snapshotService.getChunk(startEpoch);
    // Only fully-stable final chunks (epoch range past tip AND every migration
    // row's amount_at_switch backfilled) get the immutable 30-day TTL — anything
    // mutable would risk CDN/browser pinning stale data after a backfill.
    if (cached.data.isFinal && cached.data.isStable) {
      res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
    } else if (cached.data.isFinal) {
      // Past-epoch chunk that's still backfilling — short cache, frequent revalidation.
      res.setHeader("Cache-Control", "public, max-age=900, stale-while-revalidate=300");
    }
    sendCachedSnapshot(req, res, cached);
  } catch (error) {
    console.error("Error fetching snapshot chunk", formatAxiosLikeError(error));
    res.status(500).json({
      error: "Failed to fetch snapshot chunk",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
