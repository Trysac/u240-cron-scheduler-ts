# Security practices

This document describes how `@trysac/cron-scheduler-ts` is built and what consumers should know. For how to
report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Surface

The library is in-process and has no runtime dependencies. It does not open sockets, read files, spawn
processes or evaluate code. Cron expressions are parsed with a fixed grammar, never with a regular expression
engine that can backtrack catastrophically.

## Input handling

- `parseCron` rejects any input that is not five fields of the documented grammar, including non-canonical
  numeric atoms (`+5`, `-5`, `0x10`, `1e1`), steps on a single value and expressions longer than 200
  characters.
- Error messages quote at most the offending expression and never contain secrets. `CronSchedulerError`
  exposes a stable `code` so callers can branch without parsing messages.
- `nextRun` validates the time zone with `Intl.DateTimeFormat` and reports `invalid_time_zone`; the search is
  bounded by five local years and cannot loop forever.

## Scheduling safety

- Handlers receive an `AbortSignal` that is aborted by `stop()` and `unschedule()`, so shutdown interrupts
  long-running work instead of leaving it dangling.
- `onEvent` callbacks are isolated: a throwing listener never breaks scheduling.
- Events carry only `{ type, job, scheduledAt }`. Handler results, error messages and stack traces are never
  emitted, so a log pipeline cannot leak job payloads through this library.
- Occurrences are claimed through `LockPort`; the lock TTL must outlive the time between two instances' ticks.
  Choose a TTL that matches your deployment's jitter and never release a lock early.

## Supply chain

- No runtime dependencies; development dependencies are pinned in `package-lock.json`.
- The repository ships a gitleaks configuration (`.gitleaks.toml`) and the quality gate fails on leaked
  secrets.
- Never commit tokens, `.env` files or credentials, and never paste them into logs or prompts.
