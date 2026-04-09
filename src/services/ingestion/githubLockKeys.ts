export const GITHUB_LOCK_KEYS = {
  discovery: "github-discovery",
  activity: "github-activity",
  backfill: "github-backfill",
  snapshot: "github-snapshot",
  aggregation: "github-aggregation",
} as const;

export type GithubLockKey =
  (typeof GITHUB_LOCK_KEYS)[keyof typeof GITHUB_LOCK_KEYS];
