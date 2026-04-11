import cron from "node-cron";
import {
  acquireJobLock,
  releaseJobLock,
  type AcquireJobLockOptions,
} from "../services/ingestion/syncLock";
import { shouldSkipForDbPressure } from "./dbPressureGuard";
import {
  acquireKoiosHeavyJobLane,
  releaseKoiosHeavyJobLane,
  shouldSkipForKoiosPressure,
} from "./koiosPressureGuard";
import { applyCronJitter } from "./jitter";

export interface IngestionCronRunResult {
  itemsProcessed?: number;
  /** When set, passed to releaseJobLock (e.g. partial DRep delegator sync). */
  lockResult?: "success" | "partial";
}

interface IngestionCronLockAdapter {
  acquire: () => Promise<boolean>;
  release: (
    status: "success" | "failed" | "partial",
    options?: { itemsProcessed?: number; errorMessage?: string }
  ) => Promise<void>;
}

interface IngestionCronOptions {
  jobName: string;
  displayName: string;
  scheduleEnvKey: string;
  defaultSchedule: string;
  skipDbPressure?: boolean;
  skipKoiosPressure?: boolean;
  useKoiosHeavyLane?: boolean;
  applyJitter?: boolean;
  lockOptions?: AcquireJobLockOptions;
  lockAdapter?: IngestionCronLockAdapter;
  /** Return false to skip before acquiring the DB lock (e.g. daily budget exhausted). */
  beforeAcquire?: () => Promise<boolean>;
  run: () => Promise<IngestionCronRunResult | void>;
}

function createDefaultLockAdapter(
  jobName: string,
  displayName: string,
  lockOptions?: AcquireJobLockOptions
): IngestionCronLockAdapter {
  return {
    acquire: () => acquireJobLock(jobName, displayName, lockOptions),
    release: async (status, options) =>
      releaseJobLock(
        jobName,
        status,
        options?.itemsProcessed,
        options?.errorMessage
      ),
  };
}

export function startIngestionCronJob(options: IngestionCronOptions): void {
  const schedule = process.env[options.scheduleEnvKey] || options.defaultSchedule;
  const enabled = process.env.ENABLE_CRON_JOBS !== "false";
  const lockAdapter =
    options.lockAdapter
    ?? createDefaultLockAdapter(
      options.jobName,
      options.displayName,
      options.lockOptions
    );
  let isRunning = false;

  if (!enabled) {
    console.log(
      `[Cron] ${options.displayName} disabled via ENABLE_CRON_JOBS env variable`
    );
    return;
  }

  if (!cron.validate(schedule)) {
    console.error(
      `[Cron] Invalid cron schedule for ${options.displayName}: ${schedule}. Using default: ${options.defaultSchedule}`
    );
  }

  const effectiveSchedule = cron.validate(schedule)
    ? schedule
    : options.defaultSchedule;

  cron.schedule(effectiveSchedule, async () => {
    if (isRunning) {
      console.log(
        `[${new Date().toISOString()}] ${options.displayName} is still running locally. Skipping this run.`
      );
      return;
    }

    isRunning = true;
    const startedAt = Date.now();
    const timestamp = new Date().toISOString();
    let lockAcquired = false;
    let laneAcquired = false;

    try {
      if (options.applyJitter !== false) {
        await applyCronJitter(`[Cron] ${options.displayName}`);
      }

      if (options.skipDbPressure && shouldSkipForDbPressure(options.jobName)) {
        return;
      }
      if (
        options.skipKoiosPressure
        && shouldSkipForKoiosPressure(options.jobName)
      ) {
        return;
      }

      if (options.beforeAcquire) {
        const proceed = await options.beforeAcquire();
        if (!proceed) {
          return;
        }
      }

      lockAcquired = await lockAdapter.acquire();
      if (!lockAcquired) {
        console.log(
          `[${timestamp}] ${options.displayName} skipped because another instance already holds the DB lock.`
        );
        return;
      }

      if (options.useKoiosHeavyLane) {
        laneAcquired = await acquireKoiosHeavyJobLane(options.jobName);
        if (!laneAcquired) {
          console.log(
            `[${timestamp}] ${options.displayName} skipped because Koios heavy lane is busy.`
          );
          await lockAdapter.release("success", { itemsProcessed: 0 });
          lockAcquired = false;
          return;
        }
      }

      console.log(`\n[${timestamp}] Starting ${options.displayName}...`);
      const result = await options.run();
      const lockOk = result?.lockResult ?? "success";
      await lockAdapter.release(lockOk, {
        itemsProcessed: result?.itemsProcessed ?? 0,
      });
      lockAcquired = false;
      if (laneAcquired) {
        await releaseKoiosHeavyJobLane("success");
        laneAcquired = false;
      }
    } catch (error: any) {
      const message = error?.message ?? String(error);
      console.error(`[${timestamp}] ${options.displayName} failed:`, message);

      if (laneAcquired) {
        try {
          await releaseKoiosHeavyJobLane("failed", message);
          laneAcquired = false;
        } catch (laneError: any) {
          console.error(
            `[${timestamp}] Failed to release Koios heavy lane lock:`,
            laneError?.message ?? laneError
          );
        }
      }
      if (lockAcquired) {
        try {
          await lockAdapter.release("failed", { errorMessage: message });
        } catch (releaseError: any) {
          console.error(
            `[${timestamp}] Failed to release ${options.displayName} lock:`,
            releaseError?.message ?? releaseError
          );
        }
      }
    } finally {
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[${new Date().toISOString()}] ${options.displayName} finished (duration=${durationSeconds}s)`
      );
      isRunning = false;
    }
  });

  console.log(
    `[Cron] ${options.displayName} scheduled with cron: ${effectiveSchedule}`
  );
}
