import type { NetworkGraphData } from "../services/ingestion/github-aggregation";

// ─── Overview KPIs ──────────────────────────────────────────────────────────

export interface DevelopmentOverviewResponse {
  activeRepos: number;
  totalContributors: number;
  totalCommits: number;
  totalPRs: number;
  avgMergeTimeHours: number | null;
  period: { from: string; to: string };
  previous?: {
    activeRepos: number;
    totalContributors: number;
    totalCommits: number;
    totalPRs: number;
    avgMergeTimeHours: number | null;
  };
}

// ─── Activity Time-Series ───────────────────────────────────────────────────

export interface ActivityDataPoint {
  date: string;
  commits: number;
  prOpened: number;
  prMerged: number;
  issuesOpened: number;
  issuesClosed: number;
}

export interface DevelopmentActivityResponse {
  range: string;
  data: ActivityDataPoint[];
  previous?: ActivityDataPoint[];
}

// ─── Top Repos ──────────────────────────────────────────────────────────────

export interface RepoSummary {
  id: string;
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  recentCommits: number;
  recentPRs: number;
  lastActivityAt: string | null;
  syncTier: string;
  starGain: number;
}

export interface DevelopmentReposResponse {
  repos: RepoSummary[];
  total: number;
}

// ─── Top Contributors ───────────────────────────────────────────────────────

export interface ContributorSummary {
  login: string;
  avatarUrl: string | null;
  totalCommits: number;
  totalPRs: number;
  repoCount: number;
  orgCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  isActive: boolean;
}

export interface DevelopmentContributorsResponse {
  contributors: ContributorSummary[];
  total: number;
  range: string;
}

// ─── Health Metrics ─────────────────────────────────────────────────────────

export interface DevelopmentHealthPrevious {
  maintenanceRate: number;
  avgMergeTimeHours: number | null;
  prCloseRate: number;
  issueCloseRate: number;
  retentionRate: number | null;
  codeVelocity: number | null;
  avgIssueResolutionHours: number | null;
  releaseCadence: number;
  ecosystemGrowthRate: number | null;
  forkActivityRate: number | null;
}

export interface DevelopmentHealthResponse {
  range: string;
  activeRepos: number;
  dormantRepos: number;
  maintenanceRate: number;
  avgMergeTimeHours: number | null;
  prCloseRate: number;
  issueCloseRate: number;
  newContributors: number;
  returningContributors: number;
  retentionRate: number | null;
  ghostingRate: number | null;
  abandonmentRate: number | null;
  codeVelocity: number | null;
  avgIssueResolutionHours: number | null;
  releaseCadence: number;
  ecosystemGrowthRate: number | null;
  forkActivityRate: number | null;
  starConcentration: number | null;
  previous?: DevelopmentHealthPrevious;
}

// ─── Star/Fork Trends ───────────────────────────────────────────────────────

export interface StarDataPoint {
  date: string;
  totalStars: number;
  totalForks: number;
}

export interface StarRepoShare {
  id: string;
  name: string;
  stars: number;
  share: number;
}

export interface DevelopmentStarsResponse {
  range: string;
  data: StarDataPoint[];
  topReposByStars: StarRepoShare[];
}

// ─── Language Distribution ──────────────────────────────────────────────────

export interface LanguageBreakdown {
  language: string;
  repoCount: number;
  totalStars: number;
  totalCommits: number;
}

export interface DevelopmentLanguagesResponse {
  languages: LanguageBreakdown[];
  previous?: LanguageBreakdown[];
}

// ─── Network Graph ──────────────────────────────────────────────────────────

export interface OrgBreakdown {
  org: string;
  repoCount: number;
  commitCount: number;
  contributorCount: number;
}

export interface DevelopmentNetworkResponse extends NetworkGraphData {
  orgBreakdown: OrgBreakdown[];
}

// ─── Recent Activity Feed ───────────────────────────────────────────────────

export interface RecentActivityItem {
  id: string;
  repoId: string;
  repoName: string | null;
  eventType: string;
  eventId: string;
  title: string | null;
  authorLogin: string | null;
  eventDate: string;
}

export interface DevelopmentRecentResponse {
  events: RecentActivityItem[];
  total: number;
}

// ─── Admin Status ───────────────────────────────────────────────────────────

export interface GithubStatusResponse {
  discovery: {
    totalRepos: number;
    activeRepos: number;
    moderateRepos: number;
    dormantRepos: number;
  };
  backfill: {
    totalRepos: number;
    backfilledRepos: number;
    pendingRepos: number;
    percentComplete: number;
  };
  rateLimit: {
    remaining: number;
    limit: number;
    resetAt: string | null;
  };
}
