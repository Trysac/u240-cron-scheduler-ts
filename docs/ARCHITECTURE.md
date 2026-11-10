# Architecture

`@trysac/cron-scheduler-ts` is a single-module library. `src/index.ts` is the only public entry point and
contains three cooperating parts: cron parsing, occurrence computation and the scheduler loop.

## Modules and boundaries

| Part | Public names | Responsibility |
|---|---|---|
| Parsing | `parseCron` | Validate a five-field expression and produce a `CronSchedule`. |
| Occurrences | `nextRun` | Convert a `CronSchedule` plus a start instant and IANA time zone into the next UTC instant. |
| Locking | `LockPort`, `InMemoryLock` | Claim one occurrence across scheduler instances. |
| Scheduling | `Scheduler` | Track jobs, claim due occurrences, run handlers, emit events. |
| Errors | `CronSchedulerError` | Stable machine-readable `code` values. |

There are no runtime dependencies. Time-zone math uses `Intl.DateTimeFormat` with a `timeZone` and
`hourCycle: "h23"`; nothing else reads the wall clock. All time-dependent behavior goes through the injected
`now` function, and all delays go through the injected `timers`, so tests never wait.

## Occurrence computation

`nextRun(schedule, after, timeZone)` enumerates matching local wall-clock times in ascending order, starting
one minute after the local time of `after`, and stops after five local years with `no_next_run`.

To stay fast the search does not step minute by minute. It skips whole months, days, hours and minutes whose
field does not match, so expressions such as `0 0 29 2 *` (leap day) and `0 0 30 2 *` (never) are resolved in
a few hundred iterations rather than millions.

Each matching local time is converted to UTC by finding the instants whose formatted local time equals it:

- **DST gap** (no such instant): the candidate is skipped, so a nonexistent local time never runs.
- **DST overlap** (two such instants): only the earlier instant is returned, so an ambiguous local time runs
  once per day.

Day matching follows Vixie cron: when both day-of-month and day-of-week are restricted, a day matches when
either matches; otherwise both must match.

## Locking

`LockPort.acquire(key, owner, ttlMs)` returns whether the caller now owns the occurrence. The scheduler keys
each occurrence as `` `${job}@${occurrence.toISOString()}` `` and never releases a lock: the TTL must outlive
the time between two instances' ticks. `InMemoryLock` purges expired keys before each acquire and throws
`lock_full` when the store is at capacity.

## Scheduler loop

`schedule()` stores a job and its pending occurrence, the first occurrence at or after `now()`.
`tick()` iterates jobs in schedule order and, while the pending occurrence is due:

1. If it is older than `graceMs` the run is missed: emit `missed` and apply the catch-up policy. `skip` jumps
   to the first occurrence after `now()`; `run-once` emits `missed` for every missed occurrence, runs the
   latest one once and then resumes the normal loop, so occurrences that are still within grace are not
   dropped.
2. Otherwise the occurrence is claimed through the lock. When the claim fails, emit `lock_not_acquired`;
   when the lock call rejects, emit `failed` and do not run.
3. With `overlap: "skip"`, a job that is already running in this instance emits `skipped_overlap` instead of
   starting again. `overlap: "allow"` starts a second run.
4. A run emits `started`, then `succeeded` or `failed` once the handler settles. Events carry only
   `{ type, job, scheduledAt }`; handler data and error messages never appear.

Handlers are not awaited by `tick()`; only lock calls are. `stop()` clears the timer, aborts every running
handler's signal and resolves when they settle. `start()` arms a single timer for the earliest pending
occurrence, capped at `2_147_483_647` ms, that calls `tick()` and re-arms.

## Decisions

Architecture decisions are recorded in [`docs/decisions/`](decisions/0001-record-architecture-decisions.md).
