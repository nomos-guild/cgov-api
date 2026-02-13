import { Request, Response } from "express";
import { prisma } from "../../services/prisma";
import { getRateLimitState } from "../../services/github-graphql";
import type { GithubStatusResponse } from "../../responses";

export const getStatus = async (_req: Request, res: Response) => {
  try {
    const [total, active, moderate, dormant, backfilled] = await Promise.all([
      prisma.githubRepository.count(),
      prisma.githubRepository.count({ where: { syncTier: "active" } }),
      prisma.githubRepository.count({ where: { syncTier: "moderate" } }),
      prisma.githubRepository.count({ where: { syncTier: "dormant" } }),
      prisma.githubRepository.count({ where: { backfilledAt: { not: null } } }),
    ]);

    const rl = getRateLimitState();

    const response: GithubStatusResponse = {
      discovery: {
        totalRepos: total,
        activeRepos: active,
        moderateRepos: moderate,
        dormantRepos: dormant,
      },
      backfill: {
        totalRepos: total,
        backfilledRepos: backfilled,
        pendingRepos: total - backfilled,
        percentComplete: total > 0 ? Math.round((backfilled / total) * 1000) / 10 : 0,
      },
      rateLimit: {
        remaining: rl.remaining,
        limit: 5000,
        resetAt: rl.resetAt.getTime() > 0 ? rl.resetAt.toISOString() : null,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching status", error);
    res.status(500).json({
      error: "Failed to fetch status",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
