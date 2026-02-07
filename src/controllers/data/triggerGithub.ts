import { Request, Response } from "express";
import { discoverRepositories } from "../../services/ingestion/github-discovery";
import { syncActiveRepos, syncModerateRepos, syncDormantRepos, snapshotAllRepos } from "../../services/ingestion/github-activity";
import { backfillRepositories } from "../../services/ingestion/github-backfill";
import { cacheInvalidatePrefix } from "../../services/cache";

let discoveryInProgress = false;
let syncInProgress = false;
let backfillInProgress = false;
let snapshotInProgress = false;

export const postTriggerDiscovery = async (_req: Request, res: Response) => {
  if (discoveryInProgress) {
    return res.status(429).json({ error: "Discovery already in progress" });
  }
  discoveryInProgress = true;
  try {
    const result = await discoverRepositories();
    res.json({ success: true, result });
  } catch (error) {
    console.error("Discovery failed", error);
    res.status(500).json({
      error: "Discovery failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    discoveryInProgress = false;
  }
};

export const postTriggerSync = async (req: Request, res: Response) => {
  if (syncInProgress) {
    return res.status(429).json({ error: "Sync already in progress" });
  }
  syncInProgress = true;
  const tier = (req.query.tier as string) || "all";

  try {
    let result;
    if (tier === "active") {
      result = await syncActiveRepos();
    } else if (tier === "moderate") {
      result = await syncModerateRepos();
    } else if (tier === "dormant") {
      result = await syncDormantRepos();
    } else {
      const active = await syncActiveRepos();
      const moderate = await syncModerateRepos();
      const dormant = await syncDormantRepos();
      result = {
        active,
        moderate,
        dormant,
        total: active.total + moderate.total + dormant.total,
        success: active.success + moderate.success + dormant.success,
        failed: active.failed + moderate.failed + dormant.failed,
      };
    }
    cacheInvalidatePrefix("dev:");
    res.json({ success: true, result });
  } catch (error) {
    console.error("Sync failed", error);
    res.status(500).json({
      error: "Sync failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    syncInProgress = false;
  }
};

export const postTriggerBackfill = async (req: Request, res: Response) => {
  if (backfillInProgress) {
    return res.status(429).json({ error: "Backfill already in progress" });
  }
  backfillInProgress = true;
  const limit = Math.max(1, parseInt((req.query.limit as string) || "50", 10) || 50);
  const minStars = Math.max(0, parseInt((req.query.minStars as string) || "0", 10) || 0);

  try {
    const result = await backfillRepositories({ limit, minStars });
    res.json({ success: true, result });
  } catch (error) {
    console.error("Backfill failed", error);
    res.status(500).json({
      error: "Backfill failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    backfillInProgress = false;
  }
};

export const postTriggerSnapshot = async (_req: Request, res: Response) => {
  if (snapshotInProgress) {
    return res.status(429).json({ error: "Snapshot already in progress" });
  }
  snapshotInProgress = true;
  try {
    const result = await snapshotAllRepos();
    res.json({ success: true, result });
  } catch (error) {
    console.error("Snapshot failed", error);
    res.status(500).json({
      error: "Snapshot failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    snapshotInProgress = false;
  }
};
