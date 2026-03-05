# Cron Job Stabilization Plan

## Problem Summary

Multiple cron jobs are hitting the Koios API concurrently, causing cascading timeouts (`30000ms exceeded`), socket hang-ups, and aborted requests. The logs from `2026-03-05T06:06–06:08Z` show **simultaneous requests** to the same heavy endpoints (`/drep_delegators`, `/drep_info`, `/drep_voting_power_history`, `/pool_voting_power_history`, `/vote_list`) from different jobs running at the same time.

---

## Root Cause Analysis

### 1. Overlapping Schedules at the 06:00 Hour

At ~06:02–06:10 UTC, **at least 2–3 Koios-heavy jobs** can be running simultaneously:

| Time   | Job                | Heavy Endpoints Hit                                                        |
|--------|--------------------|----------------------------------------------------------------------------|
| 06:02  | DRep Inventory     | `/drep_list`, `/drep_info`, `/drep_delegators`, `/drep_voting_power_history` |
| 06:05  | Proposal Sync      | `/vote_list`, `/drep_info`, `/drep_voting_power_history`, `/pool_voting_power_history` |
| 06:12  | Epoch Totals       | `/drep_delegators`, `/drep_voting_power_history`, `/pool_voting_power_history` |
| 06:30  | Voter Power (6h)   | `/drep_info`, `/drep_voting_power_history`, `/pool_voting_power_history`   |

DRep Inventory (starting at :02) is a **long-running job** that can still be active when Proposal Sync fires at :05 and Epoch Totals fires at :12. All three hammer the same endpoints.

### 2. Shared Heavy Endpoints

These endpoints are the most contended:

| Endpoint                       | Called By                                          | Weight  |
|--------------------------------|----------------------------------------------------|---------|
| `/drep_delegators`             | DRep Inventory, Epoch Totals, DRep Delegation      | **Very Heavy** (paginated, per-DRep) |
| `/drep_info`                   | DRep Inventory, DRep Info, Voter Power, Proposals   | **Heavy** (batch POST) |
| `/drep_voting_power_history`   | Voter Power, Epoch Totals, DRep Inventory           | **Heavy** (paginated) |
| `/pool_voting_power_history`   | Voter Power, Epoch Totals, Proposals                | **Heavy** (paginated) |
| `/vote_list`                   | Proposals                                           | **Heavy** (paginated, epoch-filtered) |

### 3. Retry Storms Amplify the Problem

With 5 retries and exponential backoff (3s → 6s → 12s → 24s → 30s), a single timed-out request can generate up to **6 attempts** over ~75 seconds. When multiple jobs retry simultaneously, they create a **retry storm** that keeps Koios saturated.

### 4. No Global Concurrency Limit

Each job has an `isRunning` guard to prevent itself from overlapping, but there is **no cross-job coordination**. Nothing prevents DRep Inventory + Proposal Sync + Epoch Totals from all firing requests at the same time.

---

## Proposed Changes

### Phase 1: Schedule Separation (Quick Win)

Spread Koios-heavy jobs so they never run in the same window. Group by API load:

**Proposed Schedule:**

| Minute | Job                  | Frequency     | Rationale                                    |
|--------|----------------------|---------------|----------------------------------------------|
| :00    | Proposal Sync        | Every 5 min   | Keep at 5 min, runs frequently but lightweight per cycle |
| :02    | DRep Inventory       | Hourly        | Keep as-is, no overlap with proposals at :00  |
| :22    | DRep Info            | Hourly        | Keep as-is, 20 min gap from inventory         |
| :37    | DRep Lifecycle       | Hourly        | Keep as-is, lightweight                       |
| :42    | Epoch Totals         | Hourly        | **Move from :12 → :42** to avoid overlap with inventory |
| :47    | Pool Groups          | Hourly        | Keep as-is, lightweight                       |
| :52    | DRep Delegation      | Hourly        | **Move from :57 → :52**, still away from totals |
| :33    | Missing Epochs       | Every 6 hours | Keep as-is                                    |
| :30    | Voter Power          | Every 6 hours | Keep at 6 hours; DB-first DRep lookups (Phase 2) reduce its API footprint |

**Key changes:**
- **Epoch Totals**: `:12` → `:42` — gives DRep Inventory a full 40-minute window
- **Voter Power**: Keep at `30 */6 * * *` — DB-first DRep lookups (Phase 2) reduce its Koios footprint
- **DRep Delegation**: `:57` → `:52` — small shift to add buffer before next hour's cycle

### Phase 2: DB-First DRep Lookups

Multiple jobs independently call `/drep_info` from Koios to get DRep data. DRep Inventory already fetches and stores all DRep info in the database every hour at `:02`. Other jobs should **read DReps from the database first** and only fall back to a Koios fetch for any DRep not found locally.

#### Per-Job DRep Data Requirements

Each job that calls `/drep_info` uses different fields. The DB-first helper must ensure that when a DRep **is not** in the database and we fall back to Koios, we fetch and store the **same fields** the original job expected:

| Job | Koios Endpoint(s) | Fields Actually Used | DB Columns Read |
|-----|-------------------|---------------------|-----------------|
| **DRep Inventory** | `POST /drep_info` | `drep_id`, `amount`, `registered`, `active`, `expires_epoch_no`, `meta_url`, `meta_hash` | `votingPower`, `registered`, `active`, `expiresEpoch`, `metaUrl`, `metaHash` |
| **DRep Info** | `POST /drep_info` + `GET /drep_updates` | All of the above + CIP-119 metadata: `givenName`, `paymentAddress`, `image.contentUrl`, `doNotList`, `bio`, `motivations`, `objectives`, `qualifications`, `references` | All core columns + `name`, `paymentAddr`, `iconUrl`, `doNotList`, `bio`, `motivations`, `objectives`, `qualifications`, `references` |
| **Proposal Sync** | `POST /drep_info` | `active`, `amount` only | `active`, `votingPower` |

> **Key insight:** All three jobs call the same `/drep_info` endpoint which returns all core fields (`drep_id`, `amount`, `registered`, `active`, `expires_epoch_no`, `meta_url`, `meta_hash`). The difference is which fields each job _reads_ from the response. Since `/drep_info` always returns the full set, the fallback fetch naturally provides everything each job needs.
>
> The exception is **DRep Info Sync**, which _also_ calls `/drep_updates` for CIP-119 metadata. This job does a full refresh of all DReps every epoch, so it should continue to own its own `/drep_updates` calls and NOT go through the shared helper (it's the canonical source that populates the DB for others).

**How it works:**

1. Create a shared helper `getDrepInfoBatch(drepIds)` in `src/services/drep-lookup.ts` that:
   - Queries the local `Drep` table for the requested DRep IDs
   - Returns DB records for any DReps found (all core columns are present since DRep Inventory populates them)
   - For DReps **not found** in the DB, calls `POST /drep_info` with the missing IDs (batch size 50)
   - Maps the Koios response to DB columns and upserts the new rows so future lookups skip Koios
   - Returns a **unified shape** matching the `Drep` model columns (not raw Koios types), so callers read `.active`, `.votingPower`, etc. consistently whether the data came from DB or Koios

2. Replace direct `/drep_info` Koios calls in these jobs with the shared helper:
   - **DRep Inventory** (`drep-sync.service.ts:221-290`): Replace `koiosPost('/drep_info', ...)` with `getDrepInfoBatch(newDrepIds)`
   - **Proposal Sync** (`proposal.service.ts:882-968`): Replace `koiosPost('/drep_info', ...)` in `fetchInactiveDrepVotingPowerForActiveProposal` with `getDrepInfoBatch(batch)`, then read `.active` and `.votingPower` from the result

3. **Do NOT replace** the `/drep_info` call in **DRep Info Sync** — that job is the canonical full refresh and also needs `/drep_updates` for CIP-119 fields. It should remain the authoritative source that keeps the DB fresh for all other consumers.

```
// Concept: src/services/drep-lookup.ts
import { prisma } from '../prisma';
import { koiosPost } from '../utils/koios';
import { KoiosDrepInfo } from '../types/koios.types';

// Unified return type matching DB columns
interface DrepLookupResult {
  drepId: string;
  votingPower: bigint;
  registered: boolean | null;
  active: boolean | null;
  expiresEpoch: number | null;
  metaUrl: string | null;
  metaHash: string | null;
}

export async function getDrepInfoBatch(
  drepIds: string[]
): Promise<DrepLookupResult[]> {
  if (drepIds.length === 0) return [];

  // 1. Check DB first — DRep Inventory populates these every hour at :02
  const dbDreps = await prisma.drep.findMany({
    where: { drepId: { in: drepIds } },
    select: {
      drepId: true,
      votingPower: true,
      registered: true,
      active: true,
      expiresEpoch: true,
      metaUrl: true,
      metaHash: true,
    },
  });
  const foundIds = new Set(dbDreps.map((d) => d.drepId));

  // 2. Only fetch missing DReps from Koios (batch size 50 to stay under payload limit)
  const missingIds = drepIds.filter((id) => !foundIds.has(id));
  const fetchedDreps: DrepLookupResult[] = [];

  if (missingIds.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < missingIds.length; i += batchSize) {
      const batch = missingIds.slice(i, i + batchSize);
      const koiosResults = await koiosPost<KoiosDrepInfo[]>('/drep_info', {
        _drep_ids: batch,
      });

      if (Array.isArray(koiosResults)) {
        for (const info of koiosResults) {
          const mapped: DrepLookupResult = {
            drepId: info.drep_id,
            votingPower: BigInt(info.amount ?? '0'),
            registered: info.registered ?? null,
            active: info.active ?? null,
            expiresEpoch: info.expires_epoch_no ?? null,
            metaUrl: info.meta_url ?? null,
            metaHash: info.meta_hash ?? null,
          };
          fetchedDreps.push(mapped);
        }

        // 3. Upsert into DB so future lookups skip Koios
        //    This stores the same columns that DRep Inventory would populate,
        //    ensuring consistency regardless of which job discovers the DRep first.
        await prisma.$transaction(
          koiosResults.map((info) =>
            prisma.drep.upsert({
              where: { drepId: info.drep_id },
              create: {
                drepId: info.drep_id,
                votingPower: BigInt(info.amount ?? '0'),
                registered: info.registered ?? null,
                active: info.active ?? null,
                expiresEpoch: info.expires_epoch_no ?? null,
                metaUrl: info.meta_url ?? null,
                metaHash: info.meta_hash ?? null,
              },
              update: {
                votingPower: BigInt(info.amount ?? '0'),
                registered: info.registered ?? null,
                active: info.active ?? null,
                expiresEpoch: info.expires_epoch_no ?? null,
                metaUrl: info.meta_url ?? null,
                metaHash: info.meta_hash ?? null,
              },
            })
          )
        );
      }
    }
  }

  return [...dbDreps, ...fetchedDreps];
}
```

**Impact:** Eliminates most `/drep_info` calls from non-inventory jobs entirely. Since DRep Inventory runs at `:02` every hour, the DB will almost always have fresh data by the time other jobs need it. Only brand-new DReps (registered between inventory runs) would trigger a Koios fetch — and when they do, the fallback stores the **same core fields** (`votingPower`, `registered`, `active`, `expiresEpoch`, `metaUrl`, `metaHash`) that DRep Inventory would have stored, ensuring data consistency across all consumers.

### Phase 3: DB-First DRep Lifecycle Lookups (Certificate Activity Check)

#### Problem

`fetchInactiveDrepVotingPowerForCompletedProposal` in `proposal.service.ts` makes **one Koios API call per DRep** to check certificate activity:

```
for (const drepId of drepsWithoutVotes) {
  const updates = await koiosGet('/drep_updates?_drep_id=' + drepId);
  // check if any update falls within the 20-epoch activity window
}
```

If 300 DReps haven't voted, that's **300 sequential Koios `/drep_updates` calls**. This is one of the heaviest API loads in the entire system and often causes timeouts.

#### Existing DB Table

The **`DrepLifecycleEvent`** table already stores exactly the data we need:

| Column      | Description                                      |
|-------------|--------------------------------------------------|
| `drepId`    | DRep ID                                          |
| `action`    | `"registration"`, `"deregistration"`, `"update"` |
| `epochNo`   | Epoch of the event                               |
| `blockTime` | Unix timestamp (optional)                        |
| `txHash`    | Transaction hash (optional)                      |

It has indexes on `drepId`, `epochNo`, and `action`. The **DRep Lifecycle sync job** (`:37` hourly) populates this table from Koios `/drep_updates` for all DReps.

#### How It Works

1. Replace the per-DRep Koios loop in `fetchInactiveDrepVotingPowerForCompletedProposal` with a single DB query:
   ```
   // Instead of N individual Koios calls:
   const activeDrepIdsFromCerts = await prisma.drepLifecycleEvent.findMany({
     where: {
       drepId: { in: drepsWithoutVotes },
       epochNo: { gte: minActiveEpoch, lte: referenceEpoch },
     },
     select: { drepId: true },
     distinct: ['drepId'],
   });
   ```
   This replaces potentially hundreds of Koios calls with **one indexed DB query**.

2. For any DRep IDs **not found** in `DrepLifecycleEvent` at all (i.e., never synced), fall back to Koios `/drep_updates` only for those specific DReps. This handles edge cases where a DRep was registered between lifecycle sync runs.

3. The lifecycle sync job runs at `:37` hourly, well before Proposal Sync needs the data. For completed proposals the reference epoch is historical, so the data is already in the DB.

#### Per-Job Impact

| Before | After |
|--------|-------|
| Up to N sequential `GET /drep_updates` calls (one per DRep without votes) | 1 DB query + Koios calls only for DReps missing from `DrepLifecycleEvent` table |

#### Edge Cases

- **Brand-new DReps** (registered between lifecycle sync runs): The fallback to Koios `/drep_updates` handles these. In practice, for completed proposals the reference epoch is historical, so all lifecycle events are already synced.
- **Lifecycle sync hasn't run yet** (cold start): The function degrades gracefully to the current behavior — all DReps fall through to Koios. After the first lifecycle sync, subsequent runs benefit from the DB cache.

---

## Priority & Implementation Order

| Priority | Change                                        | Effort | Impact   |
|----------|-----------------------------------------------|--------|----------|
| **P0**   | Fix schedules (Phase 1)                       | Low    | High     |
| **P1**   | DB-first DRep lookups (Phase 2)               | Medium | High     |
| **P2**   | DB-first lifecycle lookups (Phase 3)          | Low    | High     |

---

## Immediate Action Items

- [x] Update cron schedules per Phase 1 table
- [x] Create shared `getDrepInfoBatch()` helper in `src/services/drep-lookup.ts` that reads DB first, fetches from Koios `/drep_info` only for missing DReps, and upserts all core columns (`votingPower`, `registered`, `active`, `expiresEpoch`, `metaUrl`, `metaHash`)
- [x] Replace `koiosPost('/drep_info', ...)` in DRep Inventory (`drep-sync.service.ts:221-290`) with `getDrepInfoBatch()`
- [x] Replace `koiosPost('/drep_info', ...)` in Proposal Sync's `fetchInactiveDrepVotingPowerForActiveProposal` (`proposal.service.ts:882-968`) with `getDrepInfoBatch()`, reading `.active` and `.votingPower` from the result
- [x] Leave DRep Info Sync's `/drep_info` + `/drep_updates` calls unchanged — it is the canonical full-refresh job that keeps the DB populated for all other consumers
- [ ] Replace per-DRep Koios `/drep_updates` loop in `fetchInactiveDrepVotingPowerForCompletedProposal` (`proposal.service.ts:1069-1109`) with a single `DrepLifecycleEvent` DB query, falling back to Koios only for DReps not found in the table
