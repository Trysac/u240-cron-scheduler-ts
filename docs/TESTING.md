# Testing

Tests live in `test/` and use Vitest. One suite (`test/index.test.ts`) exercises the public entry point
`src/index.ts`; there is no test that reaches into private state.

## Determinism

Every test injects the clock and the timers:

- `Scheduler` and `InMemoryLock` receive `now: () => number`, so a test can move time forward by reassigning
  a local variable.
- `Scheduler` receives `timers: { setTimeout, clearTimeout }`, so timer arming is asserted by recording the
  requested delays instead of waiting.

No test uses real time, `sleep`, or a real timer.

## What the suite covers

- Parsing: `*`, lists, ranges, steps, case-insensitive month and day names, day-of-week `7` equal to `0`, and
  `invalid_cron` for out-of-range values, non-canonical atoms (`-5`, `+5`, `0x10`, `1e1`), a step on a single
  value (`5/15`), wrong field counts, `@reboot` and over-long input.
- Occurrence computation: the Madrid DST gap and overlap acceptance cases, the Vixie day-of-month OR
  day-of-week rule, `*/15` across the 2026-03-08 DST change in `America/New_York`, a leap-day occurrence more
  than two years away, rollovers across minute, hour, day, month and year boundaries, `no_next_run` for
  impossible dates, and `invalid_time_zone` / `invalid_options`.
- Locking: acquire, refusal of an existing key, purge of expired keys and `lock_full`.
- Scheduling: two instances sharing one lock run an occurrence once and the loser emits
  `lock_not_acquired`; a rejecting lock emits `failed` and does not run; `overlap` `skip` and `allow`;
  catch-up `skip` and `run-once` including occurrences still inside the grace period; a rejecting handler
  emits `failed` without its message and later occurrences still run; `started`/`succeeded` ordering;
  `duplicate_job`, `too_many_jobs`, `invalid_options` and `no_next_run` when scheduling; `unschedule` during a
  running handler; `stop()` aborting handlers; timer arming and re-arming, zero delay and the delay cap; and a
  throwing event listener.

## Coverage

`npm test` runs `vitest run --coverage`. The configured thresholds (80 % for lines, branches, functions and
statements) are a floor and must never be lowered to make a change pass; add tests instead.

## Running

```sh
npm install
npm run lint
npm run typecheck
npm test
```

See [AGENTS.md](../AGENTS.md) for the full gate list.
