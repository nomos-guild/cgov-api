# SPO Percentage Bug Analysis

**Date:** January 2025
**Status:** Confirmed Backend Bug
**Severity:** High (Data Integrity)

---

## Executive Summary

The SPO (Stake Pool Operator) voting percentage calculation can produce values exceeding 100%, displaying incorrect voting progress to users. For example, a proposal showing **675.93%** SPO approval instead of the correct **~20.77%**.

| Aspect | Details |
|--------|---------|
| **Symptom** | SPO `yesPercent` values exceeding 100% |
| **Root Cause** | Epoch mismatch between total voting power and vote breakdown data sources |
| **Impact** | Incorrect voting progress displayed; potential governance decision confusion |
| **Affected Component** | `src/libs/proposalMapper.ts` - `buildSpoVoteInfo()` |

---

## Root Cause Analysis

### The Problem

The SPO percentage calculation relies on two separate data sources that may reference **different epochs**:

1. **`spoTotalVotePower`** - Total SPO voting power for a specific epoch
2. **Vote breakdown values** (`spoActiveYesVotePower`, etc.) - Voting power of pools that voted on the proposal

When these values come from different epoch snapshots, the vote breakdown sum can **exceed** the declared total, causing percentages greater than 100%.

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Data Ingestion Flow                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Koios API: /pool_voting_power_history                              │
│  ┌─────────────────────────────────────┐                            │
│  │ Epoch: N-1 (historical snapshot)    │──► spoTotalVotePower       │
│  │ Returns: All pools' voting power    │                            │
│  └─────────────────────────────────────┘                            │
│                                                                     │
│  Koios API: /proposal_voting_summary                                │
│  ┌─────────────────────────────────────┐                            │
│  │ No epoch parameter                  │──► spoActiveYesVotePower   │
│  │ Returns: Voting power at time of    │──► spoActiveNoVotePower    │
│  │ each vote (mixed epochs possible)   │──► spoActiveAbstainVotePower│
│  └─────────────────────────────────────┘──► etc.                    │
│                                                                     │
│  ❌ MISMATCH: Different epoch references cause inconsistent data    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Example Data Inconsistency

From an affected proposal (CC Member Addition):

| Field | Value (Lovelace) |
|-------|------------------|
| `spo_total_vote_power` | 21,405,491,557,393,012 |
| `activeYes` | 4,444,732,625,944,988 |
| `activeNo` | 0 |
| `activeAbstain` | 1,387,893,115,553,512 |
| `alwaysAbstain` | 0 |
| `alwaysNoConfidence` | 0 |
| `notVoted` (calculated) | 19,447,422,815,889,712 |
| **Breakdown Sum** | **25,280,048,557,388,212** |

**Discrepancy:** The breakdown sum exceeds `spo_total_vote_power` by **~18%** (3.87 quadrillion lovelace).

---

## Technical Details

### Affected Code Paths

#### 1. SPO Total Voting Power Fetching

**File:** `src/services/ingestion/proposal.service.ts:613-653`

```typescript
async function fetchSpoTotalVotingPower(epochNo: number): Promise<bigint> {
  // Fetches from /pool_voting_power_history?_epoch_no=${epochNo}
  // Aggregates all pools' voting power for a SPECIFIC epoch
  // ...
}
```

**Epoch Selection Logic:** `src/services/ingestion/proposal.service.ts:224-236`

```typescript
// SPO voting power uses (epoch - 1) because SPO stake snapshot is taken at epoch boundary
let spoTotalPowerEpoch: number;
if (!isCompleted) {
  spoTotalPowerEpoch = currentEpoch - 1;        // Active proposals
} else if (koiosProposal.ratified_epoch != null) {
  spoTotalPowerEpoch = koiosProposal.ratified_epoch - 1;  // Ratified
} else {
  spoTotalPowerEpoch = koiosProposal.expiration! - 1;     // Expired
}
```

#### 2. Vote Breakdown Fetching

**File:** `src/services/ingestion/proposal.service.ts:567-582`

```typescript
async function fetchProposalVotingSummary(proposalId: string): Promise<...> {
  // Fetches from /proposal_voting_summary?_proposal_id=${proposalId}
  // Returns voting power at the time each pool voted
  // NO EPOCH PARAMETER - uses mixed epoch data
}
```

#### 3. Percentage Calculation

**File:** `src/libs/proposalMapper.ts:338-434`

```typescript
const buildSpoVoteInfo = (proposal: ProposalWithVotes): GovernanceActionVoteInfo | undefined => {
  const total = toNumber(proposal.spoTotalVotePower);     // From epoch N-1
  const yes = toNumber(proposal.spoActiveYesVotePower);   // From mixed epochs
  // ...

  // New formula (epoch >= 534):
  denominator = total - abstainTotal;

  // BUG: If 'yes' is from a different epoch than 'total',
  // yesPercent can exceed 100%
  const yesPercent = denominator > 0 ? (yesTotal / denominator) * 100 : 0;
};
```

### Calculation Breakdown

Using the new formula for "Other actions" (CC Member Addition):

```
Given:
  total = 21,405,491,557,393,012 (from epoch N-1)
  yes = 4,444,732,625,944,988 (from voting summary - mixed epochs)
  abstain = 1,387,893,115,553,512
  alwaysAbstain = 0

Calculated:
  abstainTotal = abstain + alwaysAbstain = 1,387,893,115,553,512
  denominator = total - abstainTotal = 20,017,598,441,839,500

Expected:
  yesPercent = (4,444,732,625,944,988 / 20,017,598,441,839,500) * 100 = 22.2%

Actual API Response:
  yesPercent = 675.93%
```

The 675.93% result suggests the actual denominator used was approximately **657 trillion** instead of **20 quadrillion**, indicating either:
- Data corruption during storage/retrieval
- Type conversion issues with BigInt values
- Cached stale data being used

---

## Proposed Solutions

### Option A: Use Breakdown Sum as Effective Total (Recommended)

**Approach:** Calculate the effective total from the vote breakdown values to ensure internal consistency.

```typescript
const buildSpoVoteInfo = (proposal: ProposalWithVotes): GovernanceActionVoteInfo | undefined => {
  const yes = toNumber(proposal.spoActiveYesVotePower);
  const no = toNumber(proposal.spoActiveNoVotePower);
  const abstain = toNumber(proposal.spoActiveAbstainVotePower);
  const alwaysAbstain = toNumber(proposal.spoAlwaysAbstainVotePower);
  const alwaysNoConfidence = toNumber(proposal.spoAlwaysNoConfidencePower);

  // Calculate effective total from breakdown (ensures consistency)
  const breakdownSum = yes + no + abstain + alwaysAbstain + alwaysNoConfidence;
  const storedTotal = toNumber(proposal.spoTotalVotePower);

  // Use the larger of stored total or breakdown sum
  // If breakdown > stored, there's epoch mismatch - use breakdown for consistency
  const effectiveTotal = Math.max(storedTotal, breakdownSum);

  // Calculate notVoted based on effective total
  const notVoted = Math.max(0, effectiveTotal - breakdownSum);

  // Continue with percentage calculations using effectiveTotal...
};
```

**Pros:**
- Ensures percentages never exceed 100%
- Maintains internal consistency
- No external API changes required

**Cons:**
- May slightly undercount `notVoted` in some edge cases
- Doesn't fix the root data inconsistency

### Option B: Add Percentage Capping with Warnings

**Approach:** Cap percentages at 100% and log warnings for investigation.

```typescript
const yesPercent = Math.min(100, denominator > 0 ? (yesTotal / denominator) * 100 : 0);
const noPercent = Math.min(100, denominator > 0 ? (noTotal / denominator) * 100 : 0);

// Ensure combined doesn't exceed 100%
const totalPercent = yesPercent + noPercent;
if (totalPercent > 100) {
  console.warn(`[SPO Vote] Data inconsistency for proposal ${proposalId}: ` +
    `yes=${yesPercent.toFixed(2)}%, no=${noPercent.toFixed(2)}%, total=${totalPercent.toFixed(2)}%`);
  // Normalize
  const scale = 100 / totalPercent;
  yesPercent *= scale;
  noPercent *= scale;
}
```

**Pros:**
- Quick fix
- Provides visibility into data issues

**Cons:**
- Masks the underlying problem
- May show inaccurate relative percentages

### Option C: Fetch Total from Same Epoch as Votes

**Approach:** Modify the ingestion to use the proposal's submission epoch for consistency.

```typescript
// Use submission epoch for both total and vote breakdown
const spoTotalPowerEpoch = koiosProposal.proposed_epoch - 1;
```

**Pros:**
- Addresses root cause at data level
- More accurate historical data

**Cons:**
- May not account for votes cast in later epochs
- Still doesn't guarantee Koios API returns consistent data

### Recommendation

**Implement Option A** as the primary fix, with **Option B** as a safety net:

1. Calculate effective total from breakdown sum
2. Add percentage capping as a safeguard
3. Log warnings when inconsistencies are detected for monitoring

---

## Verification Steps

### Identifying Affected Proposals

```sql
-- Find proposals where SPO breakdown sum exceeds total
SELECT
  proposal_id,
  spo_total_vote_power,
  (spo_active_yes_vote_power + spo_active_no_vote_power +
   spo_active_abstain_vote_power + spo_always_abstain_vote_power +
   spo_always_no_confidence_power) as breakdown_sum
FROM proposals
WHERE (spo_active_yes_vote_power + spo_active_no_vote_power +
       spo_active_abstain_vote_power + spo_always_abstain_vote_power +
       spo_always_no_confidence_power) > spo_total_vote_power;
```

### Expected Behavior After Fix

1. SPO `yesPercent` should never exceed 100%
2. SPO `noPercent` should never exceed 100%
3. `yesPercent + noPercent` should not exceed 100% (abstain is calculated separately)
4. Breakdown values should sum to at most the effective total
5. Warnings logged when data inconsistencies are detected

### Testing Checklist

- [ ] Unit tests for `buildSpoVoteInfo()` with edge cases
- [ ] Integration test with known problematic proposal data
- [ ] Verify API response shows capped percentages
- [ ] Check logs for data inconsistency warnings
- [ ] Manual verification against Cardano governance explorer

---

## Related Files

| File | Purpose |
|------|---------|
| `src/libs/proposalMapper.ts` | SPO percentage calculation logic |
| `src/services/ingestion/proposal.service.ts` | Data fetching from Koios API |
| `src/models/governance_action.model.ts` | Type definitions |
| `src/types/koios.types.ts` | Koios API response types |
| `prisma/schema.prisma` | Database schema for voting power fields |

---

## References

- [Cardano Governance Specification](https://github.com/cardano-foundation/CIPs/tree/master/CIP-1694)
- [Koios API Documentation](https://api.koios.rest/)
- Frontend bug investigation: `/docs/spo-percentage-bug-investigation.md` (cgov repo)
