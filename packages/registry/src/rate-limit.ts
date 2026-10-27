// A small in-memory sliding-window rate limiter, keyed by whatever the caller chooses. Its memory is
// bounded: keys with no hits inside the window are dropped, and past maxKeys the oldest go, so a
// caller rotating through addresses can't grow it without limit.

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  private sweep(t: number): void {
    for (const [key, at] of this.hits) if (!at.length || t - at[at.length - 1]! >= this.windowMs) this.hits.delete(key);
    // Still full: forget the least recently seen (Map order is insertion order; allow() re-inserts).
    for (const key of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(key);
    }
  }

  /** True if a call would be allowed now, without counting it. */
  wouldAllow(key: string): boolean {
    const t = this.now();
    return (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs).length < this.max;
  }

  /** True if the call is allowed (and counts it). */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size >= this.maxKeys) this.sweep(t);
    return true;
  }
}
