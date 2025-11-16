/**
 * Koios API Type Definitions
 * API Documentation: https://api.koios.rest/#overview
 *
 * Field mappings based on Prisma schema inline documentation
 */

/**
 * Proposal from Koios API
 * Endpoint: GET /proposal_list
 */
export interface KoiosProposal {
  proposal_id: string; // Maps to Proposal.proposalId
  proposal_tx_hash: string; // Maps to Proposal.txHash
  proposal_index: number; // Maps to Proposal.certIndex
  proposal_type: string; // Maps to Proposal.governanceActionType
  proposed_epoch: number; // Maps to Proposal.submissionEpoch
  ratified_epoch?: number | null; // Used to derive status
  enacted_epoch?: number | null; // Used to derive status
  dropped_epoch?: number | null; // Used to derive status
  expired_epoch?: number | null; // Maps to Proposal.expiryEpoch, used to derive status
  meta_url?: string | null; // Fallback for metadata fetch
  meta_hash?: string | null;
  meta_json?: {
    body?: {
      title?: string; // Maps to Proposal.title
      abstract?: string; // Maps to Proposal.description
      rationale?: string; // Maps to Proposal.rationale
    };
  } | null;
  block_time?: number;
}

/**
 * Vote from Koios API
 * Endpoint: GET /vote_list
 */
export interface KoiosVote {
  vote_tx_hash: string; // Maps to OnchainVote.txHash
  proposal_id: string; // Maps to OnchainVote.proposalId (need to look up)
  voter_role: "DRep" | "SPO" | "ConstitutionalCommittee"; // Maps to OnchainVote.voterType
  voter_id: string; // Maps to OnchainVote.drepId/spoId/ccId
  vote: "Yes" | "No" | "Abstain"; // Maps to OnchainVote.vote
  meta_url?: string | null; // Maps to OnchainVote.anchorUrl
  meta_hash?: string | null; // Maps to OnchainVote.anchorHash
  meta_json?: {
    authors?: Array<{
      name?: string; // For CC votes, this is the member name
      witness?: any;
    }>;
    body?: any;
  } | null;
  block_time?: number; // Maps to OnchainVote.votedAt (convert to DateTime)
}

/**
 * DRep Info from Koios API
 * Endpoint: GET /drep_info
 */
export interface KoiosDrep {
  drep_id: string; // Maps to Drep.drepId
  hex?: string;
  has_script?: boolean;
  registered?: boolean;
}

/**
 * DRep Voting Power from Koios API
 * Endpoint: GET /drep_voting_power_history
 */
export interface KoiosDrepVotingPower {
  drep_id: string;
  epoch_no: number;
  amount: string; // Maps to Drep.votingPower (convert lovelace to ADA)
}

/**
 * Pool Info from Koios API
 * Endpoint: POST /pool_info
 */
export interface KoiosSpo {
  pool_id_bech32: string; // Maps to SPO.poolId
  pool_id_hex?: string;
  meta_url?: string | null; // Fetch this URL to get pool name
  meta_json?: {
    name?: string; // Maps to SPO.poolName
    ticker?: string; // Maps to SPO.ticker (preferred source)
  } | null;
  active_stake?: string;
  live_stake?: string;
  voting_power?: string;
}

/**
 * Pool Voting Power from Koios API
 * Endpoint: GET /pool_voting_power_history
 */
export interface KoiosSpoVotingPower {
  pool_id_bech32: string;
  epoch_no: number;
  amount: string; // Maps to SPO.votingPower (convert lovelace to ADA)
}

/**
 * Constitutional Committee Info from Koios API
 * Endpoint: GET /committee_info
 */
export interface KoiosCommitteeInfo {
  members: Array<{
    cc_hot_id: string; // Maps to CC.ccId and CC.hotCredential
    cc_cold_id: string; // Maps to CC.coldCredential
    expiration_epoch: number; // Used to derive CC.status
  }>;
}

/**
 * Committee Votes from Koios API
 * Endpoint: GET /committee_votes
 * Used to fetch member name from meta_url
 */
export interface KoiosCommitteeVote {
  cc_hot_id: string;
  meta_url?: string | null; // Fetch to get authors[].name for CC.memberName
  meta_hash?: string | null;
}

/**
 * Tip (Current Epoch) from Koios API
 * Endpoint: GET /tip
 */
export interface KoiosTip {
  epoch_no: number; // Current epoch number
  block_no: number;
  block_time: number;
  hash: string;
}

/**
 * Generic Koios API Response wrapper
 */
export interface KoiosResponse<T> {
  data: T;
  // Koios might have pagination or metadata fields
}

/**
 * Koios API Error Response
 */
export interface KoiosError {
  error: string;
  message?: string;
  status_code?: number;
}
