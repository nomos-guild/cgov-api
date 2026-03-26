import { sleep } from "./shared";

export interface AcquireMetrics {
  waitMs: number;
  queued: boolean;
  activeAtAcquireStart: number;
  pendingAtAcquireStart: number;
}

export class ConcurrencyLimiter {
  private activeCount = 0;

  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly name: string,
    private readonly maxConcurrent: number | (() => number)
  ) {}

  private getMaxConcurrent(): number {
    const configured =
      typeof this.maxConcurrent === "function"
        ? this.maxConcurrent()
        : this.maxConcurrent;
    return Math.max(1, Math.floor(configured));
  }

  private async acquire(): Promise<AcquireMetrics> {
    const activeAtAcquireStart = this.activeCount;
    const pendingAtAcquireStart = this.queue.length;
    const acquireStart = Date.now();
    const queued = this.activeCount >= this.getMaxConcurrent();

    if (queued) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.activeCount += 1;
    return {
      waitMs: Date.now() - acquireStart,
      queued,
      activeAtAcquireStart,
      pendingAtAcquireStart,
    };
  }

  private release(): void {
    this.activeCount -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  async runWithAcquireMetrics<T>(
    operation: () => Promise<T>
  ): Promise<{ value: T; acquire: AcquireMetrics }> {
    const acquire = await this.acquire();
    try {
      const value = await operation();
      return { value, acquire };
    } finally {
      this.release();
    }
  }

  getStats(): { name: string; active: number; pending: number; max: number } {
    return {
      name: this.name,
      active: this.activeCount,
      pending: this.queue.length,
      max: this.getMaxConcurrent(),
    };
  }
}

export class BurstLimiter {
  private readonly timestamps: number[] = [];

  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  private trim(now: number): void {
    while (
      this.timestamps.length > 0
      && now - this.timestamps[0] >= this.windowMs
    ) {
      this.timestamps.shift();
    }
  }

  async acquire(): Promise<number> {
    let waitedMs = 0;

    const reservation = this.chain.then(async () => {
      while (true) {
        const now = Date.now();
        this.trim(now);

        if (this.timestamps.length < this.maxRequests) {
          this.timestamps.push(Date.now());
          return;
        }

        const oldest = this.timestamps[0];
        const toWait = Math.max(1, this.windowMs - (now - oldest));
        waitedMs += toWait;
        await sleep(toWait);
      }
    });

    this.chain = reservation.catch(() => undefined);
    await reservation;
    return waitedMs;
  }
}
