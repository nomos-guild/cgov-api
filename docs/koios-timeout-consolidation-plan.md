# Koios Timeout Consolidation Plan

## Problem

We currently have **6 different timeout values** scattered across `src/services/koios.ts`, making it difficult to tune Koios behaviour in production. When Koios is slow or under load, the mix of timeouts leads to confusing failure modes (e.g. `socket hang up` vs clean timeout errors) and retries that are actually *more* restrictive than the original attempt.

### Current timeout inventory (koios.ts)

| Constant / Setting               | Value  | Purpose                                   |
|-----------------------------------|--------|-------------------------------------------|
| `httpsAgent.timeout`              | 35,000 | TCP socket timeout (HTTP & HTTPS agents)  |
| `KOIOS_DEFAULT_TIMEOUT_MS`        | 30,000 | Default axios request timeout             |
| `KOIOS_DEFAULT_RETRY_TIMEOUT_MS`  | 20,000 | Timeout applied on retry attempts         |
| `KOIOS_TX_METADATA_TIMEOUT_MS`    | 20,000 | `/tx_metadata` specific timeout           |
| Per-endpoint map (`/tip`)         | 10,000 | Lightweight endpoint override             |
| Per-endpoint map (`/drep_info`, `/epoch_info`, `/committee_info`) | 15,000 | Lightweight endpoint overrides |
| Per-endpoint map (`/drep_updates`, `/drep_list`) | 20,000 | Endpoint overrides             |

### Observed symptoms (2026-03-22 logs)

- `/tip` timing out at 10s, then retrying 3 times
- `/drep_updates` and `/drep_delegators` timing out at 20s
- `/vote_list` and `/proposal_voting_summary` timing out at 30s (default)
- Multiple `socket hang up` errors — the 35s agent socket timeout kills the TCP connection just 5s after the 30s request timeout, racing with it
- Retry attempts use a *shorter* timeout (20s) than the initial attempt (30s), so retries are more likely to fail

## Goal

Consolidate to a **single tunable timeout** controlled by one environment variable, with derived values for the socket layer and retries. One knob to turn in production.

## Design

### New configuration

| Setting | Value | Derivation |
|---|---|---|
| `KOIOS_REQUEST_TIMEOUT_MS` (env var) | Default: `30000` | Single source of truth |
| Agent socket timeout | `KOIOS_REQUEST_TIMEOUT_MS + 5000` | Always exceeds request timeout to avoid `socket hang up` races |
| Retry attempt timeout | Same as `KOIOS_REQUEST_TIMEOUT_MS` | Retries get the same budget as the initial attempt |

### What gets removed

- `KOIOS_DEFAULT_TIMEOUT_MS` — replaced by `KOIOS_REQUEST_TIMEOUT_MS`
- `KOIOS_DEFAULT_RETRY_TIMEOUT_MS` — no longer separate
- `KOIOS_TX_METADATA_TIMEOUT_MS` — no longer separate
- `KOIOS_ENDPOINT_TIMEOUTS` map — removed entirely
- Hardcoded `35_000` on HTTP/HTTPS agents — derived from the single timeout

### What stays unchanged

- Retry count and backoff config (`KOIOS_RETRY_OPTIONS`)
- Rate limiting / pressure shedding config
- Concurrency limits
- Keep-alive agent pooling settings (`maxSockets`, `maxFreeSockets`, `keepAlive`)

## Tasklist

- [x] **1. Add env-var-backed constant** — Replace the 3 timeout constants (`KOIOS_DEFAULT_TIMEOUT_MS`, `KOIOS_DEFAULT_RETRY_TIMEOUT_MS`, `KOIOS_TX_METADATA_TIMEOUT_MS`) with a single `KOIOS_REQUEST_TIMEOUT_MS` read from `process.env` with a `30000` default (use existing `getBoundedIntEnv` helper)
- [x] **2. Derive agent socket timeout** — Change the `httpsAgent` and `httpAgent` timeout from hardcoded `35_000` to `KOIOS_REQUEST_TIMEOUT_MS + 5000`
- [x] **3. Remove per-endpoint timeout map** — Delete the `KOIOS_ENDPOINT_TIMEOUTS` map and any code that looks up per-endpoint overrides
- [x] **4. Unify retry timeout** — Update the retry logic so retry attempts use the same `KOIOS_REQUEST_TIMEOUT_MS` instead of a separate reduced value
- [x] **5. Remove TX metadata timeout** — Update `tx_metadata_strict` profile to use the shared timeout
- [x] **6. Update log messages** — Ensure timeout error logs still include the timeout value that was applied (now it will be the same everywhere, but should still be logged for confirmation)
- [ ] **7. Test locally** — Verify the service starts, timeout is read from env, and a low value (e.g. `KOIOS_REQUEST_TIMEOUT_MS=5000`) triggers clean timeout errors (not `socket hang up`)
- [ ] **8. Deploy with current default (30s)** — Ship with the default so behaviour is unchanged initially, then tune the single knob in Cloud Run env vars as needed

## Risks & Considerations

- **No regression at 30s default**: With the default value, the only behaviour change is that retries get 30s instead of 20s (an improvement) and per-endpoint "fast" timeouts are removed (minor — those endpoints either respond in <1s or are down)
- **Socket hang up elimination**: The +5s buffer on the agent socket timeout should eliminate the race condition that causes `socket hang up` instead of clean `timeout of Xms exceeded` errors
- **Future tuning**: If we find some endpoints genuinely need different timeouts, we can re-add a targeted override — but start simple and see if one value is sufficient
