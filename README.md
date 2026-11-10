# @trysac/cron-scheduler-ts

Deterministic cron scheduling for horizontally scaled services. Compute occurrences in IANA time zones with an explicit DST policy, claim each occurrence through a lock port, and control overlap and catch-up behaviour. No runtime dependencies; all time logic is driven by an injected clock.

## Usage

```ts
import { InMemoryLock, Scheduler, parseCron, nextRun } from "@trysac/cron-scheduler-ts";

const lock = new InMemoryLock({ now: Date.now });
const scheduler = new Scheduler({ lock, owner: "instance-a", now: Date.now });

scheduler.schedule("daily-report", "30 2 * * *", {
  timeZone: "Europe/Madrid",
  handler: async ({ scheduledAt }) => {
    console.log("Running report for", scheduledAt.toISOString());
  },
});

scheduler.start();
```

See `docs/` for architecture and testing details.
