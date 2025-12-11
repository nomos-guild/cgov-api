# API Planning

## App

### POST /sign-in

## Overview - Santosh

### GET /overview

- Get governance action details

### GET /overview/proposals

- Get overview of all proposals

## Proposal - Santosh

### GET /proposal/:proposal_id

- Get details on a specific proposal

## Data

### POST /data/proposal/:proposal_hash

**Purpose:** Ingest or update a single proposal and all its associated votes into the database

**Parameters:**
- `proposal_hash`: The transaction hash of the proposal (maps to `txHash` in database)

**Koios API Endpoints Used:**

1. **GET /proposal_list** - Fetch proposal metadata
   - Filter by `_tx_hash` to get specific proposal
   - Returns: proposal details, status, epochs, metadata, governance action type
   - Maps to: `Proposal` table fields (title, description, rationale, etc.)
   - **TODO:** Add inline docs to Proposal schema fields matching Koios response

2. **GET /proposal_votes?_proposal_tx_hash={tx_hash}** - Get all votes for the proposal
   - Returns: Array of votes with voter info, vote type, and voting power
   - Maps to: `OnchainVote` table
   - **TODO:** Add inline docs to OnchainVote schema fields matching Koios response

3. **For each DRep voter (if not exists in DB):**
   - GET /drep_info?_drep_id={drep_id} - Get DRep details and current voting power
   - Maps to: `Drep` table

4. **For each SPO voter (if not exists in DB):**
   - GET /pool_info?_pool_bech32={pool_id} - Get pool details and current voting power
   - Maps to: `SPO` table

5. **For CC voters (if not exists in DB):**
   - GET /committee_info (or extract from vote metadata)
   - Maps to: `CC` table

**Database Operations (in Prisma transaction):**

1. **Upsert Proposal:**
   ```
   UPSERT WHERE proposalId = "{txHash}#{certIndex}"
   - If new: CREATE with all fields from Koios
   - If exists: UPDATE status, metadata, expiryEpoch (mutable fields only)
   ```

2. **For each vote from Koios:**
   - Check if voter exists (Drep/SPO/CC by unique ID)
   - If voter doesn't exist: CREATE voter record with current voting power
   - If voter exists: UPDATE voting power (can change between epochs)
   - Upsert OnchainVote:
     ```
     UPSERT WHERE (proposalId, voterType, drepId/spoId/ccId)
     - If new: CREATE vote record with all fields
     - If exists: UPDATE vote, votingPower, votingPowerAda (votes can change)
     ```

**Retry Logic:**
- Max retries: 3 attempts
- Retry delay: Exponential backoff (2s, 4s, 8s)
- Retry on: Network errors, Koios API 5xx errors
- Don't retry on: 4xx errors, validation errors

**Response:**
```json
{
  "success": true,
  "proposal": {
    "id": 123,
    "proposalId": "abc123...#0",
    "status": "ACTIVE"
  },
  "stats": {
    "votesIngested": 150,
    "votesUpdated": 25,
    "votersCreated": { "dreps": 120, "spos": 25, "ccs": 5 },
    "votersUpdated": { "dreps": 10, "spos": 3, "ccs": 0 }
  }
}
```

**Implementation Files:**
- Service: `src/services/ingestion/proposal.service.ts`
- Controller: `src/controllers/data/ingestProposal.ts`
- Route: Registered in `src/routes/data.route.ts`
- Types: `src/types/koios.types.ts` (needs Koios field mappings)

---

### POST /data/vote/:tx_hash

**Purpose:** Ingest a single vote into the `OnchainVote` table

**Status:** Placeholder implementation - requires clarification on how to fetch vote by tx_hash from Koios

**Implementation:**
- Service: `src/services/ingestion/vote.service.ts`
- Controller: `src/controllers/data/ingestVote.ts`

---

### POST /data/drep/:drep_id

**Purpose:** Ingest or update a single DRep into the `Drep` table

**Koios API:** GET /drep_info?_drep_id={drep_id}

**Implementation:**
- Service: `src/services/ingestion/voter.service.ts` (ingestDrep)
- Controller: `src/controllers/data/ingestVoters.ts` (postIngestDrep)

---

### POST /data/spo/:pool_id

**Purpose:** Ingest or update a single SPO into the `SPO` table

**Koios API:** GET /pool_info?_pool_bech32={pool_id}

**Implementation:**
- Service: `src/services/ingestion/voter.service.ts` (ingestSpo)
- Controller: `src/controllers/data/ingestVoters.ts` (postIngestSpo)

---

### POST /data/cc/:cc_id

**Purpose:** Ingest or update a single Constitutional Committee member into the `CC` table

**Koios API:** TBD (may need to extract from vote metadata or dedicated endpoint)

**Implementation:**
- Service: `src/services/ingestion/voter.service.ts` (ingestCc)
- Controller: `src/controllers/data/ingestVoters.ts` (postIngestCc)

---

## Cron Job

**Schedule:** Every 5 minutes (configurable via `PROPOSAL_SYNC_SCHEDULE` env variable)

**Job: Sync All Proposals**

**Process Flow:**

1. **Fetch all proposals from Koios**
   - Endpoint: GET /proposal_list (no filters, returns all proposals)

2. **For each proposal (processed sequentially with retry):**
   - Call `ingestProposal(proposal_hash)` service
   - Automatically handles:
     - Upserting proposal data
     - Fetching and upserting all votes
     - Creating/updating voters (DReps, SPOs, CCs)
   - If fails: Retry up to 3 times with exponential backoff
   - If still fails: Log error and continue to next proposal

3. **After all proposals processed:**
   - Log summary: X proposals synced, Y failed, Z votes updated

**Error Handling:**
- Individual proposal failures don't stop the entire sync
- Failed proposals are logged but sync continues
- Retry mechanism (via `withRetry` utility) handles transient errors
- Prisma transactions ensure atomic operations per proposal

**Sync Strategy:**
- Syncs **ALL** proposals every time (not incremental)
- Updates existing proposals if status/metadata changed
- Updates **ALL** votes (detects and updates changed votes)
- Updates voting power for all voters (can change between epochs)

**Implementation Files:**
- Job Scheduler: `src/jobs/sync-proposals.job.ts`
- Job Registry: `src/jobs/index.ts`
- Started from: `src/index.ts` (calls `startAllJobs()`)

**Configuration (.env):**
```
# Koios API
KOIOS_BASE_URL=https://api.koios.rest/api/v1
KOIOS_API_KEY=your_api_key_here

# Cron Jobs
PROPOSAL_SYNC_SCHEDULE=*/5 * * * *  # Every 5 minutes
ENABLE_CRON_JOBS=true
```

**Database Tables Involved (in order):**
1. `Proposal` - Upserted first
2. `Drep` / `SPO` / `CC` - Created/updated as voters are encountered
3. `OnchainVote` - Upserted with foreign keys to above tables

**Dependencies:**
- `node-cron` - Cron scheduler
- `@types/node-cron` - TypeScript definitions
