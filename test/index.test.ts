import { describe, expect, it } from "vitest";
import {
  type CronSchedule,
  CronSchedulerError,
  type CronSchedulerErrorCode,
  InMemoryLock,
  type LockPort,
  nextRun,
  parseCron,
  Scheduler,
  type SchedulerEvent,
} from "../src/index.js";

function expectErrorCode(fn: () => unknown, code: CronSchedulerErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CronSchedulerError);
  expect((caught as CronSchedulerError).code).toBe(code);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const noopHandler = async (): Promise<void> => {
  await Promise.resolve();
};

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("parseCron", () => {
  it("parses basic expressions", () => {
    const s = parseCron("30 2 * * *");
    expect(s.minute).toEqual([30]);
    expect(s.hour).toEqual([2]);
    expect(s.dayOfMonth).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(s.month).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(s.dayOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("parses names case-insensitively", () => {
    const s = parseCron("0 9 1 jan mon");
    expect(s.month).toEqual([1]);
    expect(s.dayOfWeek).toEqual([1]);
  });

  it("normalizes day-of-week 7 to 0", () => {
    expect(parseCron("* * * * 7").dayOfWeek).toEqual([0]);
    expect(parseCron("* * * * 5-7").dayOfWeek).toEqual([0, 5, 6]);
  });

  it("parses steps, ranges and lists", () => {
    expect(parseCron("*/15 * * * *").minute).toEqual([0, 15, 30, 45]);
    expect(parseCron("0 0 1-5/2 * *").dayOfMonth).toEqual([1, 3, 5]);
    expect(parseCron("0,30 9-10 * * *").hour).toEqual([9, 10]);
  });

  it("throws invalid_cron for bad expressions", () => {
    expectErrorCode(() => parseCron("61 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("* * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("* * * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("*".repeat(201)), "invalid_cron");
    expectErrorCode(() => parseCron("@reboot"), "invalid_cron");
    expectErrorCode(() => parseCron("*/0 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("5-1 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("1,,2 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("0 0 * * FUNDAY"), "invalid_cron");
    expectErrorCode(() => parseCron("0 0 * * 0/"), "invalid_cron");
    expectErrorCode(() => parseCron("1/2/3 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("1-2-3 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("-5 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("0x10 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("1e1 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("+5 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron("5/15 * * * *"), "invalid_cron");
    expectErrorCode(() => parseCron(123 as never), "invalid_cron");
  });
});

describe("nextRun", () => {
  it("acceptance: DST gap in Madrid skips the nonexistent local time", () => {
    const schedule = parseCron("30 2 * * *");
    const after = new Date("2026-03-28T12:00:00Z");
    expect(nextRun(schedule, after, "Europe/Madrid")).toEqual(new Date("2026-03-30T00:30:00.000Z"));
  });

  it("acceptance: DST overlap uses the earlier instant so the day runs once", () => {
    const schedule = parseCron("30 2 * * *");
    const first = nextRun(schedule, new Date("2026-10-24T12:00:00Z"), "Europe/Madrid");
    expect(first).toEqual(new Date("2026-10-25T00:30:00.000Z"));
    expect(nextRun(schedule, first, "Europe/Madrid")).toEqual(new Date("2026-10-26T01:30:00.000Z"));
  });

  it("acceptance: Vixie OR rule when day-of-month and day-of-week are restricted", () => {
    const schedule = parseCron("0 9 1 * MON");
    const after = new Date("2026-11-10T00:00:00Z");
    expect(nextRun(schedule, after, "UTC")).toEqual(new Date("2026-11-16T09:00:00.000Z"));
  });

  it("treats day-of-week 7 as Sunday", () => {
    const schedule = parseCron("0 12 * * 7");
    expect(nextRun(schedule, new Date("2026-11-09T10:00:00Z"), "UTC")).toEqual(
      new Date("2026-11-15T12:00:00Z"),
    );
  });

  it("skips the DST gap for */15 in America/New_York", () => {
    const schedule = parseCron("*/15 * * * *");
    const after = new Date("2026-03-08T06:59:00Z"); // 01:59 EST; 02:00-02:59 do not exist
    expect(nextRun(schedule, after, "America/New_York")).toEqual(
      new Date("2026-03-08T07:00:00.000Z"),
    );
  });

  it("matches a restricted day of month with a wildcard day of week", () => {
    const schedule = parseCron("0 0 15 * *");
    expect(nextRun(schedule, new Date("2026-11-16T00:00:00Z"), "UTC")).toEqual(
      new Date("2026-12-15T00:00:00Z"),
    );
  });

  it("rolls over minute, hour, day, month and year boundaries", () => {
    const schedule = parseCron("* * * * *");
    expect(nextRun(schedule, new Date("2026-12-31T23:59:30Z"), "UTC")).toEqual(
      new Date("2027-01-01T00:00:00.000Z"),
    );
  });

  it("treats a schedule built by hand as unrestricted days", () => {
    const handmade: CronSchedule = {
      minute: [0],
      hour: [0],
      dayOfMonth: [15],
      month: [6],
      dayOfWeek: [0],
    };
    expect(nextRun(handmade, new Date("2026-06-01T00:00:00Z"), "UTC")).toEqual(
      new Date("2026-06-02T00:00:00.000Z"),
    );
  });

  it("finds a leap-day occurrence that is more than two years away", () => {
    const schedule = parseCron("0 0 29 2 *");
    expect(nextRun(schedule, new Date("2026-01-01T00:00:00Z"), "UTC")).toEqual(
      new Date("2028-02-29T00:00:00.000Z"),
    );
  });

  it("throws no_next_run for impossible dates", () => {
    expectErrorCode(
      () => nextRun(parseCron("0 0 30 2 *"), new Date("2026-01-01T00:00:00Z"), "UTC"),
      "no_next_run",
    );
  });

  it("throws invalid_time_zone and invalid_options", () => {
    expectErrorCode(
      () => nextRun(parseCron("0 0 * * *"), new Date("2026-01-01T00:00:00Z"), "Mars/Base"),
      "invalid_time_zone",
    );
    expectErrorCode(
      () => nextRun(parseCron("0 0 * * *"), new Date("nope"), "UTC"),
      "invalid_options",
    );
  });
});

describe("InMemoryLock", () => {
  it("acquires, refuses an existing key and purges expired keys first", async () => {
    let now = 1000;
    const lock = new InMemoryLock({ now: () => now, maxKeys: 10 });
    await expect(lock.acquire("a", "owner", 1000)).resolves.toBe(true);
    await expect(lock.acquire("a", "other", 1000)).resolves.toBe(false);
    now += 1001;
    await expect(lock.acquire("a", "other", 1000)).resolves.toBe(true);
  });

  it("throws lock_full when the store is full", async () => {
    const lock = new InMemoryLock({ now: () => 0, maxKeys: 1 });
    await lock.acquire("a", "o", 100);
    const error = await lock.acquire("b", "o", 100).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CronSchedulerError);
    expect((error as CronSchedulerError).code).toBe("lock_full");
  });
});

describe("Scheduler", () => {
  it("acceptance: two instances with a shared lock run an occurrence once", async () => {
    const nowMs = Date.parse("2026-11-09T10:00:00Z");
    const lock = new InMemoryLock({ now: () => nowMs, maxKeys: 100 });
    const events: SchedulerEvent[] = [];
    let runs = 0;
    const handler = async (): Promise<void> => {
      runs++;
    };

    const a = new Scheduler({
      lock,
      owner: "a",
      now: () => nowMs,
      onEvent: (event) => events.push(event),
    });
    const b = new Scheduler({
      lock,
      owner: "b",
      now: () => nowMs,
      onEvent: (event) => events.push(event),
    });
    a.schedule("job", "* * * * *", { timeZone: "UTC", handler });
    b.schedule("job", "* * * * *", { timeZone: "UTC", handler });

    await Promise.all([a.tick(), b.tick()]);
    await flushMicrotasks();

    expect(runs).toBe(1);
    const notAcquired = events.filter((event) => event.type === "lock_not_acquired");
    expect(notAcquired).toHaveLength(1);
    expect(notAcquired[0]?.job).toBe("job");
    expect(notAcquired[0]?.scheduledAt).toEqual(new Date("2026-11-09T10:00:00.000Z"));

    await Promise.all([a.stop(), b.stop()]);
  });

  it("emits failed and does not run when the lock rejects", async () => {
    const nowMs = Date.parse("2026-11-09T10:00:00Z");
    const lock: LockPort = {
      acquire: async () => {
        throw new Error("lock down");
      },
    };
    const events: SchedulerEvent[] = [];
    let runs = 0;
    const scheduler = new Scheduler({
      lock,
      owner: "o",
      now: () => nowMs,
      onEvent: (event) => events.push(event),
    });
    scheduler.schedule("job", "* * * * *", {
      timeZone: "UTC",
      handler: async () => {
        runs++;
      },
    });

    await scheduler.tick();
    await flushMicrotasks();

    expect(runs).toBe(0);
    const failed = events.filter((event) => event.type === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.scheduledAt).toEqual(new Date("2026-11-09T10:00:00.000Z"));
    await scheduler.stop();
  });

  it("overlap 'skip' does not start a second run and emits skipped_overlap", async () => {
    let nowMs = Date.parse("2026-11-09T10:00:00Z");
    const lock = new InMemoryLock({ now: () => nowMs });
    const events: SchedulerEvent[] = [];
    let runs = 0;
    const gate = deferred();
    const scheduler = new Scheduler({
      lock,
      owner: "o",
      now: () => nowMs,
      onEvent: (event) => events.push(event),
    });
    scheduler.schedule("job", "* * * * *", {
      timeZone: "UTC",
      overlap: "skip",
      handler: async () => {
        runs++;
        await gate.promise;
      },
    });

    await scheduler.tick();
    expect(runs).toBe(1);

    nowMs = Date.parse("2026-11-09T10:01:00Z");
    await scheduler.tick();
    expect(runs).toBe(1);

    const skipped = events.filter((event) => event.type === "skipped_overlap");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.scheduledAt).toEqual(new Date("2026-11-09T10:01:00.000Z"));

    gate.resolve();
    await scheduler.stop();
    await flushMicrotasks();
    expect(events.some((event) => event.type === "succeeded")).toBe(true);
  });

  it("overlap 'allow' starts a second run", async () => {
    let nowMs = Date.parse("2026-11-09T10:00:00Z");
    const lock = new InMemoryLock({ now: () => nowMs });
    let runs = 0;
    const gates: Array<() => void> = [];
    const scheduler = new Scheduler({ lock, owner: "o", now: () => nowMs });
    scheduler.schedule("job", "* * * * *", {
      timeZone: "UTC",
      overlap: "allow",
      handler: async () => {
        runs++;
        const gate = deferred();
        gates.push(gate.resolve);
        await gate.promise;
      },
    });

    await scheduler.tick();
    expect(runs).toBe(1);

    nowMs = Date.parse("2026-11-09T10:01:00Z");
    await scheduler.tick();
    expect(runs).toBe(2);

    for (const release of gates) {
      release();
    }
    await scheduler.stop();
  });

  it("acceptance: catchUp 'skip' and 'run-once' after a pause", async () => {
    let nowMs = Date.parse("2026-11-09T10:00:00Z");
    const events: SchedulerEvent[] = [];
    const skipRuns: Date[] = [];
    const skipScheduler = new Scheduler({
      lock: new InMemoryLock({ now: () => nowMs }),
      owner: "skip",
      now: () => nowMs,
      onEvent: (event) => events.push(event),
    });
    skipScheduler.schedule("job", "*/5 * * * *", {
      timeZone: "UTC",
      catchUp: "skip",
      graceMs: 60_000,
      handler: async ({ scheduledAt }) => {
        skipRuns.push(scheduledAt);
      },
    });

    nowMs = Date.parse("2026-11-09T10:10:00Z");
    await skipScheduler.tick();
    await flushMicrotasks();
    expect(skipRuns).toHaveLength(0);
    expect(events.some((event) => event.type === "missed")).toBe(true);

    // The next occurrence is the first one after now (10:15), not the missed 10:00.
    nowMs = Date.parse("2026-11-09T10:15:00Z");
    await skipScheduler.tick();
    await flushMicrotasks();
    expect(skipRuns).toEqual([new Date("2026-11-09T10:15:00.000Z")]);
    await skipScheduler.stop();

    nowMs = Date.parse("2026-11-09T10:00:00Z");
    const onceRuns: Date[] = [];
    const onceScheduler = new Scheduler({
      lock: new InMemoryLock({ now: () => nowMs }),
      owner: "once",
      now: () => nowMs,
    });
    onceScheduler.schedule("job", "*/5 * * * *", {
      timeZone: "UTC",
      catchUp: "run-once",
      graceMs: 60_000,
      handler: async ({ scheduledAt }) => {
        onceRuns.push(scheduledAt);
      },
    });

    // 10:00 and 10:05 are missed; only the latest (10:05) runs once. 10:10 is
    // not due yet at 10:09:30, so the catch-up run is the only run.
    nowMs = Date.parse("2026-11-09T10:09:30Z");
    await onceScheduler.tick();
    await flushMicrotasks();
    expect(onceRuns).toEqual([new Date("2026-11-09T10:05:00.000Z")]);

    // 10:10 and 10:15 are missed; only the latest (10:15) runs once.
    nowMs = Date.parse("2026-11-09T10:16:30Z");
    await onceScheduler.tick();
    await flushMicrotasks();
    expect(onceRuns).toEqual([
      new Date("2026-11-09T10:05:00.000Z"),
      new Date("2026-11-09T10:15:00.000Z"),
    ]);
    await onceScheduler.stop();
  });

  it("catchUp 'run-once' still runs due occurrences that are within the grace period", async () => {
    let nowMs = Date.parse("2026-11-09T10:00:00Z");
    const runs: Date[] = [];
    const scheduler = new Scheduler({
      lock: new InMemoryLock({ now: () => nowMs }),
      owner: "o",
      now: () => nowMs,
    });
    scheduler.schedule("job", "* * * * *", {
      timeZone: "UTC",
      catchUp: "run-once",
      graceMs: 60_000,
      handler: async ({ scheduledAt }) => {
        runs.push(scheduledAt);
      },
    });

    nowMs = Date.parse("2026-11-09T10:01:30Z");
    await scheduler.tick();
    await flushMicrotasks();

    // 10:00 is missed and runs once as the catch-up; 10:01 is only 30 s old
    // and must still run through the normal path.
    expect(runs).toEqual([
      new Date("2026-11-09T10:00:00.000Z"),
      new Date("2026-11-09T10:01:00.000Z"),
    ]);
    await scheduler.stop();
  });

  it("emits started then succeeded for each run", async () => {
    const nowMs = Date.parse("2026-11-09T10:00:00Z");
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      lock: new InMemoryLock({ now: () => nowMs }),
      owner: "o",
      now: () => nowMs,
      onEvent: (event) => events.push(event),
    });
    scheduler.schedule("report", "* * * * *", { timeZone: "UTC", handler: noopHandler });

    await scheduler.tick();
    await flushMicrotasks();

    expect(events).toEqual([
      {
        type: "started",
        job: "report",
        scheduledAt: new Date("2026-11-09T10:00:00.000Z"),
      },
      {
        type: "succeeded",
        job: "report",
        scheduledAt: new Date("2026-11-09T10:00:00.000Z"),
      },
    ]);
    await scheduler.stop();
  });

  it("acceptance: a rejecting handler emits failed without its message and later runs work", async () => {
    let nowMs = Date.parse("2026-11-09T10:00:00Z");
    const lock = new InMemoryLock({ now: () => nowMs });
    const events: SchedulerEvent[] = [];
    let attempts = 0;
    const scheduler = new Scheduler({
      lock,
      owner: "o",
      now: () => nowMs,
      onEvent: (event) => events.push(event),
    });
    scheduler.schedule("report", "* * * * *", {
      timeZone: "UTC",
      handler: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("boom");
        }
      },
    });

    await scheduler.tick();
    await flushMicrotasks();

    const failed = events.filter((event) => event.type === "failed" && event.job === "report");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.scheduledAt).toEqual(new Date("2026-11-09T10:00:00.000Z"));
    expect(JSON.stringify(failed[0])).not.toContain("boom");

    nowMs = Date.parse("2026-11-09T10:01:00Z");
    await scheduler.tick();
    await flushMicrotasks();
    expect(attempts).toBe(2);
    await scheduler.stop();
  });

  it("throws duplicate_job and too_many_jobs", () => {
    const nowMs = Date.parse("2026-11-09T10:00:00Z");
    const handler = noopHandler;
    const scheduler = new Scheduler({
      lock: new InMemoryLock({ now: () => nowMs }),
      owner: "o",
      now: () => nowMs,
      maxJobs: 2,
    });
    scheduler.schedule("a", "* * * * *", { timeZone: "UTC", handler });
    expectErrorCode(
      () => scheduler.schedule("a", "* * * * *", { timeZone: "UTC", handler }),
      "duplicate_job",
    );
    scheduler.schedule("b", "* * * * *", { timeZone: "UTC", handler });
    expectErrorCode(
      () => scheduler.schedule("c", "* * * * *", { timeZone: "UTC", handler }),
      "too_many_jobs",
    );
  });

  it("throws invalid_time_zone, invalid_options and no_next_run when scheduling", () => {
    const nowMs = Date.parse("2026-11-09T10:00:00Z");
    const handler = noopHandler;
    const scheduler = new Scheduler({
      lock: new InMemoryLock({ now: () => nowMs }),
      owner: "o",
      now: () => nowMs,
    });
    expectErrorCode(
      () => scheduler.schedule("tz", "* * * * *", { timeZone: "Mars/Base", handler }),
      "invalid_time_zone",
    );
    expectErrorCode(
      () =>
        scheduler.schedule("overlap", "* * * * *", {
          timeZone: "UTC",
          handler,
          overlap: "sometimes" as never,
        }),
      "invalid_options",
    );
    expectErrorCode(
      () =>
        scheduler.schedule("catchup", "* * * * *", {
          timeZone: "UTC",
          handler,
          catchUp: "always" as never,
        }),
      "invalid_options",
    );
    expectErrorCode(
      () => scheduler.schedule("ttl", "* * * * *", { timeZone: "UTC", handler, lockTtlMs: 0 }),
      "invalid_options",
    );
    expectErrorCode(
      () => scheduler.schedule("grace", "* * * * *", { timeZone: "UTC", handler, graceMs: -1 }),
      "invalid_options",
    );
    expectErrorCode(
      () => scheduler.schedule("never", "0 0 30 2 *", { timeZone: "UTC", handler }),
      "no_next_run",
    );
  });

  it("unschedule aborts a running handler and reports whether the job existed", async () => {
    const nowMs = Date.parse("2026-11-09T10:00:00Z");
    const lock = new InMemoryLock({ now: () => nowMs });
    let aborted = false;
    const scheduler = new Scheduler({ lock, owner: "o", now: () => nowMs });
    scheduler.schedule("job", "* * * * *", {
      timeZone: "UTC",
      handler: ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
    });

    await scheduler.tick();
    expect(scheduler.unschedule("job")).toBe(true);
    expect(aborted).toBe(true);
    expect(scheduler.unschedule("job")).toBe(false);
    await scheduler.stop();
  });

  it("stop aborts running handlers and waits for them to settle", async () => {
    const nowMs = Date.parse("2026-11-09T10:00:00Z");
    const lock = new InMemoryLock({ now: () => nowMs });
    let aborted = false;
    const scheduler = new Scheduler({ lock, owner: "o", now: () => nowMs });
    scheduler.schedule("job", "* * * * *", {
      timeZone: "UTC",
      handler: ({ signal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
    });

    await scheduler.tick();
    await scheduler.stop();
    expect(aborted).toBe(true);
  });

  it("start arms one timer for the earliest occurrence and re-arms after it fires", async () => {
    const nowMs = Date.parse("2026-11-09T10:00:30Z");
    const delays: number[] = [];
    const cleared: unknown[] = [];
    let fire: () => void = () => undefined;
    const timers = {
      setTimeout: (fn: () => void, ms: number): unknown => {
        delays.push(ms);
        fire = fn;
        return delays.length;
      },
      clearTimeout: (handle: unknown): void => {
        cleared.push(handle);
      },
    };
    const scheduler = new Scheduler({
      lock: new InMemoryLock({ now: () => nowMs }),
      owner: "o",
      now: () => nowMs,
      timers,
    });
    scheduler.schedule("hourly", "0 * * * *", { timeZone: "UTC", handler: noopHandler });

    scheduler.start();
    scheduler.start();
    expect(delays).toEqual([Date.parse("2026-11-09T11:00:00Z") - nowMs]);

    fire();
    await flushMicrotasks();
    expect(delays).toHaveLength(2);

    await scheduler.stop();
    expect(cleared.length).toBeGreaterThan(0);
    await flushMicrotasks();
  });

  it("arms a zero delay when the pending occurrence is already due", async () => {
    let nowMs = Date.parse("2026-11-09T10:00:30Z");
    const delays: number[] = [];
    const cleared: unknown[] = [];
    const timers = {
      setTimeout: (_fn: () => void, ms: number): unknown => {
        delays.push(ms);
        return delays.length;
      },
      clearTimeout: (handle: unknown): void => {
        cleared.push(handle);
      },
    };
    const scheduler = new Scheduler({
      lock: new InMemoryLock({ now: () => nowMs }),
      owner: "o",
      now: () => nowMs,
      timers,
    });
    scheduler.schedule("minutely", "* * * * *", { timeZone: "UTC", handler: noopHandler });
    nowMs = Date.parse("2026-11-09T10:05:00Z");
    scheduler.start();
    expect(delays).toEqual([0]);
    await scheduler.stop();
    expect(cleared).toEqual([1]);
  });

  it("caps the timer delay at 2_147_483_647 ms", async () => {
    const nowMs = Date.parse("2026-06-02T00:00:00Z");
    const delays: number[] = [];
    const cleared: unknown[] = [];
    const timers = {
      setTimeout: (_fn: () => void, ms: number): unknown => {
        delays.push(ms);
        return delays.length;
      },
      clearTimeout: (handle: unknown): void => {
        cleared.push(handle);
      },
    };
    const scheduler = new Scheduler({
      lock: new InMemoryLock({ now: () => nowMs }),
      owner: "o",
      now: () => nowMs,
      timers,
    });
    scheduler.schedule("monthly", "0 0 1 * *", { timeZone: "UTC", handler: noopHandler });

    scheduler.start();
    expect(delays).toEqual([2_147_483_647]);
    await scheduler.stop();
    expect(cleared).toEqual([1]);
  });

  it("a throwing event listener never breaks scheduling", async () => {
    const nowMs = Date.parse("2026-11-09T10:00:00Z");
    let runs = 0;
    const scheduler = new Scheduler({
      lock: new InMemoryLock({ now: () => nowMs }),
      owner: "o",
      now: () => nowMs,
      onEvent: () => {
        throw new Error("listener");
      },
    });
    scheduler.schedule("job", "* * * * *", {
      timeZone: "UTC",
      handler: async () => {
        runs++;
      },
    });

    await scheduler.tick();
    await flushMicrotasks();
    expect(runs).toBe(1);
    await scheduler.stop();
  });
});
