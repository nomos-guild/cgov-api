import type {
  IngestionExecutionContext,
  IngestionFailure,
  IngestionResult,
} from "./contracts";
import { logIntegrityEvent } from "./integrityMetrics";

function serializeFailures(failures?: IngestionFailure[]): string {
  if (!failures || failures.length === 0) {
    return "none";
  }
  return failures
    .map((failure) => `${failure.stage}:${failure.message}`)
    .join(" | ");
}

export async function runIngestionUnit<TSummary>(
  context: Omit<IngestionExecutionContext, "startedAtMs">,
  run: (ctx: IngestionExecutionContext) => Promise<IngestionResult<TSummary>>
): Promise<IngestionResult<TSummary>> {
  const startedAtMs = Date.now();
  const runContext: IngestionExecutionContext = { ...context, startedAtMs };
  console.log(
    `[Ingestion] action=started trigger=${runContext.trigger} stream=${runContext.stream} unit=${runContext.unit}`
  );

  const result = await run(runContext);
  const durationMs = Date.now() - startedAtMs;
  const logLevel = result.outcome === "failed" ? "warn" : "log";
  console[logLevel](
    `[Ingestion] action=completed trigger=${runContext.trigger} stream=${runContext.stream} unit=${runContext.unit} outcome=${result.outcome} itemsProcessed=${result.itemsProcessed ?? 0} durationMs=${durationMs} skipReason=${result.skipReason ?? "none"} failures=${serializeFailures(result.failures)}`
  );
  logIntegrityEvent({
    stream: runContext.stream,
    unit: runContext.unit,
    outcome: result.outcome,
    lagSeconds: Math.floor(durationMs / 1000),
    partialFailures: result.failures?.length ?? 0,
  });

  return result;
}

export function successResult<TSummary>(
  summary: TSummary,
  itemsProcessed?: number
): IngestionResult<TSummary> {
  return {
    outcome: "success",
    summary,
    itemsProcessed,
  };
}

export function partialResult<TSummary>(
  summary: TSummary,
  failures: IngestionFailure[],
  itemsProcessed?: number
): IngestionResult<TSummary> {
  return {
    outcome: "partial",
    summary,
    failures,
    itemsProcessed,
  };
}
