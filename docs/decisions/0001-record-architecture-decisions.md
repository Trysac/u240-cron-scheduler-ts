# 0001 — Record architecture decisions

## Status

Accepted.

## Context

The library makes choices that are easy to change by accident and expensive to change later: how DST gaps and
overlaps are handled, how occurrences are claimed across replicas, and how time is supplied so tests are
deterministic. Contributors need a place to see why these choices were made.

## Decision

Record every architectural decision as a numbered Markdown file in `docs/decisions/`, named
`NNNN-title.md`. Each record states its status, context, decision and consequences. The overview lives in
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

## Consequences

- Reviewers can check a change against the recorded rationale instead of re-deriving it.
- Superseding a decision requires a new record, so history is preserved.
- The documents check treats `docs/decisions/NNNN-*.md` as required content.
