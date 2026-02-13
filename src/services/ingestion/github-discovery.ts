import { prisma } from "../prisma";
import { githubGraphQL, buildBatchRepoQuery, getRateLimitState } from "../github-graphql";
import { SEED_ORGS, SEED_REPOS } from "./ecosystem-seed";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  total: number;
  newRepos: number;
  updatedRepos: number;
  errors: Array<{ strategy: string; error: string }>;
}

interface SearchRepoNode {
  databaseId: number | null;
  nameWithOwner: string;
  owner: { login: string };
  name: string;
  description: string | null;
  primaryLanguage: { name: string } | null;
  stargazerCount: number;
  forkCount: number;
  isFork: boolean;
  isArchived: boolean;
  createdAt: string;
  pushedAt: string | null;
}

interface SearchResponse {
  search: {
    repositoryCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: SearchRepoNode[];
  };
}

// ─── Search Strategies ───────────────────────────────────────────────────────

const TOPIC_STRATEGIES = [
  { query: "topic:cardano stars:>100", label: "topic:cardano high-stars" },
  { query: "topic:cardano stars:10..100", label: "topic:cardano mid-stars" },
  { query: "topic:cardano stars:0..10", label: "topic:cardano low-stars" },
  { query: "topic:plutus", label: "topic:plutus" },
  { query: "topic:aiken", label: "topic:aiken" },
  { query: "topic:cardano-blockchain", label: "topic:cardano-blockchain" },
  { query: "cardano in:name,description", label: "keyword:cardano" },
];

const HARDCODED_ORGS = ["IntersectMBO", "input-output-hk", "cardano-foundation"];

function buildSearchStrategies(): Array<{ query: string; label: string }> {
  const allOrgs = new Set([...HARDCODED_ORGS, ...SEED_ORGS]);
  const orgStrategies = [...allOrgs].map((org) => ({
    query: `org:${org}`,
    label: `org:${org}`,
  }));
  return [...TOPIC_STRATEGIES, ...orgStrategies];
}

const SEARCH_QUERY = `
  query SearchRepos($query: String!, $first: Int!, $after: String) {
    search(query: $query, type: REPOSITORY, first: $first, after: $after) {
      repositoryCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on Repository {
          databaseId
          nameWithOwner
          owner { login }
          name
          description
          primaryLanguage { name }
          stargazerCount
          forkCount
          isFork
          isArchived
          createdAt
          pushedAt
        }
      }
    }
  }
`;

// ─── Seed Repo Fetch ────────────────────────────────────────────────────────

const SEED_REPO_FRAGMENT = `
  databaseId
  nameWithOwner
  owner { login }
  name
  description
  primaryLanguage { name }
  stargazerCount
  forkCount
  isFork
  isArchived
  createdAt
  pushedAt
`;

async function fetchSeedRepos(): Promise<SearchRepoNode[]> {
  if (SEED_REPOS.length === 0) return [];

  const repos = SEED_REPOS.map((r) => {
    const [owner, name] = r.split("/");
    return { owner, name };
  });

  const BATCH_SIZE = 20;
  const allNodes: SearchRepoNode[] = [];

  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    const query = buildBatchRepoQuery(batch, SEED_REPO_FRAGMENT);

    try {
      const data = await githubGraphQL<Record<string, SearchRepoNode | null>>(query);
      for (const [, node] of Object.entries(data)) {
        if (node && node.databaseId != null) {
          allNodes.push(node);
        }
      }
    } catch (error: any) {
      console.error(`[discovery] Seed repo batch ${i} failed:`, error.message);
    }
  }

  console.log(
    `[discovery] Seed repos: fetched ${allNodes.length}/${SEED_REPOS.length} ` +
      `(rate limit: ${getRateLimitState().remaining})`
  );
  return allNodes;
}

// ─── Search Strategy ────────────────────────────────────────────────────────

async function searchStrategy(
  strategy: { query: string; label: string }
): Promise<SearchRepoNode[]> {
  const allNodes: SearchRepoNode[] = [];
  let cursor: string | null = null;
  let page = 0;

  while (true) {
    const data = await githubGraphQL<SearchResponse>(SEARCH_QUERY, {
      query: strategy.query,
      first: 100,
      after: cursor,
    });

    const nodes = data.search.nodes.filter((n) => n.databaseId != null);
    allNodes.push(...nodes);
    page++;

    const { hasNextPage, endCursor } = data.search.pageInfo;
    if (!hasNextPage || page >= 10) break; // max 1000 results (10 pages × 100)
    cursor = endCursor;
  }

  console.log(
    `[discovery] Strategy "${strategy.label}": found ${allNodes.length} repos ` +
      `(rate limit: ${getRateLimitState().remaining})`
  );
  return allNodes;
}

export async function discoverRepositories(): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    total: 0,
    newRepos: 0,
    updatedRepos: 0,
    errors: [],
  };

  const strategies = buildSearchStrategies();
  console.log(`[discovery] Running ${strategies.length} strategies (${SEED_ORGS.length} seed orgs, ${SEED_REPOS.length} seed repos)`);

  // Collect all repos from all strategies, dedup by githubId
  const seen = new Map<number, { node: SearchRepoNode; via: string[] }>();

  for (const strategy of strategies) {
    try {
      const nodes = await searchStrategy(strategy);
      for (const node of nodes) {
        const existing = seen.get(node.databaseId!);
        if (existing) {
          existing.via.push(strategy.label);
        } else {
          seen.set(node.databaseId!, { node, via: [strategy.label] });
        }
      }
    } catch (error: any) {
      console.error(`[discovery] Strategy "${strategy.label}" failed:`, error.message);
      result.errors.push({ strategy: strategy.label, error: error.message });
    }
  }

  // Fetch individually listed seed repos
  try {
    const seedNodes = await fetchSeedRepos();
    for (const node of seedNodes) {
      const existing = seen.get(node.databaseId!);
      if (existing) {
        existing.via.push("seed-repo");
      } else {
        seen.set(node.databaseId!, { node, via: ["seed-repo"] });
      }
    }
  } catch (error: any) {
    console.error("[discovery] Seed repo fetch failed:", error.message);
    result.errors.push({ strategy: "seed-repos", error: error.message });
  }

  result.total = seen.size;
  console.log(`[discovery] Total unique repos after dedup: ${result.total}`);

  // Upsert all repos
  for (const [githubId, { node, via }] of seen) {
    try {
      const id = `${node.owner.login}/${node.name}`;
      const data = {
        githubId,
        owner: node.owner.login,
        name: node.name,
        description: node.description,
        language: node.primaryLanguage?.name ?? null,
        stars: node.stargazerCount,
        forks: node.forkCount,
        isFork: node.isFork,
        isArchived: node.isArchived,
        repoCreatedAt: new Date(node.createdAt),
        lastActivityAt: node.pushedAt ? new Date(node.pushedAt) : null,
        discoveredVia: via,
      };

      const existing = await prisma.githubRepository.findUnique({
        where: { id },
        select: { id: true },
      });

      if (existing) {
        await prisma.githubRepository.update({
          where: { id },
          data: {
            ...data,
            discoveredVia: {
              set: via,
            },
          },
        });
        result.updatedRepos++;
      } else {
        await prisma.githubRepository.create({
          data: { id, ...data },
        });
        result.newRepos++;
      }
    } catch (error: any) {
      result.errors.push({
        strategy: `upsert:${node.nameWithOwner}`,
        error: error.message,
      });
    }
  }

  console.log(
    `[discovery] Complete: ${result.newRepos} new, ${result.updatedRepos} updated, ` +
      `${result.errors.length} errors`
  );
  return result;
}
