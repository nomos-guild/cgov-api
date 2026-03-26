export interface IntegrityEvent {
  stream: string;
  unit: string;
  outcome: "success" | "partial" | "failed" | "skipped";
  lagSeconds?: number;
  partialFailures?: number;
  retries?: number;
  staleCheckpointAgeSeconds?: number;
}

interface IntegrityCounters {
  success: number;
  partial: number;
  failed: number;
  skipped: number;
  lastEventAt: string | null;
}

const MAX_RECENT_EVENTS = 200;
const recentEvents: Array<IntegrityEvent & { at: string }> = [];
const countersByUnit = new Map<string, IntegrityCounters>();

function getCounterKey(stream: string, unit: string): string {
  return `${stream}:${unit}`;
}

export function logIntegrityEvent(event: IntegrityEvent): void {
  const at = new Date().toISOString();
  const key = getCounterKey(event.stream, event.unit);
  const counters = countersByUnit.get(key) ?? {
    success: 0,
    partial: 0,
    failed: 0,
    skipped: 0,
    lastEventAt: null,
  };
  counters[event.outcome] += 1;
  counters.lastEventAt = at;
  countersByUnit.set(key, counters);

  recentEvents.push({ ...event, at });
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.shift();
  }

  console.log(
    `[Integrity] stream=${event.stream} unit=${event.unit} outcome=${event.outcome} lagSeconds=${event.lagSeconds ?? "n/a"} partialFailures=${event.partialFailures ?? 0} retries=${event.retries ?? 0} staleCheckpointAgeSeconds=${event.staleCheckpointAgeSeconds ?? "n/a"}`
  );
}

export function getIntegrityMetricsSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      units: countersByUnit.size,
      recentEvents: recentEvents.length,
    },
    byUnit: [...countersByUnit.entries()].map(([key, counters]) => {
      const [stream, unit] = key.split(":");
      return { stream, unit, ...counters };
    }),
    recentEvents: [...recentEvents].reverse(),
  };
}
