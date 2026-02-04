---
name: add-cron-job
version: 1.0.0
created: 2026-02-04
last-evolved: 2026-02-04
evolution-count: 0
feedback-count: 0
description: Scaffold a new cron job with in-process guard, env-configurable schedule, SyncStatus DB locking, and job registry wiring.
argument-hint: [jobName] [schedule] [description]
allowed-tools: Read, Edit, Write, Glob
---

# Add Cron Job

Scaffold a new cron job following the project's established patterns: in-process guard, configurable schedule, optional SyncStatus distributed locking, and registration in the job registry.

## Arguments

- `$0` - Job name in kebab-case (e.g., `cleanup-stale-votes`, `sync-delegations`)
- `$1` - Default cron schedule (e.g., `0 */12 * * *` for every 12 hours, `*/30 * * * *` for every 30 min)
- `$2` - Short description (e.g., "Remove stale vote records older than 30 days")

## Instructions

### Step 1: Create the job file

Create `src/jobs/{$0}.job.ts`:

```typescript
/**
 * {$2}
 * Schedule: {$1} (configurable via {ENV_VAR_NAME} env variable)
 */

import cron from "node-cron";
import { prisma } from "../services";

// In-process guard to prevent overlapping runs in a single Node process
let isRunning = false;

/**
 * Starts the {display name} cron job
 */
export const start{PascalCaseName}Job = () => {
  const schedule = process.env.{ENV_VAR_NAME} || "{$1}";
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";

  if (!enabled) {
    console.log("[Cron] {Display name} job disabled via ENABLE_CRON_JOBS env variable");
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(`[Cron] Invalid cron schedule for {$0}: ${schedule}`);
    return;
  }

  cron.schedule(schedule, async () => {
    if (isRunning) {
      console.log(`[${new Date().toISOString()}] {Display name} job still running, skipping`);
      return;
    }

    isRunning = true;
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Starting {display name} job...`);

    try {
      // TODO: Implement job logic here
      // const result = await myServiceFunction(prisma);

      console.log(`[${timestamp}] {Display name} job completed successfully`);
    } catch (error: any) {
      console.error(`[${timestamp}] {Display name} job failed:`, error.message);
    } finally {
      isRunning = false;
    }
  });

  console.log(`[Cron] {Display name} job scheduled: ${schedule}`);
};
```

**Naming conventions:**
- File: `{$0}.job.ts` (kebab-case)
- Export: `start{PascalCase}Job` (e.g., `startCleanupStaleVotesJob`)
- Env var: `{SCREAMING_SNAKE}_SCHEDULE` (e.g., `CLEANUP_STALE_VOTES_SCHEDULE`)

### Step 2: Register in job index

Add to `src/jobs/index.ts`:

```typescript
import { start{PascalCaseName}Job } from "./{$0}.job";

export const startAllJobs = () => {
  console.log("[Cron] Initializing all cron jobs...");

  startProposalSyncJob();
  startVoterPowerSyncJob();
  start{PascalCaseName}Job();  // ← Add here

  console.log("[Cron] All cron jobs initialized");
};
```

### Step 3: (Optional) Add SyncStatus distributed locking

For jobs running in GCP Cloud Run (multiple instances), add DB-level locking via the `SyncStatus` model to prevent concurrent execution:

```typescript
import cron from "node-cron";
import { prisma } from "../services";
import { randomUUID } from "crypto";

let isRunning = false;

const JOB_NAME = "{$0}";
const LOCK_TIMEOUT_MINUTES = 30; // Auto-unlock after 30 min (crash recovery)

/**
 * Attempt to acquire distributed lock
 */
async function acquireLock(instanceId: string): Promise<boolean> {
  try {
    // Upsert the SyncStatus record, only lock if not already running
    const result = await prisma.syncStatus.upsert({
      where: { jobName: JOB_NAME },
      create: {
        jobName: JOB_NAME,
        displayName: "{Display Name}",
        isRunning: true,
        startedAt: new Date(),
        lockedBy: instanceId,
        expiresAt: new Date(Date.now() + LOCK_TIMEOUT_MINUTES * 60 * 1000),
      },
      update: {
        isRunning: true,
        startedAt: new Date(),
        lockedBy: instanceId,
        expiresAt: new Date(Date.now() + LOCK_TIMEOUT_MINUTES * 60 * 1000),
      },
    });

    // Check if we actually got the lock (another instance might have it)
    return result.lockedBy === instanceId;
  } catch {
    return false;
  }
}

/**
 * Release distributed lock and record result
 */
async function releaseLock(
  result: "success" | "failed",
  itemsProcessed?: number,
  errorMessage?: string
) {
  await prisma.syncStatus.update({
    where: { jobName: JOB_NAME },
    data: {
      isRunning: false,
      completedAt: new Date(),
      lastResult: result,
      itemsProcessed,
      errorMessage,
      lockedBy: null,
      expiresAt: null,
    },
  });
}

export const start{PascalCaseName}Job = () => {
  const schedule = process.env.{ENV_VAR_NAME} || "{$1}";
  if (process.env.ENABLE_CRON_JOBS === "false") return;

  cron.schedule(schedule, async () => {
    if (isRunning) return;
    isRunning = true;

    const instanceId = randomUUID();

    try {
      const locked = await acquireLock(instanceId);
      if (!locked) {
        console.log(`[${JOB_NAME}] Another instance holds the lock, skipping`);
        return;
      }

      // TODO: Implement job logic
      // const result = await myServiceFunction(prisma);

      await releaseLock("success", 0);
    } catch (error: any) {
      console.error(`[${JOB_NAME}] Failed:`, error.message);
      await releaseLock("failed", undefined, error.message).catch(() => {});
    } finally {
      isRunning = false;
    }
  });

  console.log(`[Cron] ${JOB_NAME} scheduled: ${schedule}`);
};
```

### Step 4: (Optional) Add manual trigger endpoint

If the job should be triggerable via API, create a controller:

Create `src/controllers/data/trigger{PascalCase}.ts`:

```typescript
import { Request, Response } from "express";

/**
 * POST /data/trigger-{$0}
 * Manually trigger the {display name} job
 */
export const postTrigger{PascalCase} = async (_req: Request, res: Response) => {
  try {
    // TODO: Call the service function directly
    // const result = await myServiceFunction(prisma);

    res.json({ success: true, message: "{Display name} completed" });
  } catch (error: any) {
    console.error("Manual {$0} trigger failed:", error.message);
    res.status(500).json({
      error: "Trigger failed",
      message: error.message,
    });
  }
};
```

Then add to `src/routes/data.route.ts`:

```typescript
import { postTrigger{PascalCase} } from "../controllers/data/trigger{PascalCase}";

router.post("/trigger-{$0}", postTrigger{PascalCase});
```

## Common Cron Schedules

| Schedule | Expression | Use Case |
|----------|-----------|----------|
| Every 5 minutes | `*/5 * * * *` | High-frequency data sync |
| Every 30 minutes | `*/30 * * * *` | Medium-frequency updates |
| Every hour | `0 * * * *` | Hourly aggregation |
| Every 6 hours | `0 */6 * * *` | Low-frequency sync |
| Every 12 hours | `0 */12 * * *` | Twice daily |
| Daily at midnight | `0 0 * * *` | Daily cleanup/reports |
| Offset from other jobs | `30 */6 * * *` | Avoid overlapping with other jobs (minute 30) |

## Checklist

- [ ] Job file created at `src/jobs/{$0}.job.ts`
- [ ] In-process guard (`isRunning` boolean) prevents overlapping runs
- [ ] Schedule configurable via environment variable
- [ ] Respects `ENABLE_CRON_JOBS=false` to disable
- [ ] Validates cron schedule with `cron.validate()`
- [ ] Registered in `src/jobs/index.ts` via `startAllJobs()`
- [ ] Timestamped logging for start/complete/error
- [ ] `finally` block always resets `isRunning = false`
- [ ] (If multi-instance) SyncStatus DB locking added
- [ ] (If needed) Manual trigger endpoint added to `/data/` routes
