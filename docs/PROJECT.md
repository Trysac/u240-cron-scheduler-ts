# Project record

## Objective

Provide a small, dependency-free cron scheduler for TypeScript services that run more than one replica, where
the hard problems are time zones, daylight saving transitions and duplicate or missing runs.

## Scope

In scope:

- Five-field cron parsing with names, lists, ranges and steps.
- Occurrence computation in an IANA time zone with an explicit DST policy.
- A `LockPort` so only one instance runs an occurrence, with an in-memory implementation for tests and single
  processes.
- Overlap (`skip`, `allow`) and catch-up (`skip`, `run-once`) policies.
- Deterministic operation through an injected clock and injected timers.

Out of scope:

- Seconds fields, `@reboot` and other special expressions.
- Persistence of job state.
- Redis or Postgres lock implementations (implement `LockPort`).
- Human-readable cron explanations.

## Deliverables

- `src/index.ts`: the whole public API.
- `test/index.test.ts`: the acceptance and edge-case suite.
- Documentation under `docs/` (architecture, testing, security, stack, decisions).

## Timeline

The library was produced as a single iteration of the factory workflow: specification, implementation, tests
and documentation.

## Metrics

The project is intentionally small: one source module, one test suite, no runtime dependencies.

## Factory run u240 (measured from API usage)

| Date (UTC) | Phase | Model | Batch | Input | Output | Cache write | Cache read | Cost (USD) |
|---|---|---|---|---|---|---|---|---|
| 2026-11-10 | generation | deepseek-v4-pro | yes | 1928 | 32696 | 0 | 3584 | 0.0661 |
| 2026-11-10 | fix-1 | deepseek-flash | no | 40801 | 51713 | 0 | 1590528 | 0.0419 |
| 2026-11-10 | audit | deepseek-flash | no | 26904 | 23031 | 0 | 298112 | 0.0187 |
| 2026-11-10 | fix-2 | deepseek-flash | no | 29706 | 24292 | 0 | 857216 | 0.0216 |
| 2026-11-10 | docs | deepseek-flash | no | 22715 | 11929 | 0 | 384 | 0.0106 |

Total: $0.1589. Prices: deepseek line, as measured by its adapter. Providers serve the current version of each model id, so the date tells which version answered; versions, launch stages and price sources per line are in the factory's model register (docs/MODELS.md).
