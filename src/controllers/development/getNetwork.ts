import { Request, Response } from "express";
import { getCachedGraph, precomputeNetworkGraphs } from "../../services/ingestion/github-aggregation";
import { cacheGet, cacheSet } from "../../services/cache";
import type { DevelopmentNetworkResponse, OrgBreakdown } from "../../responses";
import { RANGE_DAYS } from "../../constants/development";

const TTL = 30 * 60 * 1000; // 30 min

export const getNetwork = async (req: Request, res: Response) => {
  const range = (req.query.range as string) || "90d";

  if (!RANGE_DAYS[range]) {
    return res.status(400).json({ error: "Invalid range", message: `Valid: ${Object.keys(RANGE_DAYS).join(", ")}` });
  }

  const cacheKey = `dev:network:${range}`;
  const cached = cacheGet<DevelopmentNetworkResponse>(cacheKey);
  if (cached) return res.json(cached);

  try {
    const days = RANGE_DAYS[range];
    let graph = getCachedGraph(days);

    if (!graph) {
      await precomputeNetworkGraphs();
      graph = getCachedGraph(days);
    }

    if (!graph) {
      return res.status(503).json({ error: "Graph not available", message: "Graph is still being computed" });
    }

    // Derive org breakdown from graph nodes + edges
    const orgNodes = graph.nodes.filter((n) => n.type === "org");
    const orgContributors = new Map<string, Set<string>>();

    for (const edge of graph.edges) {
      if (edge.source.startsWith("dev:") && edge.target.startsWith("repo:")) {
        const devLogin = edge.source.replace("dev:", "");
        const repoId = edge.target.replace("repo:", "");
        const [owner] = repoId.split("/");
        if (!orgContributors.has(owner)) orgContributors.set(owner, new Set());
        orgContributors.get(owner)!.add(devLogin);
      }
    }

    const orgBreakdown: OrgBreakdown[] = orgNodes
      .map((node) => ({
        org: node.label,
        repoCount: (node.meta?.repoCount as number) ?? 0,
        commitCount: (node.meta?.commitCount as number) ?? 0,
        contributorCount: orgContributors.get(node.label)?.size ?? 0,
      }))
      .sort((a, b) => b.commitCount - a.commitCount);

    const response: DevelopmentNetworkResponse = {
      ...graph,
      orgBreakdown,
    };

    cacheSet(cacheKey, response, TTL);
    res.json(response);
  } catch (error) {
    console.error("Error fetching network graph", error);
    res.status(500).json({
      error: "Failed to fetch network graph",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
