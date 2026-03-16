const DEFAULT_CRON_JITTER_MAX_MS = 15000;

function getCronJitterMaxMs(): number {
  const rawValue = process.env.CRON_JITTER_MAX_MS;
  if (!rawValue) return DEFAULT_CRON_JITTER_MAX_MS;

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 300000) {
    return DEFAULT_CRON_JITTER_MAX_MS;
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function applyCronJitter(jobLabel: string): Promise<void> {
  const maxMs = getCronJitterMaxMs();
  if (maxMs <= 0) return;

  const jitterMs = Math.floor(Math.random() * (maxMs + 1));
  if (jitterMs <= 0) return;

  const timestamp = new Date().toISOString();
  console.log(
    `[${timestamp}] ${jobLabel}: applying startup jitter of ${jitterMs}ms (max=${maxMs}ms)`
  );
  await sleep(jitterMs);
}
