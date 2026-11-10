# Testing

## Tools

- [Vitest](https://vitest.dev/) runs the suites in `test/`.
- Coverage is collected with V8 (`@vitest/coverage-v8`) over `src/`.

## Commands

```sh
npm test            # vitest run --coverage
npx vitest          # watch mode while developing
npm run check       # every gate, including tests
```

## Rules

- Coverage must stay at or above 80 % for lines, branches, functions and statements (`vitest.config.ts`).
  Lowering the thresholds is not allowed.
- Test through the public entry point (`src/index.ts`) and assert observable behavior: return values,
  thrown errors and their messages.
- Each bug fix adds a test that fails without the fix.
- Tests are deterministic: no network, no real clock or randomness without injection, no shared state between
  tests. Temporary files go to the OS temp directory and are removed by the test.

## Tiers

- Local tier (every gate run, coverage measured here): unit and property tests, plus conformance on small
  fixtures kept in the repository.
- CI tier: conformance that needs an external tool or a download. Name them `test/<name>.conformance.test.ts`; `vitest.config.ts` excludes them locally
  (unless `FABRICA_CI=1`). The CI `conformance` job sets `FABRICA_CI=1` and runs the full suite. Tools are installed
  by the optional `ci/conformance-setup.sh` (bash, CI only; verify every download against a pinned SHA-256), and
  tagged tests skip cleanly when their tool is missing.

## Reports

Coverage reports are written to `coverage/` (text summary and `lcov`). The folder is ignored by git.
