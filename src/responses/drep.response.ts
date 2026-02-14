/**
 * DRep Dashboard Response Types
 */

/**
 * DRep summary for listing
 */
export interface DRepSummary {
  drepId: string;
  name: string | null;
  iconUrl: string | null;
  /** Voting power in lovelace (as string for BigInt serialization) */
  votingPower: string;
  /** Voting power in ADA (converted from lovelace) */
  votingPowerAda: string;
  /** Total number of votes cast by this DRep */
  totalVotesCast: number;
  /** Number of delegators to this DRep */
  delegatorCount: number | null;
}

/**
 * Paginated list of DReps
 */
export interface GetDRepsResponse {
  dreps: DRepSummary[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

/**
 * Aggregate DRep statistics
 */
export interface GetDRepStatsResponse {
  /** Total number of DReps in the system */
  totalDReps: number;
  /** Total delegated voting power in lovelace (as string for BigInt) */
  totalDelegatedLovelace: string;
  /** Total delegated voting power in ADA */
  totalDelegatedAda: string;
  /** Total number of votes cast by all DReps */
  totalVotesCast: number;
  /** Number of DReps who have cast at least one vote */
  activeDReps: number;
  /** Total number of delegators across all DReps */
  totalDelegators: number;
}

/**
 * Vote breakdown counts
 */
export interface VoteBreakdown {
  yes: number;
  no: number;
  abstain: number;
}

/**
 * Detailed DRep profile
 */
export interface GetDRepDetailResponse {
  drepId: string;
  name: string | null;
  iconUrl: string | null;
  paymentAddr: string | null;
  /** Voting power in lovelace (as string for BigInt serialization) */
  votingPower: string;
  /** Voting power in ADA */
  votingPowerAda: string;
  /** Total number of votes cast */
  totalVotesCast: number;
  /** Breakdown of votes by type */
  voteBreakdown: VoteBreakdown;
  /** Number of votes with rationale provided */
  rationalesProvided: number;
  /** Percentage of proposals this DRep has voted on (0-100) */
  proposalParticipationPercent: number;
  /** Number of delegators to this DRep */
  delegatorCount: number | null;
  /** CIP-119: Short biography */
  bio: string | null;
  /** CIP-119: Motivations for becoming a DRep */
  motivations: string | null;
  /** CIP-119: Goals and objectives */
  objectives: string | null;
  /** CIP-119: Relevant qualifications */
  qualifications: string | null;
  /** CIP-119: References (JSON string of array) */
  references: string | null;
  /** Epoch when the DRep first registered */
  registeredEpoch: number | null;
  /** ISO date string of the registration epoch start time */
  registeredDate: string | null;
}

/**
 * Single vote record in voting history
 */
export interface DRepVoteRecord {
  /** Proposal ID */
  proposalId: string;
  /** Proposal title */
  proposalTitle: string;
  /** Governance action type */
  proposalType: string | null;
  /** Vote cast (YES, NO, ABSTAIN) */
  vote: string;
  /** Voting power at time of vote (lovelace as string) */
  votingPower: string | null;
  /** Vote rationale text (parsed from metadata) */
  rationale: string | null;
  /** Anchor URL for rationale */
  anchorUrl: string | null;
  /** Timestamp when vote was cast */
  votedAt: string | null;
  /** Transaction hash */
  txHash: string;
}

/**
 * Paginated voting history for a DRep
 */
export interface GetDRepVotesResponse {
  drepId: string;
  votes: DRepVoteRecord[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

/**
 * Single data point in DRep history time series
 */
export interface DRepHistoryDataPoint {
  /** Epoch number */
  epoch: number;
  /** Epoch start date (ISO string) */
  date: string | null;
  /** Delegator count at this epoch */
  delegatorCount: number;
  /** Voting power in lovelace (as string for BigInt serialization) */
  votingPower: string;
  /** Voting power in ADA */
  votingPowerAda: string;
}

/**
 * DRep history time series for line charts
 */
export interface GetDRepHistoryResponse {
  drepId: string;
  history: DRepHistoryDataPoint[];
}
