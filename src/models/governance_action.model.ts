/**
 * Voting threshold requirements per voter type
 * null means this voter type does not participate in ratification for this action type
 */
export interface VotingThreshold {
  ccThreshold: number | null; // CC threshold (e.g., 2/3 = 0.67), null if CC doesn't vote
  drepThreshold: number; // DRep threshold (e.g., 0.67)
  spoThreshold: number | null; // SPO threshold (e.g., 0.51), null if SPO doesn't vote
}

/**
 * Voting status per voter type indicating if threshold is met
 */
export interface VotingStatus {
  ccPassing: boolean | null; // null if CC doesn't participate
  drepPassing: boolean;
  spoPassing: boolean | null; // null if SPO doesn't participate
}

export interface GovernanceAction {
  proposalId: string;
  hash: string; // txHash:certIndex format
  title: string;
  type: string;
  status: "Active" | "Ratified" | "Enacted" | "Expired" | "Closed";
  constitutionality: string;
  drep: GovernanceActionVoteInfo;
  spo?: GovernanceActionVoteInfo;
  cc?: CCGovernanceActionVoteInfo;
  totalYes: number;
  totalNo: number;
  totalAbstain: number;
  submissionEpoch: number;
  expiryEpoch: number;
  // Voting threshold and status fields
  threshold: VotingThreshold;
  votingStatus: VotingStatus;
  passing: boolean; // Overall: true if all required voter types meet their thresholds
}

export interface GovernanceActionVoteInfo {
  yesPercent: number;
  noPercent: number;
  abstainPercent: number;
  yesLovelace: string; // Voting power in lovelace (string for BigInt serialization)
  noLovelace: string;
  abstainLovelace: string;
}

export interface CCGovernanceActionVoteInfo {
  yesPercent: number;
  noPercent: number;
  abstainPercent: number;
  yesCount: number;
  noCount: number;
  abstainCount: number;
}

export interface VoteRecord {
  voterType: "DRep" | "SPO" | "CC";
  voterId: string;
  voterName?: string;
  vote: "Yes" | "No" | "Abstain";
  votingPower?: string; // Voting power in lovelace (string for BigInt serialization)
  anchorUrl?: string;
  anchorHash?: string;
  votedAt: string;
}

export interface GovernanceActionDetail extends GovernanceAction {
  description?: string;
  rationale?: string;
  votes?: VoteRecord[];
  ccVotes?: VoteRecord[];
}

export type GovernanceActionType =
  | "All"
  | "Info Action"
  | "Treasury Withdrawals"
  | "New Constitution"
  | "Hard Fork Initiation"
  | "Protocol Parameter Change"
  | "No Confidence"
  | "Update Committee";
export type VoteType = "All" | "Yes" | "No" | "Abstain";

export interface NCLData {
  year: number;
  currentValue: string; // In lovelace (string for BigInt serialization)
  targetValue: string;  // In lovelace (string for BigInt serialization)
}

export interface ProposalSummary {
  totalProposals: number;
  activeProposals: number;
  ratifiedProposals: number;
  enactedProposals: number;
  expiredProposals: number;
  closedProposals: number; // Only for INFO governance actions
}
