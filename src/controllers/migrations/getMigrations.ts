import { Request, Response } from "express";
import { prisma } from "../../services";
import {
  getMigrationAggregateAccuracy,
} from "../../services/ingestion/migration-aggregate.service";
import {
  GetMigrationsResponse,
  MigrationRow,
  toAdaString,
  toLovelaceString,
} from "../../responses";
import { formatAxiosLikeError } from "../../utils/format-http-client-error";
import { parseIntegerQuery } from "../../utils/query-params";
import { SENTINEL_DREP_IDS } from "../../libs/sentinels";

/** Default page size for /migrations. Bounded to keep the response under
 *  ~1MB even with maximum-cardinality DRep churn per epoch. Operators can
 *  raise via the `limit` query param up to MIGRATIONS_MAX_LIMIT. */
const MIGRATIONS_DEFAULT_LIMIT = 500;
const MIGRATIONS_MAX_LIMIT = 5000;

/**
 * GET /migrations
 *
 * Query params:
 *   epochStart       — inclusive lower bound on delegated epoch (default 0)
 *   epochEnd         — inclusive upper bound (default = current largest epoch in the aggregate)
 *   fromDrepId       — optional source-DRep filter
 *   toDrepId         — optional target-DRep filter
 *   excludeSentinels — drop rows touching drep_always_* (default true)
 *   topNByPower      — optional cap: only return rows whose source AND target
 *                      DReps are among the top-N DReps by current voting_power.
 *   limit            — page size (default 500, max 5000)
 *   offset           — pagination offset (default 0)
 */
export const getMigrations = async (req: Request, res: Response) => {
  try {
    // Postgres INT max — Prisma rejects MAX_SAFE_INTEGER as out-of-range for an Int column.
    const POSTGRES_INT_MAX = 2_147_483_647;

    const epochStartR = parseIntegerQuery(req.query.epochStart, "epochStart", {
      min: 0,
      max: POSTGRES_INT_MAX,
      default: 0,
    });
    if (!epochStartR.ok) return res.status(epochStartR.status).json(epochStartR);
    const epochStart = epochStartR.value;

    const epochEndR = parseIntegerQuery(req.query.epochEnd, "epochEnd", {
      min: 0,
      max: POSTGRES_INT_MAX,
      default: POSTGRES_INT_MAX,
    });
    if (!epochEndR.ok) return res.status(epochEndR.status).json(epochEndR);
    const epochEnd = epochEndR.value;

    const topNR = parseIntegerQuery(req.query.topNByPower, "topNByPower", {
      min: 0,
      default: 0,
    });
    if (!topNR.ok) return res.status(topNR.status).json(topNR);
    const topNByPower = topNR.value;

    const limitR = parseIntegerQuery(req.query.limit, "limit", {
      min: 1,
      max: MIGRATIONS_MAX_LIMIT,
      default: MIGRATIONS_DEFAULT_LIMIT,
    });
    if (!limitR.ok) return res.status(limitR.status).json(limitR);
    const limit = limitR.value;

    const offsetR = parseIntegerQuery(req.query.offset, "offset", {
      min: 0,
      default: 0,
    });
    if (!offsetR.ok) return res.status(offsetR.status).json(offsetR);
    const offset = offsetR.value;

    const fromDrepId = typeof req.query.fromDrepId === "string" ? req.query.fromDrepId : undefined;
    const toDrepId = typeof req.query.toDrepId === "string" ? req.query.toDrepId : undefined;
    const excludeSentinels = req.query.excludeSentinels !== "false";

    let topNDrepIds: string[] | null = null;
    if (topNByPower > 0) {
      const topRows = await prisma.drep.findMany({
        where: { OR: [{ doNotList: false }, { doNotList: null }] },
        orderBy: { votingPower: "desc" },
        take: topNByPower,
        select: { drepId: true },
      });
      topNDrepIds = topRows.map((r) => r.drepId);
    }

    const fromDrepIdFilter: Record<string, unknown> = {};
    if (fromDrepId) fromDrepIdFilter.equals = fromDrepId;
    if (excludeSentinels) {
      fromDrepIdFilter.notIn = [...SENTINEL_DREP_IDS];
    }
    if (topNDrepIds) {
      fromDrepIdFilter.in = topNDrepIds;
    }

    const toDrepIdFilter: Record<string, unknown> = {};
    if (toDrepId) toDrepIdFilter.equals = toDrepId;
    if (excludeSentinels) {
      toDrepIdFilter.notIn = [...SENTINEL_DREP_IDS];
    }
    if (topNDrepIds) {
      toDrepIdFilter.in = topNDrepIds;
    }

    const where = {
      epoch: { gte: epochStart, lte: epochEnd },
      ...(Object.keys(fromDrepIdFilter).length ? { fromDrepId: fromDrepIdFilter as any } : {}),
      ...(Object.keys(toDrepIdFilter).length ? { toDrepId: toDrepIdFilter as any } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.migrationAggregate.findMany({
        where,
        orderBy: [{ epoch: "asc" }, { fromDrepId: "asc" }, { toDrepId: "asc" }],
        skip: offset,
        take: limit,
      }),
      prisma.migrationAggregate.count({ where }),
    ]);

    const migrations: MigrationRow[] = rows.map((r) => ({
      epoch: r.epoch,
      fromDrepId: r.fromDrepId,
      toDrepId: r.toDrepId,
      lovelace: toLovelaceString(r.adaLovelace),
      ada: toAdaString(r.adaLovelace),
      delegators: r.delegators,
    }));

    const accuracy = await getMigrationAggregateAccuracy(prisma, {
      epochStart,
      epochEnd,
      fromDrepId,
      toDrepId,
      excludeSentinels,
      drepIdAllowlist: topNDrepIds ?? undefined,
    });

    const lastComputedAt = rows.reduce<Date | null>((acc, r) => {
      if (!acc || r.computedAt > acc) return r.computedAt;
      return acc;
    }, null);

    const response: GetMigrationsResponse = {
      migrations,
      meta: {
        epochStart,
        epochEnd: epochEnd === POSTGRES_INT_MAX ? -1 : epochEnd,
        rowCount: migrations.length,
        pagination: {
          limit,
          offset,
          total,
          hasMore: offset + migrations.length < total,
        },
        accuracy: accuracy.level,
        sourceDistribution: {
          total: accuracy.totalChangeRows,
          koiosHistory: accuracy.rowsWithKoiosHistory,
          currentProxy: accuracy.rowsWithCurrentProxy,
          unknown: accuracy.rowsUnknown,
          malformed: accuracy.rowsMalformed,
        },
        lastComputedAt: lastComputedAt ? lastComputedAt.toISOString() : null,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching migrations", formatAxiosLikeError(error));
    res.status(500).json({
      error: "Failed to fetch migrations",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
