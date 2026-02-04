# Governance Analytics API Endpoints

**Date:** 2026-02-04
**Branch:** feature/inject-epoch-data

## Summary

Implemented a comprehensive set of governance analytics API endpoints based on a detailed KPI specification document. Created 22 new endpoints organized across 6 categories covering Ada Holder Participation, DRep Insights, SPO Governance, Treasury Health, Constitutional Committee Activity, and Tooling/UX metrics. All endpoints follow the existing codebase patterns with proper TypeScript typing, BigInt serialization, pagination, and OpenAPI documentation.

## What Was Done

1. **Created analytics response types** (`src/responses/analytics.response.ts`) - 25+ TypeScript interfaces defining all response structures
2. **Implemented Category 1 - Ada Holder Participation** (6 endpoints):
   - Voting Turnout (% ada) for DRep and SPO
   - Active Stake Address Participation
   - Delegation Rate (% ada)
   - Delegation Distribution by Wallet Size
   - New Wallet Delegation Rate
   - Inactive Delegated Ada
3. **Implemented Category 2 - DRep Insights & Activity** (5 endpoints):
   - Delegation Decentralization (Gini coefficient)
   - DRep Activity Rate
   - DRep Rationale Rate
   - DRep Voting Correlation
   - DRep Lifecycle Rate
4. **Implemented Category 3 - SPO Governance Participation** (4 endpoints):
   - SPO Silent Stake Rate
   - SPO Default Stance Adoption
   - Entity Voting Power Concentration (HHI index)
   - SPO-DRep Vote Divergence
5. **Implemented Category 4 - Governance Action & Treasury Health** (5 endpoints):
   - Governance Action Volume & Source
   - Governance Action Contention Rate
   - Treasury Balance Rate
   - Time-to-Enactment
   - Constitutional Compliance Clarity
6. **Implemented Category 5 - Constitutional Committee Activity** (4 endpoints):
   - CC Time-to-Decision
   - CC Member Participation Rate
   - CC Abstain Rate
   - CC Vote Agreement Rate
7. **Implemented Category 6 - Tooling & UX** (1 endpoint):
   - Gov Info Availability
8. **Created analytics route file** with full OpenAPI documentation
9. **Registered analytics router** in main index.ts under `/analytics` path

## Key Learnings

### BigInt Percentage Calculations
When calculating percentages with BigInt (e.g., vote power ratios), use scaled arithmetic to preserve precision:
```typescript
const drepTurnoutPct = drepTotal > 0n
  ? Number((drepActive * 10000n) / drepTotal) / 100
  : null;
```
This multiplies by 10000n first, then divides and converts to Number for the final percentage.

### Gini Coefficient for Decentralization
Implemented standard Gini coefficient calculation for measuring delegation concentration:
```typescript
// Gini = (2 * weightedSum - (n + 1) * sum) / (n * sum)
const numerator = 2n * weightedSum - BigInt(n + 1) * sum;
const denominator = BigInt(n) * sum;
const gini = Number(numerator * 10000n / denominator) / 10000;
```

### Latest Vote per Voter
For CC votes where members can change their vote, always use `orderBy` and dedupe:
```typescript
const ccVotes = await prisma.onchainVote.findMany({
  where: { voterType: VoterType.CC },
  orderBy: [{ votedAt: "desc" }, { createdAt: "desc" }],
});
const seenVotes = new Set<string>();
for (const vote of ccVotes) {
  const key = `${vote.ccId}-${vote.proposalId}`;
  if (!seenVotes.has(key)) {
    seenVotes.add(key);
    // Process vote
  }
}
```

### Contention Score Formula
Measuring how close a vote is (0-100, higher = more contentious):
```typescript
const diff = Math.abs(yesPct - noPct);
const contentionScore = 100 - diff; // 50/50 = 100, 100/0 = 0
const isContentious = diff < 20; // Within 40-60 range
```

### HHI (Herfindahl-Hirschman Index) for Concentration
Standard concentration metric for entity voting power:
```typescript
let hhi = 0;
for (const [, data] of groupPower) {
  const sharePct = Number((data.power * 10000n) / totalPower) / 100;
  hhi += sharePct * sharePct;
}
// HHI ranges 0-10000 (higher = more concentrated)
```

## Files Changed

| File | Type | Description |
|------|------|-------------|
| `src/responses/analytics.response.ts` | New | 25+ TypeScript interfaces for analytics responses |
| `src/responses/index.ts` | Modified | Export analytics responses |
| `src/controllers/analytics/index.ts` | New | Controller barrel exports |
| `src/controllers/analytics/getVotingTurnout.ts` | New | Voting turnout endpoint |
| `src/controllers/analytics/getStakeParticipation.ts` | New | Stake participation endpoint |
| `src/controllers/analytics/getDelegationRate.ts` | New | Delegation rate endpoint |
| `src/controllers/analytics/getDelegationDistribution.ts` | New | Delegation distribution endpoint |
| `src/controllers/analytics/getNewDelegationRate.ts` | New | New delegation rate endpoint |
| `src/controllers/analytics/getInactiveAda.ts` | New | Inactive ADA endpoint |
| `src/controllers/analytics/getGiniCoefficient.ts` | New | Gini coefficient endpoint |
| `src/controllers/analytics/getDRepActivityRate.ts` | New | DRep activity rate endpoint |
| `src/controllers/analytics/getDRepRationaleRate.ts` | New | DRep rationale rate endpoint |
| `src/controllers/analytics/getDRepCorrelation.ts` | New | DRep voting correlation endpoint |
| `src/controllers/analytics/getDRepLifecycleRate.ts` | New | DRep lifecycle rate endpoint |
| `src/controllers/analytics/getSpoSilentStake.ts` | New | SPO silent stake endpoint |
| `src/controllers/analytics/getSpoDefaultStance.ts` | New | SPO default stance endpoint |
| `src/controllers/analytics/getEntityConcentration.ts` | New | Entity concentration endpoint |
| `src/controllers/analytics/getVoteDivergence.ts` | New | Vote divergence endpoint |
| `src/controllers/analytics/getActionVolume.ts` | New | Action volume endpoint |
| `src/controllers/analytics/getContentionRate.ts` | New | Contention rate endpoint |
| `src/controllers/analytics/getTreasuryRate.ts` | New | Treasury rate endpoint |
| `src/controllers/analytics/getTimeToEnactment.ts` | New | Time-to-enactment endpoint |
| `src/controllers/analytics/getComplianceStatus.ts` | New | Compliance status endpoint |
| `src/controllers/analytics/getCCTimeToDecision.ts` | New | CC time-to-decision endpoint |
| `src/controllers/analytics/getCCParticipation.ts` | New | CC participation endpoint |
| `src/controllers/analytics/getCCAbstainRate.ts` | New | CC abstain rate endpoint |
| `src/controllers/analytics/getCCAgreementRate.ts` | New | CC agreement rate endpoint |
| `src/controllers/analytics/getInfoAvailability.ts` | New | Info availability endpoint |
| `src/routes/analytics.route.ts` | New | Route definitions with OpenAPI docs |
| `src/controllers/index.ts` | Modified | Export analyticsController |
| `src/index.ts` | Modified | Mount /analytics router |

## Patterns Discovered

### Multi-Table Aggregation Pattern
For endpoints needing data across multiple tables (e.g., participation requiring votes + delegations):
```typescript
// 1. Get entities that voted
const votingDreps = await prisma.onchainVote.findMany({
  where: { voterType: VoterType.DREP },
  select: { drepId: true },
  distinct: ["drepId"],
});
const votingDrepIds = votingDreps.map(v => v.drepId).filter(Boolean);

// 2. Aggregate related data
const [participatingStats, totalStats] = await Promise.all([
  prisma.stakeDelegationState.aggregate({
    where: { drepId: { in: votingDrepIds } },
    _count: { stakeAddress: true },
    _sum: { amount: true },
  }),
  prisma.stakeDelegationState.aggregate({
    where: { drepId: { not: null } },
    _count: { stakeAddress: true },
    _sum: { amount: true },
  }),
]);
```

### Epoch Time Mapping Pattern
For wall-clock calculations from epoch numbers:
```typescript
const epochTimestamps = await prisma.epochTotals.findMany({
  where: { epoch: { in: Array.from(epochs) } },
  select: { epoch: true, startTime: true, endTime: true },
});
const epochTimeMap = new Map<number, Date>();
for (const et of epochTimestamps) {
  if (et.startTime && et.endTime) {
    const midpoint = new Date((et.startTime.getTime() + et.endTime.getTime()) / 2);
    epochTimeMap.set(et.epoch, midpoint);
  }
}
```

### Pairwise Correlation Pattern
For computing correlation between voting patterns:
```typescript
function calculateCorrelation(votes1: Map<string, VoteType>, votes2: Map<string, VoteType>) {
  const sharedProposals = [...votes1.keys()].filter(pid => votes2.has(pid));
  if (sharedProposals.length < 2) return { correlation: null };

  // Map votes to numeric: YES=1, NO=-1, ABSTAIN=0
  const x = sharedProposals.map(pid => voteToNum(votes1.get(pid)!));
  const y = sharedProposals.map(pid => voteToNum(votes2.get(pid)!));

  // Pearson correlation
  const meanX = x.reduce((a, b) => a + b) / x.length;
  const meanY = y.reduce((a, b) => a + b) / y.length;
  // ... standard Pearson formula
}
```

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Create new `/analytics` route domain | Keep analytics endpoints separate from existing operational endpoints |
| Use BigInt scaled arithmetic for percentages | Avoid precision loss with large vote power numbers |
| Default pageSize=20, max=100 | Consistent with existing endpoints; reasonable for dashboards |
| Use cumulative totals for new delegation rate | Accurate "first-ever delegation" requires change log replay |
| HHI for concentration instead of simple top-N | Industry-standard metric, more nuanced than Gini for this use case |
| Constitutional status 67% threshold | Matches on-chain governance rules |
| Contention threshold at 20% difference | 40-60 split represents meaningful contention |

## Skills Evolved

Based on learnings from this session, the following skills were updated:

| Skill | Version | Changes |
|-------|---------|---------|
| add-endpoint | 1.1.0 → 1.2.0 | Added BigInt percentage calculation, latest-vote deduplication, epoch time mapping, and analytics metrics (Gini, HHI, contention) patterns |
