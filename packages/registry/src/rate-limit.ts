// A small in-memory sliding-window rate limiter, keyed by whatever the caller chooses.

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

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
    this.hits.set(key, recent);
    return true;
  }
}
