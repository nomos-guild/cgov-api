import { Request, Response } from "express";
import { prisma } from "../../services/prisma";
import { cacheGet, cacheSet } from "../../services/cache";
import type { DevelopmentRecentResponse } from "../../responses";

const TTL = 60 * 1000; // 1 min

export const getRecent = async (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10) || 50, 200);
  const offset = Math.max(0, parseInt((req.query.offset as string) || "0", 10) || 0);

  const cacheKey = `dev:recent:${limit}:${offset}`;
  const cached = cacheGet<DevelopmentRecentResponse>(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [events, total] = await Promise.all([
      prisma.activityRecent.findMany({
        orderBy: { eventDate: "desc" },
        take: limit,
        skip: offset,
        select: {
          id: true,
          repoId: true,
          eventType: true,
          eventId: true,
          title: true,
          authorLogin: true,
          eventDate: true,
          repository: { select: { owner: true, name: true } },
        },
      }),
      prisma.activityRecent.count(),
    ]);

    const response: DevelopmentRecentResponse = {
      events: events.map((e) => ({
        id: e.id,
        repoId: e.repoId,
        repoName: e.repository ? `${e.repository.owner}/${e.repository.name}` : null,
        eventType: e.eventType,
        eventId: e.eventId,
        title: e.title,
        authorLogin: e.authorLogin,
        eventDate: e.eventDate.toISOString(),
      })),
      total,
    };

    cacheSet(cacheKey, response, TTL);
    res.json(response);
  } catch (error) {
    console.error("Error fetching recent activity", error);
    res.status(500).json({
      error: "Failed to fetch recent activity",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
