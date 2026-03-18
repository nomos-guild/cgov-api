# Koios Fetch and Ingestion Review

Date: 2026-03-18

## Scope

Review of Koios fetch paths and ingestion flows, with focus on `koios.ts`, proposal/vote ingestion, `syncOnRead.ts`, interactive analytics callers, and bulk sync entry points.

## Executive Summary

The current branch already has the right baseline in `src/services/koios.ts`: retries, concurrency limits, burst limiting, cooldown-based shedding, payload caps, pagination clamping, and request-source-aware logging. `syncOnRead.ts` also already has DB-backed proposal guards and pressure-aware skipping, and `sync-utils.ts` already provides a cached/single-flight current-epoch helper.

The remaining plan should stay focused on correctness first:

1. Use one DB-backed coordination model for all bulk sync entry points.
2. Assume Cloud Run multi-instance autoscaling is normal; process-local state is optimization only.
3. Make partial failures visible so a proposal is not marked fully synced when votes or voting power failed.
4. Canonicalize sync-on-read identifiers before dedupe, cooldown, or discovery fetches.
5. Finish observability and retry cleanup before adding more caching.
6. Optimize repeated `/proposal_list` work only after instrumentation confirms it is still a major cost.

Constraint: do not make Prisma or schema changes in this phase.

## Baseline To Preserve

- Keep Koios retries and throttling centralized in `src/services/koios.ts`.
- Keep sync-on-read as best-effort background freshness, not read-through consistency.
- Keep bounded concurrency in ingestion loops.
- Keep `getKoiosCurrentEpoch()` in `src/services/ingestion/sync-utils.ts` as the shared helper target.

## Main Risks

### 1. Coordination is inconsistent across entry points

`sync-proposals.job.ts` still relies on an in-process guard, while manual trigger and parts of sync-on-read use DB-backed locking. In production, Cloud Run can run multiple fresh instances, so process-local guards do not prevent overlap across cron, manual, and sync-on-read paths.

**Plan:** Make every bulk sync path participate in the same DB-backed `proposal-sync` lock. Local guards can remain, but only as a fast-path optimization.

### 2. Partial-success semantics are too weak

Proposal ingestion can appear successful even when vote sync or voting-power refresh partially failed. The biggest gap is `updateProposalVotingPower()` returning `void`, which prevents callers from distinguishing success from failure.

**Plan:** Return structured success/failure results from downstream steps, surface partial failures in logs/metrics, and do not finalize terminal status when sub-pipelines failed.

### 3. Sync-on-read still does avoidable duplicate work

The detail path can still perform expensive comparison reads before a winning DB guard is established. Raw identifier dedupe is also too weak: the same proposal can arrive as `proposalId`, DB id, `txHash`, or `txHash:certIndex`, and invalid identifiers can still trigger `/proposal_list` discovery work.

**Plan:** Canonicalize and validate identifiers early, move the per-proposal DB guard ahead of expensive Koios comparison reads, and bound in-memory cooldown state.

### 4. Observability and retry boundaries are still uneven

Some Koios calls still lack `context.source`, and a few outer `withRetry()` wrappers remain around code that already benefits from `koios.ts` retries. The worst case is proposal ingestion, where an outer retry can repeat the entire pipeline.

**Plan:** Make `source` effectively required, remove nested Koios retry layers, and keep any outer retry limited to Prisma connectivity failures via `prismaRetry.ts`.

### 5. Performance cleanup should be targeted, not speculative

Repeated `/proposal_list` reads, cache ownership issues, and helper duplication still exist, but they are now secondary to coordination and success semantics. Some in-memory caches are also process-global and unbounded, which is a memory/stability concern more than a correctness concern.

**Plan:** Add instrumentation first, then optimize the highest-cost paths. Prefer short-lived or per-run caches over long-lived module-global state where overlap is possible.

## Preconditions

- Confirm which proposal-sync trigger path is authoritative in production: cron, manual trigger, or both.
- Confirm Cloud Run instance/concurrency settings and Prisma connection budget.
- Confirm whether Koios supports a reliable targeted proposal lookup before investing further in `/proposal_list` caching.
- Decide acceptable freshness windows for interactive sync-on-read behavior.
- Keep implementation within the current Prisma and database schema.

## Hardening Plan

### Phase 1: Correctness and Coordination

- Unify cron, manual trigger, and sync-on-read on one DB-backed bulk-sync lock.
- Treat all process-local cooldowns, caches, and in-flight sets as non-authoritative.
- Move per-proposal DB guard acquisition earlier in sync-on-read.
- Canonicalize and validate proposal identifiers before dedupe, cooldown, or discovery reads.
- Bound or evict in-memory identifier cooldown state.
- Make downstream ingest steps return structured results.
- Do not finalize terminal proposal status on partial failure.
- Keep best-effort sync-on-read semantics explicit.
- Add counters/logging for partial success, fallbacks, and duplicate-work scenarios.

### Phase 2: Observability and Shared Helpers

- Add `context.source` to the remaining Koios call sites, prioritizing interactive paths.
- Remove nested `withRetry()` wrappers that sit on top of `koios.ts` retries.
- Replace the outer proposal-ingest retry with Prisma-connectivity-only retry using `prismaRetry.ts`.
- Consolidate remaining `/tip` and current-epoch helpers onto `sync-utils.ts`.
- Extract duplicated small helpers only where it reduces drift.

### Phase 3: Measured Performance Improvements

- Add a short-lived cached single-flight `/proposal_list` accessor for interactive callers, with bypass for bulk jobs.
- Reduce sync-on-read duplicate pre-ingest work after guard timing and canonicalization are fixed.
- Centralize endpoint fallback strategy.
- Scope bulk vote caches per run or single-flight them.
- Clear or bound long-lived voter caches between bulk runs.
- Align fallback semantics only where it is safe without changing schema or API contracts.

### Phase 4: Only If Metrics Still Justify It

- Add request lanes or reserved concurrency for interactive vs background callers.
- Batch remaining high-volume per-entity loops more aggressively.
- Tune Cloud Run scaling and connection budgets if burst traffic still causes avoidable pressure.
- Consider a more durable cache layer only if in-process caching remains insufficient.

## Suggested Tickets

- `KOIOS-COORD-001`: Unify proposal-sync locking across cron, manual, and sync-on-read
- `KOIOS-DQ-002`: Define proposal-ingest completeness and partial-success semantics
- `KOIOS-OBS-003`: Enforce `context.source` on remaining Koios call sites
- `KOIOS-SOR-004`: Canonicalize sync-on-read identifiers and move proposal guard earlier
- `KOIOS-RETRY-005`: Remove nested Koios retries and keep outer retry Prisma-only
- `KOIOS-PERF-006`: Instrument and reduce repeated `/proposal_list` work
- `KOIOS-CACHE-007`: Bound or scope process-local caches used by ingestion
