import type { ScheduleClock } from "../../src/schedule-service.ts";

/** A clock the test moves: timers fire in order as time advances, and `jump` skips time like a suspended laptop. */
export class FakeClock implements ScheduleClock {
  time: number;
  private timers: { id: number; at: number; run: () => void }[] = [];
  private seq = 0;
  constructor(start: string) { this.time = Date.parse(start); }
  now() { return this.time; }
  setTimer(run: () => void, ms: number) { const id = ++this.seq; this.timers.push({ id, at: this.time + ms, run }); return id; }
  clearTimer(handle: unknown) { this.timers = this.timers.filter((t) => t.id !== handle); }
  get pending() { return this.timers.length; }
  get nextIn() { return this.timers.length === 0 ? undefined : Math.min(...this.timers.map((t) => t.at)) - this.time; }
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.run();
    }
    this.time = target;
  }
  jump(ms: number) { this.time += ms; }
}
