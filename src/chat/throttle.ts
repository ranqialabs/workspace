// Edits a live message as often as a platform tolerates. Every call replaces
// what the next edit will say; at most one edit is in flight, and at most one
// goes out per interval. `settle` drops what has not gone out and waits for
// what has, so the caller's final edit lands last.

export class Throttled<T> {
  private latest: T | undefined
  private sending: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastSent = 0

  constructor(
    private readonly send: (value: T) => Promise<void>,
    private readonly interval: number,
    private readonly now: () => number = Date.now,
  ) {}

  update(value: T): void {
    this.latest = value
    if (this.timer !== undefined) return
    const wait = Math.max(0, this.lastSent + this.interval - this.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.push()
    }, wait)
  }

  async settle(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.latest = undefined
    await this.sending
  }

  private push(): Promise<void> {
    this.sending = this.sending.then(async () => {
      const value = this.latest
      if (value === undefined) return
      this.latest = undefined
      this.lastSent = this.now()
      // A failed live edit is not worth failing the run; the next one may land.
      await this.send(value).catch((error: unknown) => console.warn("live edit failed", error))
    })
    return this.sending
  }
}
