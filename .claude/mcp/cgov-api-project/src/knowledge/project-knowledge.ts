/**
 * cgov-api Project Knowledge Base
 *
 * Comprehensive knowledge about the cgov-api backend codebase for AI coding assistants.
 * Extracted from the project's architecture, patterns, and conventions.
 */

// =============================================================================
// PROJECT OVERVIEW
// =============================================================================

export const PROJECT_OVERVIEW = {
  name: "cgov-api",
  description:
    "Backend API for the Cardano Governance Tracking Dashboard. Ingests on-chain governance data from Koios and Blockfrost APIs, stores it in PostgreSQL via Prisma ORM, and serves it to the cgov frontend.",
  techStack: {
    runtime: "Node.js",
    framework: "Express.js 5",
    language: "TypeScript 5.9 (strict mode)",
    database: "PostgreSQL",
    orm: "Prisma ORM",
    externalApis: ["Koios REST API (primary)", "Blockfrost API (secondary)"],
    scheduler: "node-cron",
    documentation: "Swagger (OpenAPI via swagger-autogen)",
    security: ["helmet", "cors", "API key authentication"],
    deployment: "Docker + GCP Cloud Run",
    packageManager: "npm",
  },
  features: [
    "Governance proposal ingestion from Koios/Blockfrost",
    "Vote ingestion and tallying (DRep, SPO, CC)",
    "Voting power tracking and sync (DRep, SPO)",
    "Net Change Limit (NCL) tracking for treasury withdrawals",
    "Proposal status derivation (Active, Ratified, Enacted, Expired, Closed)",
    "Vote calculation with epoch-dependent formulas",
    "Constitutional Committee (CC) eligibility tracking",
    "DRep dashboard endpoints (list, detail, stats, voting history)",
    "Paginated API with sorting, filtering, and search",
    "Cron jobs for periodic data sync (proposals every 5min, voter power every 6hrs)",
    "Distributed locking via SyncStatus model for GCP Cloud Run",
    "Swagger API documentation",
  ],
};

// =============================================================================
// FILE STRUCTURE
// =============================================================================

export const FILE_STRUCTURE = {
  root: {
    "src/index.ts": "Express app setup, middleware, route mounting, cron initialization",
    "src/cron.ts": "Standalone cron service entry point (separate from API)",
    "prisma/schema.prisma": "Database schema with 11 models and 4 enums",
    "Dockerfile": "Docker build configuration",
    "docs/swagger.json": "Generated Swagger/OpenAPI documentation",
  },
  src: {
    controllers: {
      description: "Request handlers organized by feature domain",
      "index.ts": "Barrel export for all controller modules (dataController, overviewController, proposalController, drepController)",
      data: {
        description: "Data ingestion controllers",
        files: {
          "getProposals.ts": "GET /data/proposals - Fetch proposals from Blockfrost",
          "ingestProposal.ts": "POST /data/proposal/:hash - Ingest single proposal from Koios",
          "ingestVote.ts": "POST /data/vote/:tx_hash - Ingest single vote",
          "ingestVoters.ts": "POST /data/drep/:id, /spo/:id, /cc/:id - Ingest voter data",
          "triggerSync.ts": "POST /data/trigger-sync - Manual proposal sync trigger",
          "triggerVoterSync.ts": "POST /data/trigger-voter-sync - Manual voter power sync",
        },
      },
      overview: {
        description: "Overview/summary controllers",
        files: {
          "getOverviewSummary.ts": "GET /overview - Summary statistics with proposal counts",
          "getOverviewProposals.ts": "GET /overview/proposals - Full proposal list with vote calculations",
          "getNCLData.ts": "GET /overview/ncl, /overview/ncl/:year - NCL data",
        },
      },
      proposal: {
        description: "Single proposal detail controller",
        files: {
          "getProposalDetails.ts": "GET /proposal/:id - Full proposal with votes and metadata",
        },
      },
      drep: {
        description: "DRep dashboard controllers",
        files: {
          "getDReps.ts": "GET /dreps - Paginated DRep list with sorting/search",
          "getDRepDetail.ts": "GET /dreps/:drepId - DRep profile with vote breakdown",
          "getDRepStats.ts": "GET /dreps/stats - Aggregate DRep statistics",
          "getDRepVotes.ts": "GET /dreps/:drepId/votes - Paginated voting history",
        },
      },
    },
    routes: {
      description: "Express route definitions with OpenAPI annotations",
      files: {
        "data.route.ts": "/data/* - Data ingestion endpoints (all POST except GET /proposals)",
        "overview.route.ts": "/overview/* - Public overview and NCL endpoints",
        "proposal.route.ts": "/proposal/* - Proposal detail endpoint",
        "drep.route.ts": "/dreps/* - DRep dashboard endpoints",
        "user.route.ts": "/user/* - User endpoints",
      },
    },
    services: {
      description: "External API clients and business logic services",
      files: {
        "koios.ts": "Koios API client with retry logic (5 retries, 3s-30s delay)",
        "blockfrost.ts": "Blockfrost API client (simple Axios instance)",
        "prisma.ts": "Prisma client singleton",
        "syncOnRead.ts": "Lazy sync-on-read for proposal detail",
      },
      ingestion: {
        description: "Data ingestion service layer",
        files: {
          "proposal.service.ts": "Core proposal sync (~1100 lines): syncAllProposals, ingestProposal, mapGovernanceType, deriveProposalStatus, extractProposalMetadata, updateProposalVotingPower",
          "vote.service.ts": "Vote ingestion and processing",
          "voter.service.ts": "DRep/SPO/CC voter data sync",
          "ncl.service.ts": "NCL (Net Change Limit) calculation and update",
          "parallel.ts": "Parallel processing utilities for batch operations",
          "utils.ts": "Shared utilities: withRetry (exponential backoff), lovelaceToAda, safeJsonParse",
        },
      },
    },
    middleware: {
      description: "Express middleware",
      files: {
        "auth.middleware.ts": "API key auth via X-API-Key header (skips if SERVER_API_KEY not set)",
      },
    },
    models: {
      description: "TypeScript interfaces for API response shapes",
      files: {
        "governance_action.model.ts":
          "Core types: GovernanceAction, GovernanceActionDetail, VoteRecord, VoteBreakdown, VotingThreshold, VotingStatus, RawVotingPowerValues, CCGovernanceActionVoteInfo, NCLData, ProposalSummary",
      },
    },
    responses: {
      description: "API response type definitions",
      files: {
        "overview.response.ts": "GetNCLDataResponse, GetProposalListResponse",
        "proposal.response.ts": "GetProposalInfoResponse",
        "drep.response.ts": "DRepSummary, GetDRepsResponse, GetDRepStatsResponse, GetDRepDetailResponse, DRepVoteRecord, GetDRepVotesResponse, VoteBreakdown",
        "user.response.ts": "User response types",
      },
    },
    libs: {
      description: "Business logic utilities",
      files: {
        "proposalMapper.ts":
          "Maps Prisma Proposal to API GovernanceAction/GovernanceActionDetail. Contains vote calculation formulas for DRep, SPO, CC. Handles epoch-dependent SPO formula (pre/post epoch 534). Determines constitutionality, thresholds, and passing status.",
        "error.ts": "Error handling utilities",
      },
    },
    types: {
      description: "Shared TypeScript types",
      files: {
        "koios.types.ts": "Type definitions for Koios API responses",
      },
    },
    jobs: {
      description: "Cron job definitions",
      files: {
        "index.ts": "Job registry - startAllJobs()",
        "sync-proposals.job.ts": "Proposal sync cron (default: every 5 min). Runs syncAllProposals() then updateNCL(). Has in-process guard.",
        "sync-voter-power.job.ts": "Voter power sync cron (default: every 6 hours). Updates DRep and SPO voting power.",
      },
    },
  },
};

// =============================================================================
// DATABASE SCHEMA
// =============================================================================

export const DATABASE_SCHEMA = {
  description: "PostgreSQL database via Prisma ORM. All BigInt fields store lovelace values.",
  models: {
    Proposal: {
      description: "Governance proposals with voting power snapshots",
      primaryKey: "id (auto-increment)",
      uniqueConstraints: ["proposalId", "[txHash, certIndex]"],
      keyFields: {
        proposalId: "Cardano governance action ID (gov_action bech32)",
        txHash: "Transaction hash",
        certIndex: "Certificate index within transaction",
        title: "Proposal title (from metadata)",
        description: "Full proposal description",
        rationale: "Proposal rationale text",
        governanceActionType: "GovernanceType enum",
        status: "ProposalStatus enum (ACTIVE, RATIFIED, ENACTED, EXPIRED, CLOSED)",
        submissionEpoch: "Epoch when proposal was submitted",
        expirationEpoch: "Epoch when voting expires",
      },
      votingPowerFields: {
        description: "Epoch-snapshot voting power breakdown (all BigInt/lovelace)",
        drep: [
          "drepTotalVotePower",
          "drepActiveYesVotePower",
          "drepActiveNoVotePower",
          "drepActiveAbstainVotePower",
          "drepAlwaysAbstainVotePower",
          "drepAlwaysNoConfidencePower",
          "drepInactiveVotePower",
        ],
        spo: [
          "spoTotalVotePower",
          "spoActiveYesVotePower",
          "spoActiveNoVotePower",
          "spoActiveAbstainVotePower",
          "spoAlwaysAbstainVotePower",
          "spoAlwaysNoConfidencePower",
          "spoNoVotePower (Koios pool_no_vote_power)",
        ],
      },
      relations: ["onchainVotes: OnchainVote[]"],
    },
    OnchainVote: {
      description: "Individual on-chain votes",
      primaryKey: "id (string)",
      uniqueConstraint: "[txHash, proposalId, voterType, drepId, spoId, ccId]",
      keyFields: {
        txHash: "Vote transaction hash",
        proposalId: "Reference to Proposal.proposalId",
        vote: "VoteType enum (YES, NO, ABSTAIN)",
        voterType: "VoterType enum (DREP, SPO, CC)",
        votingPower: "BigInt - voting power at time of vote (lovelace)",
        anchorUrl: "Vote rationale URL",
        anchorHash: "Rationale content hash",
        rationale: "Parsed rationale text",
      },
      relations: ["drep: Drep?", "spo: SPO?", "cc: CC?", "proposal: Proposal"],
    },
    Drep: {
      description: "Delegated Representatives",
      primaryKey: "drepId (string)",
      keyFields: {
        name: "Display name",
        votingPower: "BigInt - current voting power (lovelace)",
        delegatorCount: "Number of delegators",
        doNotList: "Boolean - exclude from public listing",
        iconUrl: "Profile icon URL",
        paymentAddr: "Payment address",
      },
      relations: ["user: User?", "onchainVotes: OnchainVote[]"],
    },
    SPO: {
      description: "Stake Pool Operators",
      primaryKey: "poolId (string)",
      keyFields: {
        poolName: "Pool display name",
        ticker: "Pool ticker symbol",
        votingPower: "BigInt - current voting power (lovelace)",
        iconUrl: "Pool icon URL",
      },
      relations: ["user: User?", "onchainVotes: OnchainVote[]"],
    },
    CC: {
      description: "Constitutional Committee members",
      primaryKey: "ccId (string)",
      keyFields: {
        memberName: "Display name",
        hotCredential: "Hot key credential",
        coldCredential: "Cold key credential",
        status: "Authorization status",
      },
      relations: ["user: User?", "onchainVotes: OnchainVote[]"],
    },
    SyncStatus: {
      description: "Distributed lock and sync tracking for cron jobs (critical for GCP Cloud Run)",
      primaryKey: "jobName (string)",
      keyFields: {
        isRunning: "Boolean lock flag",
        startedAt: "Job start timestamp",
        completedAt: "Job completion timestamp",
        lastResult: "success | failed | skipped",
        errorMessage: "Error details if failed",
        itemsProcessed: "Count of items synced",
        lockedBy: "Container/instance ID for distributed locking",
        expiresAt: "Auto-unlock timestamp (crash recovery)",
      },
    },
    NCL: {
      description: "Net Change Limit tracking for treasury withdrawals per year",
      primaryKey: "id (string)",
      keyFields: {
        year: "Fiscal year (unique)",
        epoch: "Last update epoch",
        current: "BigInt - current treasury withdrawals (lovelace)",
        limit: "BigInt - annual NCL limit (lovelace)",
      },
    },
    CommitteeState: {
      description: "Cached CC member eligibility counts from Koios",
      primaryKey: "id (default: 'current')",
      keyFields: {
        epoch: "Epoch when last synced",
        totalMembers: "Total CC members",
        eligibleMembers: "Eligible CC members (authorized + not expired)",
        quorumNumerator: "Quorum numerator",
        quorumDenominator: "Quorum denominator",
        isCommitteeValid: "Whether committee has enough eligible members",
      },
    },
    User: {
      description: "User accounts linked to wallet addresses",
      primaryKey: "id (string)",
      keyFields: {
        walletAddress: "Cardano wallet address",
        stakeKeyLovelace: "Stake key balance",
        jwt: "Authentication token",
      },
      relations: ["drep: Drep?", "spo: SPO?", "cc: CC?"],
    },
    ProposalDraft: {
      description: "Draft proposals (not yet submitted on-chain)",
      primaryKey: "id (auto-increment)",
      relations: ["crowdfundingCampaign: CrowdfundingCampaign?"],
    },
    CrowdfundingCampaign: {
      description: "Crowdfunding campaigns for proposal drafts",
      primaryKey: "id (auto-increment)",
      relations: ["proposalDraft: ProposalDraft"],
    },
  },
  enums: {
    GovernanceType: {
      values: [
        "INFO_ACTION",
        "TREASURY_WITHDRAWALS",
        "NEW_CONSTITUTION",
        "HARD_FORK_INITIATION",
        "PROTOCOL_PARAMETER_CHANGE",
        "NO_CONFIDENCE",
        "UPDATE_COMMITTEE",
      ],
      description: "Types of governance actions (Prisma enum)",
    },
    ProposalStatus: {
      values: ["ACTIVE", "RATIFIED", "ENACTED", "EXPIRED", "CLOSED"],
      description: "Proposal lifecycle status (Prisma enum)",
    },
    VoteType: {
      values: ["YES", "NO", "ABSTAIN"],
      description: "Vote options (Prisma enum)",
    },
    VoterType: {
      values: ["DREP", "SPO", "CC"],
      description: "Voter role types (Prisma enum)",
    },
  },
};

// =============================================================================
// API ENDPOINTS
// =============================================================================

export const API_ENDPOINTS = {
  description: "All endpoints require X-API-Key header (except Swagger docs). Rate limiting handled by Cloudflare.",
  authentication: {
    method: "X-API-Key header",
    middleware: "src/middleware/auth.middleware.ts",
    behavior: "Skips auth if SERVER_API_KEY env not configured (development mode)",
    protectedPrefixes: ["/data", "/user", "/overview", "/proposal", "/dreps"],
  },
  swagger: {
    url: "/api-docs",
    source: "docs/swagger.json",
    note: "No auth required",
  },
  routes: {
    overview: {
      "GET /overview": {
        description: "Summary statistics (proposal counts by status + NCL data)",
        controller: "overviewController.getOverviewSummary",
        response: "GetNCLDataResponse (NCLData & ProposalSummary)",
      },
      "GET /overview/proposals": {
        description: "Full list of governance actions with vote calculations",
        controller: "overviewController.getOverviewProposals",
        response: "GetProposalListResponse (GovernanceAction[])",
        note: "Includes all vote tallies, thresholds, passing status, and raw voting power values",
      },
      "GET /overview/ncl": {
        description: "NCL data for all years",
        controller: "overviewController.getNCLData",
      },
      "GET /overview/ncl/:year": {
        description: "NCL data for specific year",
        controller: "overviewController.getNCLDataByYear",
      },
    },
    proposal: {
      "GET /proposal/:proposal_id": {
        description: "Full proposal detail with all votes (DRep, SPO, CC), metadata, and references",
        controller: "proposalController.getProposalDetails",
        response: "GetProposalInfoResponse (GovernanceActionDetail)",
      },
    },
    dreps: {
      "GET /dreps": {
        description: "Paginated DRep list with sorting, search, and filtering",
        controller: "drepController.getDReps",
        queryParams: {
          page: "Page number (default: 1)",
          pageSize: "Items per page (default: 20, max: 1000)",
          sortBy: "votingPower | name | totalVotes (default: votingPower)",
          sortOrder: "asc | desc (default: desc)",
          search: "Search by DRep name or ID",
        },
        response: "GetDRepsResponse",
        note: "Filters out doNotList DReps. totalVotes sort is done in-memory after DB query.",
      },
      "GET /dreps/stats": {
        description: "Aggregate DRep statistics",
        controller: "drepController.getDRepStats",
        response: "GetDRepStatsResponse",
      },
      "GET /dreps/:drepId": {
        description: "DRep profile with vote breakdown and participation metrics",
        controller: "drepController.getDRepDetail",
        response: "GetDRepDetailResponse",
      },
      "GET /dreps/:drepId/votes": {
        description: "Paginated voting history for a specific DRep",
        controller: "drepController.getDRepVotes",
        queryParams: {
          page: "Page number (default: 1)",
          pageSize: "Items per page (default: 20, max: 100)",
          sortOrder: "asc | desc by vote date (default: desc)",
        },
        response: "GetDRepVotesResponse",
      },
    },
    data: {
      description: "Data ingestion endpoints (used by cron jobs and manual triggers)",
      "GET /data/proposals": {
        description: "Fetch proposals from Blockfrost API",
        controller: "dataController.getProposals",
      },
      "POST /data/proposal/:proposal_hash": {
        description: "Ingest single proposal from Koios with all votes",
        controller: "postIngestProposal",
      },
      "POST /data/vote/:tx_hash": {
        description: "Ingest single vote from Koios",
        controller: "postIngestVote",
      },
      "POST /data/drep/:drep_id": {
        description: "Ingest DRep data from Koios",
        controller: "postIngestDrep",
      },
      "POST /data/spo/:pool_id": {
        description: "Ingest SPO data from Koios",
        controller: "postIngestSpo",
      },
      "POST /data/cc/:cc_id": {
        description: "Ingest CC member data",
        controller: "postIngestCc",
      },
      "POST /data/trigger-sync": {
        description: "Manually trigger full proposal sync",
        controller: "postTriggerSync",
        responses: { 200: "Sync completed", 409: "Sync already running" },
      },
      "POST /data/trigger-voter-sync": {
        description: "Manually trigger voter power sync",
        controller: "postTriggerVoterSync",
        responses: { 200: "Sync completed", 409: "Sync already running" },
      },
    },
  },
};

// =============================================================================
// DATA INGESTION
// =============================================================================

export const DATA_INGESTION = {
  description:
    "Data flows from Cardano blockchain → Koios/Blockfrost APIs → ingestion services → PostgreSQL via Prisma",
  flow: [
    "1. Cron job triggers (or manual API trigger)",
    "2. Fetch proposal list from Koios API (/proposal_list)",
    "3. For each proposal, fetch detailed data from Koios (/proposal_info, /proposal_votes)",
    "4. Map Koios governance types to Prisma GovernanceType enum",
    "5. Derive proposal status from epoch fields (submitted, ratified, enacted, expired, dropped)",
    "6. Extract metadata from meta_json or fetch from meta_url/IPFS",
    "7. Upsert proposal and votes to PostgreSQL via Prisma",
    "8. Update voting power from Koios epoch snapshots",
    "9. Update NCL (Net Change Limit) after proposal sync",
  ],
  externalApis: {
    koios: {
      description: "Primary data source for Cardano governance data",
      baseUrl: "https://api.koios.rest/api/v1",
      authentication: "Bearer token via KOIOS_API_KEY env",
      timeout: "30 seconds",
      retryConfig: {
        maxRetries: 5,
        baseDelay: "3 seconds",
        maxDelay: "30 seconds",
        strategy: "Exponential backoff with Retry-After header support",
        retryOn: "429 (rate limit), 5xx errors",
        noRetryOn: "4xx errors (except 429)",
      },
      endpoints: [
        "/proposal_list - List all governance proposals",
        "/proposal_info - Detailed proposal information",
        "/proposal_votes - Votes for a proposal",
        "/drep_info - DRep information",
        "/drep_epoch_summary - DRep epoch data",
        "/pool_info - SPO pool information",
        "/committee_info - CC member information",
      ],
    },
    blockfrost: {
      description: "Secondary data source, used for proposal listing",
      authentication: "project_id header via BLOCKFROST_API_KEY env",
    },
  },
  governanceTypeMapping: {
    description: "Maps Koios PascalCase governance types to Prisma enum values",
    mapping: {
      InfoAction: "INFO_ACTION",
      TreasuryWithdrawals: "TREASURY_WITHDRAWALS",
      NewConstitution: "NEW_CONSTITUTION",
      HardForkInitiation: "HARD_FORK_INITIATION",
      ParameterChange: "PROTOCOL_PARAMETER_CHANGE",
      NoConfidence: "NO_CONFIDENCE",
      UpdateCommittee: "UPDATE_COMMITTEE",
    },
  },
  proposalStatusDerivation: {
    description: "Status is derived from epoch fields, not stored directly by Koios",
    rules: [
      "If enactedEpoch is set → ENACTED",
      "If ratifiedEpoch is set → RATIFIED",
      "If expiredEpoch or droppedEpoch is set → EXPIRED",
      "If submissionEpoch is set and within voting window → ACTIVE",
      "GovernanceType.INFO_ACTION: ENACTED/EXPIRED become CLOSED",
    ],
  },
  cronJobs: {
    proposalSync: {
      schedule: "Every 5 minutes (configurable via PROPOSAL_SYNC_SCHEDULE)",
      function: "syncAllProposals()",
      postAction: "updateNCL()",
      guard: "In-process boolean flag + SyncStatus DB lock",
    },
    voterPowerSync: {
      schedule: "Every 6 hours (configurable via VOTER_SYNC_SCHEDULE)",
      function: "syncVoterPower()",
      description: "Updates DRep and SPO voting power from Koios",
    },
    configuration: {
      DISABLE_CRON_IN_API: "Set to 'true' to disable cron in API process (for separate cron container)",
      ENABLE_CRON_JOBS: "Set to 'false' to disable all cron jobs",
    },
  },
};

// =============================================================================
// VOTE CALCULATION (BACKEND)
// =============================================================================

export const VOTE_CALCULATION = {
  description: "Vote tallying and percentage calculation happens in libs/proposalMapper.ts",
  location: "src/libs/proposalMapper.ts",
  drepCalculation: {
    description: "DRep votes are stake-weighted (lovelace). Voting power data comes from Koios epoch snapshots stored on the Proposal model.",
    notVotedFormula: "notVoted = total - yes - no - abstain - alwaysAbstain - alwaysNoConfidence - inactive",
    noConfidence: {
      yesTotal: "yes + alwaysNoConfidence",
      noTotal: "no + notVoted",
      abstainTotal: "abstain + alwaysAbstain",
      denominator: "yesTotal + noTotal (excludes abstain and inactive)",
    },
    otherActions: {
      yesTotal: "yes",
      noTotal: "no + alwaysNoConfidence + notVoted",
      abstainTotal: "abstain + alwaysAbstain",
      denominator: "yesTotal + noTotal (excludes abstain and inactive)",
    },
  },
  spoCalculation: {
    description: "SPO votes are stake-weighted (lovelace). Formula changed at epoch 534 (Plomin Hard Fork).",
    transitionGovernanceAction: "gov_action1pvv5wmjqhwa4u85vu9f4ydmzu2mgt8n7et967ph2urhx53r70xusqnmm525",
    transitionEpoch: 534,
    koiosPoolNoVotePower: "Preferred data source. Includes: notVoted + alwaysNoConfidence + explicit no. Used to derive notVoted and effectiveTotal for consistent epoch snapshot data.",
    postEpoch534: {
      hardForkInitiation: {
        yesTotal: "yes",
        abstainTotal: "abstain (explicit only)",
        notVoted: "notVoted + alwaysNoConfidence + alwaysAbstain (all count as No)",
        noTotal: "no + notVoted",
        denominator: "effectiveTotal - abstainTotal",
      },
      noConfidence: {
        yesTotal: "yes + alwaysNoConfidence",
        abstainTotal: "abstain + alwaysAbstain",
        notVoted: "pure notVoted only",
        noTotal: "no + notVoted",
        denominator: "effectiveTotal - abstainTotal",
      },
      other: {
        yesTotal: "yes",
        abstainTotal: "abstain + alwaysAbstain",
        notVoted: "pure notVoted only",
        noTotal: "no + notVoted",
        denominator: "effectiveTotal - abstainTotal",
      },
    },
    preEpoch534: {
      yesTotal: "yes",
      noTotal: "no + alwaysNoConfidence",
      abstainTotal: "abstain + alwaysAbstain",
      denominator: "yes + no + alwaysNoConfidence (excludes notVoted entirely)",
    },
  },
  ccCalculation: {
    description: "CC votes are count-based (not stake-weighted). Uses eligible member count from Koios.",
    formula: "yesPercent = yesCount / (eligibleMembers - abstainCount) * 100",
    defaults: {
      DEFAULT_CC_MEMBERS: 7,
      MIN_ELIGIBLE_CC_MEMBERS: 7,
    },
    constitutionality: "≥67% yes from CC = 'Constitutional', otherwise 'Unconstitutional'. Returns 'Pending' if no votes, 'Committee Too Small' if < 7 eligible.",
    latestVoteFilter: "Only the most recent vote per CC member is counted (handles vote changes).",
  },
  votingThresholds: {
    description: "Per-governance-type thresholds (from Cardano spec). null = voter type doesn't participate.",
    thresholds: {
      NO_CONFIDENCE: { cc: null, drep: 0.67, spo: 0.51 },
      UPDATE_COMMITTEE: { cc: null, drep: 0.67, spo: 0.51 },
      NEW_CONSTITUTION: { cc: 0.67, drep: 0.75, spo: null },
      HARD_FORK_INITIATION: { cc: 0.67, drep: 0.60, spo: 0.51 },
      PROTOCOL_PARAMETER_CHANGE: { cc: 0.67, drep: 0.67, spo: null },
      TREASURY_WITHDRAWALS: { cc: 0.67, drep: 0.67, spo: null },
      INFO_ACTION: { cc: 0.67, drep: 1.0, spo: 1.0 },
    },
    passingLogic: "Proposal passes if ALL required voter types (non-null threshold) meet their threshold.",
  },
};

// =============================================================================
// RESPONSE TYPES
// =============================================================================

export const RESPONSE_TYPES = {
  description: "API response type definitions in src/responses/",
  overview: {
    GetNCLDataResponse: "NCLData & ProposalSummary - Combined NCL + proposal count data",
    GetProposalListResponse: "GovernanceAction[] - Array of proposals with full vote calculations",
  },
  proposal: {
    GetProposalInfoResponse: "GovernanceActionDetail - Extended GovernanceAction with votes, ccVotes, references, description, rationale",
  },
  drep: {
    DRepSummary: {
      fields: ["drepId", "name", "iconUrl", "votingPower (lovelace string)", "votingPowerAda", "totalVotesCast", "delegatorCount"],
    },
    GetDRepsResponse: {
      fields: ["dreps: DRepSummary[]", "pagination: { page, pageSize, totalItems, totalPages }"],
    },
    GetDRepStatsResponse: {
      fields: ["totalDReps", "totalDelegatedLovelace", "totalDelegatedAda", "totalVotesCast", "activeDReps", "totalDelegators"],
    },
    GetDRepDetailResponse: {
      fields: [
        "drepId", "name", "iconUrl", "paymentAddr",
        "votingPower (lovelace string)", "votingPowerAda",
        "totalVotesCast", "voteBreakdown: { yes, no, abstain }",
        "rationalesProvided", "proposalParticipationPercent",
        "delegatorCount",
      ],
    },
    DRepVoteRecord: {
      fields: [
        "proposalId", "proposalTitle", "proposalType",
        "vote", "votingPower", "rationale", "anchorUrl",
        "votedAt", "txHash",
      ],
    },
    GetDRepVotesResponse: {
      fields: ["drepId", "votes: DRepVoteRecord[]", "pagination"],
    },
  },
  governance: {
    GovernanceAction: {
      description: "Core proposal type with vote calculations",
      fields: [
        "proposalId (gov_action bech32)", "hash (txHash:certIndex)",
        "title", "type (display label)", "status",
        "constitutionality", "passing (boolean)",
        "drep: GovernanceActionVoteInfo",
        "spo?: GovernanceActionVoteInfo",
        "cc?: CCGovernanceActionVoteInfo",
        "totalYes, totalNo, totalAbstain (vote counts)",
        "submissionEpoch, expiryEpoch",
        "threshold: VotingThreshold",
        "votingStatus: VotingStatus",
        "rawVotingPowerValues: RawVotingPowerValues",
      ],
    },
    VoteBreakdown: {
      description: "Individual vote category amounts (lovelace strings) for charts",
      fields: [
        "activeYes", "activeNo", "activeAbstain",
        "alwaysAbstain", "alwaysNoConfidence",
        "inactive (null for SPO)", "notVoted",
      ],
    },
  },
};

// =============================================================================
// DATA CONVENTIONS
// =============================================================================

export const DATA_CONVENTIONS = {
  lovelaceToAda: {
    formula: "1 ADA = 1,000,000 lovelace",
    storage: "Database stores BigInt lovelace values",
    serialization: "API returns lovelace as strings (BigInt can't serialize to JSON)",
    conversion: "lovelaceToAda(lovelace: bigint): string => (Number(lovelace) / 1_000_000).toFixed(6)",
    location: "src/services/ingestion/utils.ts and controller-level helpers",
  },
  bigIntHandling: {
    description: "PostgreSQL BigInt fields are used for all monetary/voting power values",
    prismaType: "BigInt",
    serialization: "Converted to string via .toString() before JSON response (JSON doesn't support BigInt natively)",
    arithmetic: "Convert to Number() for calculations, then round with Math.round()",
    gotcha: "Number() loses precision above ~9 quadrillion lovelace (~9 billion ADA), but this is acceptable for Cardano's total supply",
  },
  proposalIdentifiers: {
    proposalId: "gov_action bech32 string (Cardano governance action ID)",
    hash: "txHash:certIndex format (used for routing/lookup)",
    txHash: "64-character hex transaction hash",
    certIndex: "Certificate index within transaction",
  },
  pagination: {
    pattern: "page/pageSize query params → skip/take in Prisma",
    defaults: "page: 1, pageSize: 20",
    maxPageSize: "1000 for DRep list, 100 for vote history",
    response: "{ page, pageSize, totalItems, totalPages }",
  },
};

// =============================================================================
// CODING CONVENTIONS
// =============================================================================

export const CODING_CONVENTIONS = {
  typescript: {
    strictMode: true,
    esTarget: "ES2022",
    moduleSystem: "CommonJS (for Express)",
    nullHandling: "Optional chaining (?.) and nullish coalescing (??)",
    enumStyle: "Prisma enums for DB types, string literal unions for API response types",
  },
  express: {
    controllerPattern: "async (req: Request, res: Response) => { try/catch with JSON error response }",
    routeAnnotations: "@openapi JSDoc comments on each route for Swagger generation",
    errorResponse: "{ error: string, message: string }",
    middleware: "Applied per-route prefix in src/index.ts",
  },
  prisma: {
    singleton: "Exported from src/services/prisma.ts",
    import: "import { prisma } from '../../services'",
    selectPattern: "Use Prisma select to minimize data transfer (don't fetch entire models)",
    upsertPattern: "Use upsert for idempotent data ingestion",
    bigIntFields: "Always serialize to string before JSON response",
  },
  naming: {
    controllers: "camelCase verb + Noun (getDReps, getOverviewSummary, postIngestProposal)",
    services: "camelCase (syncAllProposals, updateNCL)",
    routes: "kebab-case URL paths (trigger-sync, trigger-voter-sync)",
    models: "PascalCase types (GovernanceAction, VoteRecord)",
    envVars: "SCREAMING_SNAKE_CASE",
    files: "camelCase for most files, kebab-case for route files",
  },
  imports: {
    order: [
      "Node.js built-ins",
      "Third-party libraries (express, prisma)",
      "Internal modules (controllers, services, middleware)",
    ],
    pathStyle: "Relative paths (../../services, ../controllers)",
  },
  errorHandling: {
    controllerPattern: "try/catch with console.error + res.status(500).json()",
    servicePattern: "Let errors propagate to controller, use withRetry for API calls",
    validation: "Basic type checking via parseInt/parseFloat with defaults",
  },
};

// =============================================================================
// COMMON TASKS
// =============================================================================

export const COMMON_TASKS = {
  addNewEndpoint: {
    steps: [
      "1. Create controller in src/controllers/{domain}/{handlerName}.ts",
      "2. Export from src/controllers/{domain}/index.ts",
      "3. Export from src/controllers/index.ts if new domain",
      "4. Create route in src/routes/{domain}.route.ts with @openapi annotations",
      "5. Mount route in src/index.ts with apiKeyAuth middleware",
      "6. Define response type in src/responses/{domain}.response.ts",
      "7. Export from src/responses/index.ts",
      "8. Run 'npm run swagger:generate' to update API docs",
    ],
    pattern: `
// Controller pattern (src/controllers/{domain}/{handler}.ts)
import { Request, Response } from "express";
import { prisma } from "../../services";

export const getMyData = async (req: Request, res: Response) => {
  try {
    const data = await prisma.myModel.findMany();
    res.json(data);
  } catch (error) {
    console.error("Error fetching data", error);
    res.status(500).json({
      error: "Failed to fetch data",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};`,
  },
  addNewPrismaModel: {
    steps: [
      "1. Add model definition to prisma/schema.prisma",
      "2. Add @@map() for snake_case table naming",
      "3. Add @map() for snake_case column naming",
      "4. Run 'npx prisma migrate dev --name description' to create migration",
      "5. Run 'npx prisma generate' to update Prisma client types",
      "6. Create corresponding response type in src/responses/",
    ],
    conventions: [
      "Use BigInt for lovelace/monetary values",
      "Use @default(now()) for createdAt",
      "Use @updatedAt for updatedAt",
      "Use string IDs for Cardano identifiers (not auto-increment)",
    ],
  },
  addNewCronJob: {
    steps: [
      "1. Create job file in src/jobs/{job-name}.job.ts",
      "2. Add in-process guard (isRunning boolean)",
      "3. Use configurable schedule via env variable with sensible default",
      "4. Import and call from src/jobs/index.ts in startAllJobs()",
      "5. Consider adding SyncStatus DB locking for distributed environments",
      "6. Add manual trigger endpoint in src/controllers/data/ if needed",
    ],
    pattern: `
import cron from "node-cron";

let isRunning = false;

export const startMyJob = () => {
  const schedule = process.env.MY_JOB_SCHEDULE || "0 */6 * * *";
  if (process.env.ENABLE_CRON_JOBS === "false") return;

  cron.schedule(schedule, async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      // Job logic here
    } catch (error) {
      console.error("Job failed:", error);
    } finally {
      isRunning = false;
    }
  });
};`,
  },
  addNewIngestionService: {
    steps: [
      "1. Create service in src/services/ingestion/{service-name}.service.ts",
      "2. Use koiosGet/koiosPost helpers from src/services/koios.ts for API calls",
      "3. Use withRetry from src/services/ingestion/utils.ts for resilient operations",
      "4. Use Prisma upsert for idempotent data storage",
      "5. Return summary object { total, success, failed, errors }",
      "6. Wire up to cron job or manual trigger endpoint",
    ],
  },
};

// =============================================================================
// ENVIRONMENT VARIABLES
// =============================================================================

export const ENVIRONMENT_VARIABLES = {
  required: {
    DATABASE_URL: "PostgreSQL connection string (used by Prisma)",
  },
  optional: {
    PORT: "Server port (default: 3000)",
    SERVER_API_KEY: "API key for endpoint authentication (disabled if not set)",
    KOIOS_API_KEY: "Koios API Bearer token",
    KOIOS_BASE_URL: "Koios API base URL (default: https://api.koios.rest/api/v1)",
    BLOCKFROST_API_KEY: "Blockfrost project ID",
    BLOCKFROST_BASE_URL: "Blockfrost API base URL",
    DISABLE_CRON_IN_API: "Set 'true' to run cron in separate container",
    ENABLE_CRON_JOBS: "Set 'false' to disable all cron jobs",
    PROPOSAL_SYNC_SCHEDULE: "Cron schedule for proposal sync (default: */5 * * * *)",
    VOTER_SYNC_SCHEDULE: "Cron schedule for voter power sync (default: 0 */6 * * *)",
  },
};

// =============================================================================
// DEPLOYMENT
// =============================================================================

export const DEPLOYMENT = {
  docker: {
    description: "Dockerfile builds TypeScript and runs compiled JS",
    buildCommand: "npm run build (tsc)",
    startCommand: "node dist/index.js",
  },
  gcpCloudRun: {
    description: "Deployed on GCP Cloud Run with Cloud Scheduler for cron jobs",
    trustProxy: "app.set('trust proxy', 1) for correct client IP from X-Forwarded-For",
    cronArchitecture: {
      option1: "Single container: API + cron in same process (default)",
      option2: "Separate containers: API with DISABLE_CRON_IN_API=true, cron service using src/cron.ts",
    },
    distributedLocking: "SyncStatus model provides DB-level locking to prevent concurrent job execution across multiple Cloud Run instances",
  },
  scripts: {
    dev: "npx ts-node src/index.ts",
    build: "tsc",
    start: "node dist/index.js",
    "swagger:generate": "npx ts-node swagger-autogen to generate docs/swagger.json",
    "prisma:migrate": "npx prisma migrate dev",
    "prisma:generate": "npx prisma generate",
  },
};

// =============================================================================
// EXPORT ALL KNOWLEDGE
// =============================================================================

export const ALL_KNOWLEDGE = {
  projectOverview: PROJECT_OVERVIEW,
  fileStructure: FILE_STRUCTURE,
  databaseSchema: DATABASE_SCHEMA,
  apiEndpoints: API_ENDPOINTS,
  dataIngestion: DATA_INGESTION,
  voteCalculation: VOTE_CALCULATION,
  responseTypes: RESPONSE_TYPES,
  dataConventions: DATA_CONVENTIONS,
  codingConventions: CODING_CONVENTIONS,
  commonTasks: COMMON_TASKS,
  environmentVariables: ENVIRONMENT_VARIABLES,
  deployment: DEPLOYMENT,
};
