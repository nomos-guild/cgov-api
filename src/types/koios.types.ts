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
/**
 * Treasury withdrawal entry in a proposal
 * For TreasuryWithdrawals proposals - single object with amount and stake_address
 */
export interface KoiosTreasuryWithdrawal {
  stake_address: string; // Recipient stake address
  amount: string; // Amount in lovelace
}

export interface KoiosProposal {
  proposal_id: string; // Maps to proposal.proposal_id
  proposal_tx_hash: string; // Maps to proposal.tx_hash
  proposal_index: number; // Maps to proposal.cert_index
  proposal_type: string; // Maps to proposal.governance_action_type
  proposed_epoch: number; // Maps to proposal.submission_epoch
  ratified_epoch?: number | null; // Maps to proposal.ratified_epoch
  enacted_epoch?: number | null; // Maps to proposal.enacted_epoch
  dropped_epoch?: number | null; // Maps to proposal.dropped_epoch
  expired_epoch?: number | null; // Maps to proposal.expired_epoch
  expiration?: number | null; // Maps to proposal.expiration_epoch (epoch when voting ends)
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
  // Treasury withdrawal specific field (only for TreasuryWithdrawals proposals)
  // Single object with amount and stake_address
  withdrawal?: KoiosTreasuryWithdrawal | null;
}

/**
 * Vote from Koios API
 * Endpoint: GET /vote_list
 */
export interface KoiosVote {
  vote_tx_hash: string; // Maps to onchain_vote.tx_hash
  proposal_id: string; // Maps to onchain_vote.proposal_id (need to look up)
  voter_role: "DRep" | "SPO" | "ConstitutionalCommittee"; // Maps to onchain_vote.voter_type
  voter_id: string; // Maps to onchain_vote.drep_id/spo_id/cc_id
  vote: "Yes" | "No" | "Abstain"; // Maps to onchain_vote.vote
  meta_url?: string | null; // Maps to onchain_vote.anchor_url
  meta_hash?: string | null; // Maps to onchain_vote.anchor_hash
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
 * Constitutional Committee Member from Koios API
 */
export interface KoiosCommitteeMember {
  status: "authorized" | "resigned"; // Member state
  cc_hot_id: string | null; // Hot credential (null if resigned)
  cc_cold_id: string; // Cold credential
  cc_hot_hex: string | null; // Hot credential hex
  cc_cold_hex: string; // Cold credential hex
  expiration_epoch: number; // When member authorization expires
  cc_hot_has_script: boolean | null; // Whether hot credential has script
  cc_cold_has_script: boolean; // Whether cold credential has script
}

/**
 * Constitutional Committee Info from Koios API
 * Endpoint: GET /committee_info
 */
export interface KoiosCommitteeInfo {
  proposal_id: string; // Governance action that established this committee
  proposal_tx_hash: string; // Transaction hash of the proposal
  proposal_index: number; // Index of the proposal
  quorum_numerator: number; // Voting threshold numerator (e.g., 2)
  quorum_denominator: number; // Voting threshold denominator (e.g., 3 for 2/3)
  members: KoiosCommitteeMember[];
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

/**
 * Proposal Voting Summary from Koios API
 * Endpoint: GET /proposal_voting_summary
 */
export interface KoiosProposalVotingSummary {
  proposal_id: string;
  // DRep voting power
  drep_active_yes_vote_power: string | null;
  drep_active_no_vote_power: string | null;
  drep_active_abstain_vote_power: string | null;
  drep_always_abstain_vote_power: string | null;
  drep_always_no_confidence_vote_power: string | null;
  // SPO/Pool voting power (Koios uses "pool_" prefix)
  pool_active_yes_vote_power: string | null;
  pool_active_no_vote_power: string | null;
  pool_active_abstain_vote_power: string | null;
  pool_passive_always_abstain_vote_power: string | null;
  pool_passive_always_no_confidence_vote_power: string | null;
  // SPO calculated total "No" power (includes notVoted + alwaysNoConfidence + explicit no)
  pool_no_vote_power: string | null;
  // CC votes
  cc_yes_vote: number | null;
  cc_no_vote: number | null;
  cc_abstain_vote: number | null;
}

/**
 * DRep Epoch Summary from Koios API
 * Endpoint: GET /drep_epoch_summary
 */
export interface KoiosDrepEpochSummary {
  epoch_no: number;
  amount: string; // Total DRep voting power for the epoch
}

/**
 * DRep List Entry from Koios API
 * Endpoint: GET /drep_list
 */
export interface KoiosDrepListEntry {
  drep_id: string;
  hex: string;
  has_script: boolean;
  registered: boolean;
}

/**
 * DRep Info from Koios API (POST version with detailed info)
 * Endpoint: POST /drep_info
 */
export interface KoiosDrepInfo {
  drep_id: string;
  hex?: string;
  has_script?: boolean;
  registered?: boolean;
  deposit?: string | null;
  active?: boolean;
  expires_epoch_no?: number | null;
  amount?: string; // Voting power in lovelace
  meta_url?: string | null;
  meta_hash?: string | null;
}

/**
 * Epoch Totals from Koios API
 * Endpoint: GET /totals?_epoch_no=<E>
 */
export interface KoiosTotals {
  epoch_no: number;
  circulation?: string | null;
  treasury?: string | null;
  reward?: string | null;
  supply?: string | null;
  reserves?: string | null;
}

/**
 * Stake Account List from Koios API
 * Endpoint: GET /account_list
 */
export interface KoiosAccountListEntry {
  stake_address: string;
  stake_address_hex?: string | null;
  script_hash?: string | null;
}

/**
 * DRep Delegators from Koios API
 * Endpoint: GET /drep_delegators?_drep_id=<drepId>
 *
 * Note: Koios responses for delegators include `stake_address` and `amount`
 * (lovelace). Some deployments may include `epoch_no`.
 */
export interface KoiosDrepDelegator {
  stake_address: string;
  amount: string;
  epoch_no?: number | null;
}

/**
 * Stake Account Update History from Koios API
 * Endpoint: POST /account_update_history
 */
export interface KoiosAccountUpdateHistoryEntry {
  stake_address: string;
  action_type: string;
  tx_hash?: string | null;
  epoch_no?: number | null;
  epoch_slot?: number | null;
  absolute_slot?: number | null;
  block_time?: number | null;
  drep_id?: string | null;
  delegated_drep?: string | null;
  drep?: string | null;
  pool_id?: string | null;
  pool_id_bech32?: string | null;
  info?: {
    drep_id?: string | null;
    delegated_drep?: string | null;
    drep?: string | null;
  } | null;
}

/**
 * Transaction Info from Koios API
 * Endpoint: POST /tx_info
 *
 * We only model the fields we need for delegation backfills.
 */
export interface KoiosTxInfoCertificate {
  type: string;
  index?: number | null;
  info?: Record<string, unknown> | null;
}

export interface KoiosTxInfo {
  tx_hash: string;
  epoch_no?: number | null;
  epoch_slot?: number | null;
  absolute_slot?: number | null;
  tx_timestamp?: number | null;
  certificates?: KoiosTxInfoCertificate[] | null;
}

/**
 * DRep Updates from Koios API
 * Endpoint: GET /drep_updates?_drep_id=<drepId>
 * Used for DRep lifecycle events (registration, deregistration, updates)
 */
export interface KoiosDrepUpdate {
  drep_id: string;
  hex?: string | null;
  has_script?: boolean | null;
  update_tx_hash: string;
  cert_index?: number | null;
  block_time: number; // Unix timestamp
  /**
   * Effective action for this DRep Update certificate.
   * Koios docs: allowed values are "updated" | "registered" | "deregistered".
   */
  action?: "updated" | "registered" | "deregistered" | string;
  deposit?: string | null;
  meta_url?: string | null;
  meta_hash?: string | null;
  meta_json?: {
    body?: {
      givenName?: unknown;
      paymentAddress?: unknown;
      doNotList?: unknown;
      image?: {
        contentUrl?: unknown;
      };
    };
  } | null;
}

/**
 * Pool Groups from Koios API
 * Endpoint: GET /pool_groups
 * Maps pools to multi-pool operator entities
 */
export interface KoiosPoolGroup {
  pool_id_bech32: string; // Pool ID in bech32 format
  pool_id_hex?: string | null;
  pool_group?: string | null; // Shared group identifier (e.g. multi-pool operator tag)
  ticker?: string | null; // Pool ticker
  adastat_group?: string | null; // AdaStat entity/group label
  balanceanalytics_group?: string | null; // BalanceAnalytics entity/group label
}

/**
 * Epoch Info from Koios API
 * Endpoint: GET /epoch_info?_epoch_no=<epoch>
 * Provides epoch timestamps for wall-clock calculations
 */
export interface KoiosEpochInfo {
  epoch_no: number;
  out_sum?: string | null;
  fees?: string | null;
  tx_count?: number | null;
  blk_count?: number | null;
  start_time?: number | null; // Unix timestamp
  end_time?: number | null; // Unix timestamp
  first_block_time?: number | null; // Unix timestamp
  last_block_time?: number | null; // Unix timestamp
  active_stake?: string | null;
  total_rewards?: string | null;
  avg_blk_reward?: string | null;
}
