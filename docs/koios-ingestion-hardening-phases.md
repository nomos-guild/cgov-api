# Koios Ingestion Hardening Plan (Integrity + Performance)

This document captures the highest-impact integrity and performance issues in the current Koios fetch and DB injection pipeline, and breaks remediation into separate phases that can be implemented one at a time.

Goal: stable, resilient ingestion with fresh and accurate data under Koios pressure and partial failures.

## Global Execution Constraints (Apply to Every Phase)

- Execute all phases **without schema changes** (no new tables/columns/indexes, no migration dependencies).
- Execute all phases **without environment-variable knobs** (no runtime env toggles, kill switches, or phased behavior controlled by env).
- Favor application-level logic changes, ordering fixes, query/write strategy changes, and observability additions that operate within the current schema and static configuration.

---

## Current Risks Observed

### Integrity Risks

1. **DRep metadata can be stale even after successful sync**
   - In `src/services/ingestion/drep-sync.service.ts`, metadata extraction keeps the first non-empty value while iterating updates.
   - In `src/services/governanceProvider.ts`, `listDrepUpdates` is ordered ascending (`block_time.asc`), so older metadata can win over newer metadata.
   - Impact: visible DRep profile fields (`name`, `paymentAddr`, `iconUrl`, CIP-119 fields) may not reflect latest on-chain metadata.

2. **Offset pagination on mutable datasets risks drift (skip/dup)**
   - Vote and delegator fetches rely on offset paging while source data can change during the run (`vote_list`, `drep_delegators`, `account_update_history`).
   - Impact: occasional missing or duplicate rows in a run, especially during active epochs.

3. **Potential false clears in delegation reconciliation**
   - In `src/services/ingestion/delegation-sync.service.ts`, absent stake addresses are cleared when no explicit fetch failures occur.
   - A logically incomplete snapshot (without explicit request failure) can still trigger incorrect clears.
   - Impact: temporary or persistent delegation-state corruption until later backfill/repair.

4. **Ambiguous winner when same stake appears under multiple DReps in one scan**
   - `allDelegatorsByStake` overwrites by last seen row.
   - Impact: nondeterministic state writes in rare inconsistent Koios snapshots.

### Performance / Stability Risks

1. **N+1 Koios fetch pattern in DRep info sync**
   - `syncAllDrepsInfo` can call `/drep_updates` per DRep when metadata hash changed.
   - Impact: long runtimes, elevated Koios pressure, larger failure surface.

2. **Frequent per-vote/per-voter enrichment**
   - `ensureVoterExists` may trigger Koios fetches during vote ingestion for uncached voters.
   - Impact: ingestion slows down as vote volume grows, plus increased Koios traffic burstiness.

3. **Large in-memory accumulations in full scans**
   - Full delegator and vote scans collect large maps/arrays before write stages.
   - Impact: memory pressure and slower GC under large epochs.

4. **Recovery relies on retries/checkpoints but lacks integrity guardrails**
   - You have strong lock/retry/backoff patterns, but fewer post-sync validation invariants.
   - Impact: partial correctness issues may persist until noticed externally.

---

## Phase 1: Data Correctness Guardrails (Do First)

### Objective

Stop silent data corruption/staleness before optimizing speed.

### Changes

1. **Fix DRep metadata precedence**
   - Make metadata selection explicitly choose newest update (latest `block_time`, then tx hash tie-breaker), not first non-empty from ascending scan.
   - Apply same rule anywhere `drep_updates` is interpreted.

2. **Add reconciliation safety checks before destructive clears**
   - In delegation sync, gate `toClear` execution behind snapshot-quality checks:
     - minimum expected coverage ratio,
     - monotonic consistency checks,
     - optional two-run confirmation before nulling existing state.

3. **Add deterministic conflict handling for duplicate stake entries**
   - If same stake is seen under multiple DReps in one run, resolve with explicit rule (latest epoch/slot, highest block_time, then deterministic tie-breaker).
   - Emit integrity metric/log for conflict count.

### Exit Criteria

- DRep metadata reflects latest known update in verification queries.
- No destructive clears run when snapshot quality is uncertain.
- Conflict cases are deterministic and observable.

---

## Phase 2: Koios Load Shaping + Throughput

### Objective

Reduce Koios pressure and speed up ingestion without losing correctness.

### Changes

1. **Batch-first enrichment strategy**
   - Preload missing DRep/SPO identities in batches before per-vote writes.
   - Avoid repeated `ensureVoterExists` Koios calls in hot loops.

2. **Adaptive page strategy**
   - Tune page size/delay dynamically by endpoint pressure profile.
   - Prefer endpoint-specific pacing where failure rates rise.

3. **Chunked streaming write flow**
   - Process and write in smaller windows to cap memory usage.
   - Avoid very large in-memory maps when not required.

4. **Idempotent upsert/write contracts**
   - Keep deterministic IDs and `skipDuplicates`, but tighten stage boundaries so retries do less repeated work.

### Exit Criteria

- Lower Koios request burstiness and timeout rate.
- Reduced average sync duration for proposal and delegation jobs.
- Stable memory usage during large-epoch scans.

---

## Phase 3: Pagination Robustness

### Objective

Eliminate offset drift issues on mutable endpoints.

### Changes

1. **Cursor-like progression where possible**
   - Prefer monotonic watermark windows (`block_time`, `tx_hash`, epoch+slot keys) over raw offset-only loops.

2. **Two-pass reconciliation for mutable windows**
   - Pass 1: collect.
   - Pass 2: small overlap recheck to capture late-arriving rows and dedupe.

3. **Stable ordering contracts**
   - Ensure every paginated call has deterministic order + tie-breakers to avoid boundary duplication.

### Exit Criteria

- No observable skip/dup from pagination drift in validation runs.
- Repeat runs over same window converge to identical DB state.

---

## Phase 4: Operational Hardening + Runbooks

### Objective

Make incident response fast and predictable in production.

### Changes

1. **Runbook for degraded Koios periods**
   - Clear actions by severity: throttle, skip non-critical jobs, run targeted repair after recovery.

2. **Checkpoint observability**
   - Standardize checkpoint progress and expose per-phase progress/ETA.

3. **Canary + rollback controls**
   - Use deployment/version-based rollout for new reconciliation logic and clear behavior (no env-controlled feature flags).
   - Roll out by job type, then full rollout, with rollback via version deploy.

### Exit Criteria

- On-call can recover without code changes.
- Rollback path exists for every destructive/data-shaping change.
- MTTR decreases for ingestion incidents.

---

## Recommended Implementation Order

1. Phase 1 (correctness guardrails)
2. Phase 2 (throughput/load shaping)
3. Phase 3 (pagination robustness)
4. Phase 4 (operations/runbooks)

Do not start performance tuning before Phase 1 guardrails are in place.

---

## Suggested KPIs to Track Across All Phases

- Koios error rate by endpoint (`429`, `5xx`, timeout, connection reset)
- Ingestion freshness lag (seconds/minutes from chain observable to DB state)
- Proposal vote parity checks (Koios vs DB counts by proposal)
- Delegation parity checks (sampled Koios vs `stake_delegation_state`)
- DRep metadata freshness mismatch rate
- Job success/partial/fail ratio and average duration
