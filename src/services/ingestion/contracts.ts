export type IngestionOutcome = "success" | "partial" | "failed" | "skipped";

export interface IngestionExecutionContext {
  trigger: "cron" | "manual" | "sync-on-read";
  stream: string;
  unit: string;
  startedAtMs: number;
}

export interface IngestionFailure {
  stage: string;
  message: string;
  retryable?: boolean;
}

export interface IngestionResult<TSummary = Record<string, unknown>> {
  outcome: IngestionOutcome;
  summary: TSummary;
  itemsProcessed?: number;
  failures?: IngestionFailure[];
  skipReason?: string;
}

export interface IngestionUnit<TSummary = Record<string, unknown>> {
  stream: string;
  unit: string;
  run: (
    context: IngestionExecutionContext
  ) => Promise<IngestionResult<TSummary>>;
}
