# Explicit DST policy and per-occurrence locking for cron scheduling

Status: accepted (generated, pending human review)

## Context

A cron scheduler for horizontally scaled services must handle DST gaps/overlaps, prevent duplicate runs across replicas, and be testable without real timers.

## Decision

Compute occurrences in the job's IANA time zone by enumerating local wall-clock times and converting to UTC using surrounding-offset search; use a lock port to claim each occurrence with a TTL, and inject clock/timers for deterministic behaviour.

## Consequences

The scheduler is fully deterministic and testable, and only one instance runs each occurrence. DST ambiguity is resolved by skipping gaps and running overlaps once (earliest instant). Lock TTLs must be tuned to exceed tick intervals; the library never releases locks early.
