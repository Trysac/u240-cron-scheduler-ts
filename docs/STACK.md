# Stack

## Runtime

- **Node.js 20+**, ES modules. The package is published as ESM with type declarations.
- **No runtime dependencies.** Time-zone handling uses the ECMAScript `Intl.DateTimeFormat` API with a
  `timeZone` and `hourCycle: "h23"`, which is available in every supported Node.js version.
- **TypeScript** in strict mode; relative imports use the `.js` extension so the emitted ESM works unchanged.

## Development

| Tool | Purpose |
|---|---|
| TypeScript | Type checking and `dist/` build. |
| Vitest | Test runner with V8 coverage. |
| Biome | Formatting and linting. |

## Considered and discarded

- **`node-cron` / `croner`**: rely on real timers and implicit time-zone behavior, which makes DST and
  multi-replica behavior hard to test deterministically. This library uses an injected clock, a stated DST
  policy and per-occurrence locking instead.
- **Date libraries (`luxon`, `date-fns-tz`, `moment-timezone`)**: add runtime weight for a small amount of
  conversion logic that `Intl` already covers.
- **Distributed lock clients (Redis, Postgres)**: kept out of the core. `LockPort` is the extension point.
- **Cron parser packages**: the grammar is small and a hand-written parser gives exact `invalid_cron`
  behavior.
