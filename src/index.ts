/**
 * Public entry point of @trysac/cron-scheduler-ts.
 *
 * Provides a deterministic cron scheduler for horizontally scaled TypeScript services.
 * Occurrences are computed in a named IANA time zone with an explicit DST policy,
 * each occurrence is claimed through a lock port so only one instance runs it, and
 * all time-dependent logic is driven by an injected clock.
 */

/**
 * A parsed cron schedule.
 *
 * Each field is an array of allowed values, sorted ascending and without duplicates.
 * For day-of-week, 7 (Sunday) is normalized to 0.
 */
export interface CronSchedule {
  /** Allowed minutes, 0-59. */
  readonly minute: number[];
  /** Allowed hours, 0-23. */
  readonly hour: number[];
  /** Allowed days of month, 1-31. */
  readonly dayOfMonth: number[];
  /** Allowed months, 1-12. */
  readonly month: number[];
  /** Allowed days of week, 0-6 (0 = Sunday). */
  readonly dayOfWeek: number[];
}

/** Machine-readable error codes for {@link CronSchedulerError}. */
export type CronSchedulerErrorCode =
  | "invalid_cron"
  | "invalid_time_zone"
  | "no_next_run"
  | "duplicate_job"
  | "too_many_jobs"
  | "invalid_options"
  | "lock_full";

/**
 * Error thrown by the scheduler for all typed failures.
 *
 * The `code` property is stable and machine-readable; messages never contain
 * secrets or more than 200 characters of input.
 */
export class CronSchedulerError extends Error {
  readonly code: CronSchedulerErrorCode;

  constructor(code: CronSchedulerErrorCode, message: string) {
    super(message);
    this.name = "CronSchedulerError";
    this.code = code;
  }
}

/**
 * Port for claiming occurrences across distributed instances.
 *
 * Implementations must be idempotent for the same key and owner, and should
 * never release a lock before its TTL expires.
 */
export interface LockPort {
  /**
   * Attempts to acquire the lock for `key`.
   *
   * @param key - Globally unique lock identifier.
   * @param owner - Identifier of the acquiring instance.
   * @param ttlMs - How long the lock should be held, in milliseconds.
   * @returns `true` if the lock was acquired, `false` otherwise.
   */
  acquire(key: string, owner: string, ttlMs: number): Promise<boolean>;
}

/** Options for {@link InMemoryLock}. */
export interface InMemoryLockOptions {
  /** Returns the current time in milliseconds since the Unix epoch. */
  now: () => number;
  /** Maximum number of simultaneous keys; 100_000 by default. */
  maxKeys?: number;
}

/**
 * In-memory {@link LockPort} implementation.
 *
 * Keys expire after their TTL; expired keys are purged before each acquire.
 * When the store is full and `acquire` is called for a new key, it throws
 * {@link CronSchedulerError} with code `"lock_full"`.
 */
export class InMemoryLock implements LockPort {
  private readonly entries = new Map<string, { owner: string; expiresAt: number }>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: InMemoryLockOptions) {
    this.now = options.now;
    this.maxKeys = options.maxKeys ?? 100_000;
  }

  async acquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const nowMs = this.now();
    // Purge expired entries first.
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= nowMs) {
        this.entries.delete(k);
      }
    }

    const existing = this.entries.get(key);
    if (existing) {
      return false;
    }

    if (this.entries.size >= this.maxKeys) {
      throw new CronSchedulerError("lock_full", "Lock store is full");
    }

    this.entries.set(key, { owner, expiresAt: nowMs + ttlMs });
    return true;
  }
}

/** Resulting event emitted by {@link Scheduler}. */
export type SchedulerEvent =
  | { type: "started"; job: string; scheduledAt: Date }
  | { type: "succeeded"; job: string; scheduledAt: Date }
  | { type: "failed"; job: string; scheduledAt: Date }
  | { type: "skipped_overlap"; job: string; scheduledAt: Date }
  | { type: "missed"; job: string; scheduledAt: Date }
  | { type: "lock_not_acquired"; job: string; scheduledAt: Date };

/** Options for {@link Scheduler.schedule}. */
export interface JobOptions {
  /** IANA time zone in which the cron expression is evaluated. */
  timeZone: string;
  /**
   * Asynchronous handler to run for each occurrence.
   *
   * The handler receives the scheduled occurrence and an `AbortSignal` that is
   * aborted when the scheduler is stopped.
   */
  handler: (ctx: { scheduledAt: Date; signal: AbortSignal }) => Promise<void>;
  /** Lock TTL in milliseconds; 300_000 (5 minutes) by default. */
  lockTtlMs?: number;
  /** Overlap policy for the same job in this instance; `"skip"` by default. */
  overlap?: "skip" | "allow";
  /** Missed-run policy; `"skip"` by default. */
  catchUp?: "skip" | "run-once";
  /** Grace period in milliseconds; occurrences older than this are missed. */
  graceMs?: number;
}

/** Options for {@link Scheduler} constructor. */
export interface SchedulerOptions {
  /** Lock implementation used to claim occurrences across instances. */
  lock: LockPort;
  /** Identifier of this scheduler instance; used as lock owner. */
  owner: string;
  /** Current-time function; defaults to `Date.now`. */
  now?: () => number;
  /** Timer injection; defaults to global `setTimeout`/`clearTimeout`. */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /** Maximum number of scheduled jobs; 1_000 by default. */
  maxJobs?: number;
  /** Optional event listener. */
  onEvent?: (event: SchedulerEvent) => void;
}

interface RunInfo {
  controller: AbortController;
  promise: Promise<void>;
}

interface JobState {
  name: string;
  schedule: CronSchedule;
  timeZone: string;
  handler: (ctx: { scheduledAt: Date; signal: AbortSignal }) => Promise<void>;
  lockTtlMs: number;
  overlap: "skip" | "allow";
  catchUp: "skip" | "run-once";
  graceMs: number;
  pendingOccurrence: Date;
  runningCount: number;
  runs: Set<RunInfo>;
}

/**
 * In-process cron scheduler for TypeScript.
 *
 * Use {@link schedule} to register jobs, then call {@link start} to begin
 * ticking automatically, or call {@link tick} manually in tests.
 */
export class Scheduler {
  private readonly jobs = new Map<string, JobState>();
  private readonly lock: LockPort;
  private readonly owner: string;
  private readonly now: () => number;
  private readonly timers: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  private readonly maxJobs: number;
  private readonly onEvent: ((event: SchedulerEvent) => void) | undefined;
  private timerHandle: unknown;
  private started = false;

  constructor(options: SchedulerOptions) {
    this.lock = options.lock;
    this.owner = options.owner;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
    this.maxJobs = options.maxJobs ?? 1_000;
    this.onEvent = options.onEvent;
  }

  /**
   * Registers a cron job.
   *
   * @param name - Unique job name.
   * @param expr - Cron expression with five fields.
   * @param opts - Job options, including the IANA time zone and handler.
   * @throws {CronSchedulerError} with codes `"duplicate_job"`,
   *   `"too_many_jobs"`, `"invalid_cron"`, `"invalid_time_zone"`, or
   *   `"no_next_run"` where applicable.
   */
  schedule(name: string, expr: string, opts: JobOptions): void {
    if (this.jobs.has(name)) {
      throw new CronSchedulerError("duplicate_job", `Job already exists: ${name}`);
    }
    if (this.jobs.size >= this.maxJobs) {
      throw new CronSchedulerError("too_many_jobs", `Too many jobs (max ${this.maxJobs})`);
    }
    const schedule = parseCron(expr);
    this.validateTimeZone(opts.timeZone);
    const lockTtlMs = opts.lockTtlMs ?? 300_000;
    const overlap = opts.overlap ?? "skip";
    const catchUp = opts.catchUp ?? "skip";
    const graceMs = opts.graceMs ?? 60_000;
    if (overlap !== "skip" && overlap !== "allow") {
      throw new CronSchedulerError("invalid_options", `Invalid overlap policy: ${overlap}`);
    }
    if (catchUp !== "skip" && catchUp !== "run-once") {
      throw new CronSchedulerError("invalid_options", `Invalid catchUp policy: ${catchUp}`);
    }
    if (lockTtlMs <= 0) {
      throw new CronSchedulerError("invalid_options", "lockTtlMs must be positive");
    }
    if (graceMs < 0) {
      throw new CronSchedulerError("invalid_options", "graceMs must be non-negative");
    }
    const pendingOccurrence = nextRun(schedule, new Date(this.now() - 1), opts.timeZone);
    this.jobs.set(name, {
      name,
      schedule,
      timeZone: opts.timeZone,
      handler: opts.handler,
      lockTtlMs,
      overlap,
      catchUp,
      graceMs,
      pendingOccurrence,
      runningCount: 0,
      runs: new Set(),
    });
  }

  /**
   * Removes a previously scheduled job.
   *
   * @param name - Job name.
   * @returns `true` if the job existed and was removed, `false` otherwise.
   */
  unschedule(name: string): boolean {
    const job = this.jobs.get(name);
    if (!job) {
      return false;
    }
    for (const run of job.runs) {
      run.controller.abort();
    }
    job.runs.clear();
    job.runningCount = 0;
    this.jobs.delete(name);
    return true;
  }

  /**
   * Runs one tick: for each job in schedule order, processes due occurrences.
   *
   * Handlers are started asynchronously and are not awaited by this method;
   * only lock acquisitions are awaited.
   */
  async tick(): Promise<void> {
    for (const job of this.jobs.values()) {
      const nowMs = this.now();
      while (job.pendingOccurrence.getTime() <= nowMs) {
        const occurrence = job.pendingOccurrence;
        const missed = nowMs - occurrence.getTime() > job.graceMs;

        if (missed) {
          this.emit({ type: "missed", job: job.name, scheduledAt: occurrence });
          if (job.catchUp === "skip") {
            job.pendingOccurrence = nextRun(job.schedule, new Date(nowMs), job.timeZone);
            break;
          }
          // run-once: run the latest missed occurrence once, then resume after now.
          let lastMissed = occurrence;
          let cursor = occurrence;
          for (;;) {
            const candidate = nextRun(job.schedule, cursor, job.timeZone);
            if (candidate.getTime() <= nowMs && nowMs - candidate.getTime() > job.graceMs) {
              this.emit({ type: "missed", job: job.name, scheduledAt: candidate });
              lastMissed = candidate;
              cursor = candidate;
            } else {
              break;
            }
          }
          await this.claimAndRun(job, lastMissed);
          // Resume the normal loop from the occurrence after the one just run:
          // occurrences that are due but still within the grace period must not
          // be dropped.
          job.pendingOccurrence = nextRun(job.schedule, lastMissed, job.timeZone);
          continue;
        }

        // Not missed; proceed with lock acquisition.
        await this.claimAndRun(job, occurrence);
        job.pendingOccurrence = nextRun(job.schedule, occurrence, job.timeZone);
      }
    }
  }

  /**
   * Starts the internal timer. The scheduler will call {@link tick}
   * automatically at the earliest pending occurrence, then re-arm itself.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.armTimer();
  }

  /**
   * Stops the scheduler timer and aborts all running handlers, then waits
   * for them to settle.
   */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timerHandle !== undefined) {
      this.timers.clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
    const runningPromises: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      for (const run of job.runs) {
        run.controller.abort();
        runningPromises.push(run.promise);
      }
      job.runs.clear();
      job.runningCount = 0;
    }
    await Promise.all(runningPromises.map((p) => p.catch(() => undefined)));
  }

  private async claimAndRun(job: JobState, occurrence: Date): Promise<void> {
    const lockKey = `${job.name}@${occurrence.toISOString()}`;
    try {
      const acquired = await this.lock.acquire(lockKey, this.owner, job.lockTtlMs);
      if (!acquired) {
        this.emit({ type: "lock_not_acquired", job: job.name, scheduledAt: occurrence });
        return;
      }
    } catch {
      this.emit({ type: "failed", job: job.name, scheduledAt: occurrence });
      return;
    }

    if (job.overlap === "skip" && job.runningCount > 0) {
      this.emit({ type: "skipped_overlap", job: job.name, scheduledAt: occurrence });
      return;
    }

    job.runningCount++;
    const controller = new AbortController();
    const run: RunInfo = { controller, promise: Promise.resolve() };
    job.runs.add(run);
    this.emit({ type: "started", job: job.name, scheduledAt: occurrence });
    run.promise = this.runHandler(job, occurrence, controller.signal)
      .then(() => {
        job.runningCount--;
        this.emit({ type: "succeeded", job: job.name, scheduledAt: occurrence });
      })
      .catch(() => {
        job.runningCount--;
        this.emit({ type: "failed", job: job.name, scheduledAt: occurrence });
      })
      .finally(() => {
        job.runs.delete(run);
      });
  }

  private async runHandler(job: JobState, scheduledAt: Date, signal: AbortSignal): Promise<void> {
    await job.handler({ scheduledAt, signal });
  }

  private armTimer(): void {
    if (!this.started || this.jobs.size === 0) {
      return;
    }
    const nowMs = this.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const job of this.jobs.values()) {
      const t = job.pendingOccurrence.getTime();
      if (t < earliest) {
        earliest = t;
      }
    }
    if (!Number.isFinite(earliest)) {
      return;
    }
    let delay = earliest - nowMs;
    if (delay < 0) {
      delay = 0;
    }
    if (delay > 2_147_483_647) {
      delay = 2_147_483_647;
    }
    if (this.timerHandle !== undefined) {
      this.timers.clearTimeout(this.timerHandle);
    }
    this.timerHandle = this.timers.setTimeout(() => {
      void this.tick().finally(() => this.armTimer());
    }, delay);
  }

  private emit(event: SchedulerEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Event listeners must never break scheduling.
    }
  }

  private validateTimeZone(timeZone: string): void {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format();
    } catch {
      throw new CronSchedulerError("invalid_time_zone", `Invalid time zone: ${timeZone}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Cron parsing and next-run computation
// ---------------------------------------------------------------------------

interface ScheduleMeta {
  domWildcard: boolean;
  dowWildcard: boolean;
}

const scheduleMeta = new WeakMap<CronSchedule, ScheduleMeta>();

const MONTH_NAMES = new Map<string, number>([
  ["JAN", 1],
  ["FEB", 2],
  ["MAR", 3],
  ["APR", 4],
  ["MAY", 5],
  ["JUN", 6],
  ["JUL", 7],
  ["AUG", 8],
  ["SEP", 9],
  ["OCT", 10],
  ["NOV", 11],
  ["DEC", 12],
]);

const DOW_NAMES = new Map<string, number>([
  ["SUN", 0],
  ["MON", 1],
  ["TUE", 2],
  ["WED", 3],
  ["THU", 4],
  ["FRI", 5],
  ["SAT", 6],
]);

/**
 * Parses a standard five-field cron expression.
 *
 * Supported syntax: `*`, lists, ranges, steps (a star followed by `/n`) and `a-b/n`.
 * Month and day-of-week names are case-insensitive.
 * Day-of-week 7 is normalized to 0 (Sunday).
 *
 * @param expr - Cron expression, at most 200 characters.
 * @returns Parsed schedule.
 * @throws {CronSchedulerError} with code `"invalid_cron"` for invalid input.
 */
export function parseCron(expr: string): CronSchedule {
  if (typeof expr !== "string") {
    throw new CronSchedulerError("invalid_cron", "Cron expression must be a string");
  }
  if (expr.length > 200) {
    throw new CronSchedulerError("invalid_cron", "Cron expression too long (max 200 characters)");
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronSchedulerError("invalid_cron", "Cron expression must have exactly 5 fields");
  }

  const [minuteField = "", hourField = "", domField = "", monthField = "", dowField = ""] = fields;
  const minute = parseField(minuteField, 0, 59, "minute");
  const hour = parseField(hourField, 0, 23, "hour");
  const dayOfMonth = parseField(domField, 1, 31, "day of month");
  const month = parseField(monthField, 1, 12, "month", MONTH_NAMES);
  const dayOfWeekRaw = parseField(dowField, 0, 7, "day of week", DOW_NAMES);
  const dayOfWeek = dayOfWeekRaw.map((v) => (v === 7 ? 0 : v));
  const uniqueDayOfWeek = Array.from(new Set(dayOfWeek)).sort((a, b) => a - b);

  const schedule: CronSchedule = {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek: uniqueDayOfWeek,
  };
  scheduleMeta.set(schedule, {
    domWildcard: domField === "*",
    dowWildcard: dowField === "*",
  });
  return schedule;
}

function parseField(
  field: string,
  min: number,
  max: number,
  fieldName: string,
  names?: Map<string, number>,
): number[] {
  const allowed = new Set<number>();
  const parts = field.split(",");
  for (const part of parts) {
    if (part === "") {
      throw invalidCron(`Empty item in ${fieldName}`);
    }
    let base = part;
    let step = 1;
    const slashIdx = part.indexOf("/");
    if (slashIdx !== -1) {
      const slashParts = part.split("/");
      if (slashParts.length !== 2) {
        throw invalidCron(`Invalid step in ${fieldName}`);
      }
      base = slashParts[0] ?? "";
      const stepNum = Number(slashParts[1] ?? "");
      if (!Number.isInteger(stepNum) || stepNum <= 0) {
        throw invalidCron(`Invalid step value in ${fieldName}`);
      }
      step = stepNum;
    }

    if (base === "*") {
      for (let v = min; v <= max; v += step) {
        allowed.add(v);
      }
      continue;
    }

    const rangeParts = base.split("-");
    if (rangeParts.length === 1) {
      if (step !== 1) {
        throw invalidCron(`Step requires a range or '*' in ${fieldName}`);
      }
      const value = parseAtom(rangeParts[0] ?? "", min, max, names, fieldName);
      allowed.add(value);
      continue;
    }
    if (rangeParts.length === 2) {
      const start = parseAtom(rangeParts[0] ?? "", min, max, names, fieldName);
      const end = parseAtom(rangeParts[1] ?? "", min, max, names, fieldName);
      if (start > end) {
        throw invalidCron(`Range start greater than end in ${fieldName}`);
      }
      for (let v = start; v <= end; v += step) {
        allowed.add(v);
      }
      continue;
    }
    throw invalidCron(`Invalid syntax in ${fieldName}`);
  }

  const arr = Array.from(allowed).sort((a, b) => a - b);
  if (arr.length === 0) {
    throw invalidCron(`No allowed values in ${fieldName}`);
  }
  return arr;
}

function parseAtom(
  token: string,
  min: number,
  max: number,
  names: Map<string, number> | undefined,
  fieldName: string,
): number {
  const upper = token.toUpperCase();
  const named = names?.get(upper);
  if (named !== undefined) {
    return named;
  }
  // Only canonical decimal integers are accepted; this rejects '', '+5', '-5',
  // '0x10', '1e1' and similar tokens that Number() would silently coerce.
  if (!/^[0-9]{1,2}$/.test(token)) {
    throw invalidCron(`Invalid value "${token}" in ${fieldName}`);
  }
  const num = Number(token);
  if (num < min || num > max) {
    throw invalidCron(`Value ${num} out of range for ${fieldName}`);
  }
  return num;
}

function invalidCron(message: string): CronSchedulerError {
  return new CronSchedulerError("invalid_cron", message);
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Computes the next run date strictly after `after`, in the given time zone.
 *
 * Local wall-clock times are enumerated in ascending order. DST gaps are
 * skipped; during DST overlaps the first possible instant is used. Searching
 * stops after 5 local years.
 *
 * @param schedule - Parsed schedule.
 * @param after - Instant to start from; the result is strictly after this.
 * @param timeZone - IANA time zone name.
 * @returns Next occurrence as a `Date`.
 * @throws {CronSchedulerError} with code `"invalid_time_zone"` or `"no_next_run"`.
 */
export function nextRun(schedule: CronSchedule, after: Date, timeZone: string): Date {
  validateTimeZone(timeZone);
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) {
    throw new CronSchedulerError("invalid_options", "after must be a valid Date");
  }
  const meta = scheduleMeta.get(schedule) ?? { domWildcard: true, dowWildcard: true };
  const afterMs = after.getTime();
  const afterLocal = getLocalParts(afterMs, timeZone);
  let candidate = incrementMinute(afterLocal);
  const maxYear = afterLocal.year + 5;

  for (;;) {
    if (candidate.year > maxYear) {
      throw new CronSchedulerError("no_next_run", "No matching occurrence within 5 years");
    }

    // Jump over whole months whose month field does not match.
    if (!schedule.month.includes(candidate.month)) {
      candidate = advanceToNextMonth(candidate);
      continue;
    }

    // Jump over whole days whose day-of-month/day-of-week predicate fails.
    if (!matchesDay(candidate, schedule, meta)) {
      candidate = advanceToNextDay(candidate);
      continue;
    }

    // Jump over whole hours whose hour field does not match.
    if (!schedule.hour.includes(candidate.hour)) {
      candidate = advanceToNextHour(candidate);
      continue;
    }

    // Jump to the next allowed minute in this hour, or to the next hour.
    if (!schedule.minute.includes(candidate.minute)) {
      candidate = advanceToNextMinute(candidate, schedule.minute);
      continue;
    }

    const instants = localTimeToUtc(candidate, timeZone);
    if (instants.length === 0) {
      // DST gap; skip this local time.
      candidate = incrementMinute(candidate);
      continue;
    }

    instants.sort((a, b) => a - b);
    for (const instant of instants) {
      if (instant > afterMs) {
        return new Date(instant);
      }
    }
    candidate = incrementMinute(candidate);
  }
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new CronSchedulerError("invalid_time_zone", `Invalid time zone: ${timeZone}`);
  }
}

function getLocalParts(dateMs: number, timeZone: string): LocalParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(dateMs));
  const result: LocalParts = {
    year: 0,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  };
  for (const part of parts) {
    switch (part.type) {
      case "year":
        result.year = Number(part.value);
        break;
      case "month":
        result.month = Number(part.value);
        break;
      case "day":
        result.day = Number(part.value);
        break;
      case "hour":
        result.hour = Number(part.value);
        break;
      case "minute":
        result.minute = Number(part.value);
        break;
      case "second":
        result.second = Number(part.value);
        break;
    }
  }
  return result;
}

function incrementMinute(local: LocalParts): LocalParts {
  let { year, month, day, hour, minute } = local;
  minute++;
  if (minute >= 60) {
    minute = 0;
    hour++;
  }
  if (hour >= 24) {
    hour = 0;
    day++;
    const dim = daysInMonth(year, month);
    if (day > dim) {
      day = 1;
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }
  }
  return { year, month, day, hour, minute, second: 0 };
}

function advanceToNextDay(local: LocalParts): LocalParts {
  let { year, month, day } = local;
  day++;
  if (day > daysInMonth(year, month)) {
    day = 1;
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return { year, month, day, hour: 0, minute: 0, second: 0 };
}

function advanceToNextMonth(local: LocalParts): LocalParts {
  let { year, month } = local;
  month++;
  if (month > 12) {
    month = 1;
    year++;
  }
  return { year, month, day: 1, hour: 0, minute: 0, second: 0 };
}

function advanceToNextHour(local: LocalParts): LocalParts {
  if (local.hour < 23) {
    return { ...local, hour: local.hour + 1, minute: 0, second: 0 };
  }
  return advanceToNextDay(local);
}

function advanceToNextMinute(local: LocalParts, minutes: number[]): LocalParts {
  for (const minute of minutes) {
    if (minute > local.minute) {
      return { ...local, minute, second: 0 };
    }
  }
  return advanceToNextHour(local);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function matchesDay(local: LocalParts, schedule: CronSchedule, meta: ScheduleMeta): boolean {
  const domAllowed = schedule.dayOfMonth.includes(local.day);
  const dowAllowed = schedule.dayOfWeek.includes(getDayOfWeek(local.year, local.month, local.day));

  if (!meta.domWildcard && !meta.dowWildcard) {
    return domAllowed || dowAllowed;
  }
  if (!meta.domWildcard) {
    return domAllowed;
  }
  if (!meta.dowWildcard) {
    return dowAllowed;
  }
  return true;
}

function getDayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function localTimeToUtc(local: LocalParts, timeZone: string): number[] {
  const targetUtcMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  let guess = targetUtcMs;
  for (let i = 0; i < 3; i++) {
    const offset = getOffsetMinutes(guess, timeZone);
    guess = targetUtcMs - offset * 60_000;
  }

  const results = new Set<number>();
  const start = guess - 3 * 60 * 60 * 1000;
  const end = guess + 3 * 60 * 60 * 1000;
  for (let t = start; t <= end; t += 60_000) {
    if (matchesLocalTime(t, local, timeZone)) {
      results.add(t);
    }
  }
  return Array.from(results);
}

function getOffsetMinutes(utcMs: number, timeZone: string): number {
  const local = getLocalParts(utcMs, timeZone);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  return Math.round((localAsUtc - utcMs) / 60_000);
}

function matchesLocalTime(utcMs: number, target: LocalParts, timeZone: string): boolean {
  const local = getLocalParts(utcMs, timeZone);
  return (
    local.year === target.year &&
    local.month === target.month &&
    local.day === target.day &&
    local.hour === target.hour &&
    local.minute === target.minute &&
    local.second === 0
  );
}
