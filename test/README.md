# Tests (dev-only — NEVER required to run the app)

The shipped app runs with zero build/test tooling. Tests exist only to guard the
DOM-free modules and are authored in **Stage B**, one suite per module worker.

Runner: **bun** (`bun test`) — no separate framework needed for Stage A; Stage B
may add Vitest if richer matchers help. Nothing here is imported by the app.

## Planned coverage (from the spec's Quality Infrastructure)

- `format`: `formatUnits` (bad/empty/negative/huge decimals → honest indeterminate),
  `edgeDedupKey` (ERC-1155 + same-symbol/different-contract stay distinct),
  `escapeHtml`, `csvEscape`, `isValidAddress`, `isFailedTx`.
- `rateLimiter`: pacing, serialization, `clear()` rejects queued.
- `etherscanClient`: `buildUrl`, retry/backoff, Retry-After, no-tx→empty,
  invalid-key vs rate-limit vs timeout classification (inject `fetchImpl`).
- `scanner`: BFS enqueue dedup + safetyCap-at-enqueue, depth>=maxDepth not
  expanded, failed-tx filtering, sampling, cancellation (inject fakes).
- `graphStore`: invariants (every edge endpoint is a node; edgeKeys↔edges parity;
  every node has meta), merge-min-depth, sticky isRoot, removeNodes cascade.
- `i18n`: interpolation, fallback chain, `en`/`fr` key parity.

## Run (once Stage B lands)

```bash
bun test
```
