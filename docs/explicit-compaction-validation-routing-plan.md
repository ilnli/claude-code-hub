# Explicit Compaction Validation, Routing, and Billing Plan

## Outcome

Recognize standalone remote compaction v1 and Codex remote compaction v2 from their original client
wire form, show that version in the user's normal request record, validate the complete upstream
compaction result before delivery, and retry or switch Providers when the result is not consumable.
Retain one logical request while charging every upstream attempt that reports usage.

This plan implements [ADR 0006](./adr/0006-validate-route-and-bill-explicit-compaction.md). It builds
on commit `191bb19a`, which added exact v2 request recognition and raw passthrough but did not add a
semantic response validator.

## Scope

Included:

- Versioned request identity, persistence, history display, and historical best-effort attribution.
- Bounded JSON and SSE collection, semantic validation, usage extraction, and raw-byte delivery.
- Serial same-Provider retry, Provider fallback, version-specific capability memory, and probe lease.
- Per-attempt durable billing, logical aggregation, spend rechecks, pricing-pending handling, and
  stale-request recovery.
- Stable client errors, sanitized evidence, administrator capability controls, metrics, OpenAPI,
  five-language i18n, and tests.

Excluded:

- Threshold-triggered server-side compaction configured through `context_management`.
- Conversion between compaction v1 and v2 or synthesis and repair of upstream compaction items.
- Migration of ordinary request or Hedge loser billing into the attempt ledger.
- Full semantic validation of ordinary Responses traffic.
- Bulk guessing or rewriting of historical compaction versions.

## Invariants

| Area | Invariant |
| --- | --- |
| Logical identity | One client compaction operation is one request record and one logical usage row. |
| Version | v1/v2 comes from the original wire request and survives request-body retention. |
| Commitment | No upstream body byte is client-visible before validation and billing commitment. |
| Output | Successful completion establishes exactly one logical non-empty compaction item. |
| Retry | Only the initial Provider receives one fixed cache-preserving contract retry. |
| Fallback | Every later Provider gets one contract-validation attempt and no extra contract retry. |
| Health | Contract and compaction capability failures never affect the general circuit breaker. |
| Billing | Every attempt with returned usage is charged; missing usage is never estimated. |
| Durability | A charge is durable before another attempt or a final success is allowed. |
| Attribution | User totals are logical; Provider compaction totals are per actual attempt. |
| Security | Validation evidence never contains messages, reasoning, tool data, or encrypted content. |

## Phase 1: Classify and Persist the Original Request

1. Replace the boolean-only result in `src/app/v1/_lib/proxy/remote-compaction.ts` with a focused
   classifier that can return `v1`, `v2`, or not-explicit-compaction.
   - Normalize the route before matching v1 `/v1/responses/compact`.
   - Preserve the commit `191bb19a` v2 rule exactly: normalized `/v1/responses`, object request body,
     and an exact top-level input object with `type === "compaction_trigger"`.
   - Accept one input object or an array. Do not inspect nested content or infer from headers,
     `context_management`, `type: "compaction"`, fuzzy names, or future marker variants.
2. Classify once from the original request in `ProxySession` before managed endpoint rewriting and
   retain the value as immutable request context.
3. Continue mapping v2 to compact management policy while preserving its `/v1/responses` wire route,
   body, model, cache fields, and relevant beta headers.
4. Add nullable `compaction_version` to `message_request` and `usage_ledger`; permitted new values are
   `v1` and `v2`. Null means ordinary request or historically unknown.
5. Add the version to message creation, request detail/list APIs, usage hydration, exports, and
   decision-chain context.
6. For historical display only:
   - infer v2 when retained evidence conclusively contains the exact original marker;
   - classify a direct compact wire request with no v2 evidence as v1;
   - otherwise display version unknown;
   - never write inferred values back in bulk.
7. Add i18n labels for remote compaction v1, remote compaction v2, and unknown version in zh-CN,
   zh-TW, en, ja, and ru. Use the existing ordinary request record layout.

## Phase 2: Collect and Validate Before Commitment

1. Introduce a dedicated explicit-compaction collector and validator under the proxy boundary. Keep
   request classification, bounded byte collection, protocol parsing, canonical-item resolution,
   and validation-result types separated so they can be tested independently.
2. Route explicit compaction through upstream HTTP even when Responses WebSocket is enabled. Preserve
   the current ingress behavior; only the upstream choice is constrained.
3. Collect JSON or SSE into a bounded raw-byte buffer while applying:
   - existing first-byte timeout;
   - existing idle timeout;
   - `REMOTE_COMPACTION_VALIDATION_TIMEOUT_MS`, default 600000, range 60000 to 1800000;
   - `REMOTE_COMPACTION_MAX_RESPONSE_BYTES`, default 16777216, range 1048576 to 67108864;
   - the remaining logical total budget.
4. Parse a separate view without changing the raw bytes. The validator returns a typed result with:
   - valid, invalid, overflow, timeout, aborted, or bypassed outcome;
   - transport and version;
   - successful terminal evidence;
   - canonical compaction identity;
   - normalized usage when present;
   - safe structural evidence and an internal reason enum.
5. For JSON, require the version-appropriate successful response and count only output items whose
   exact type is `compaction`. Require exactly one and require non-empty string `encrypted_content`.
   Do not require optional timestamps or usage.
6. For SSE:
   - require a successful terminal completion and reject failed, incomplete, or malformed streams;
   - collect candidates from `response.output_item.done` and terminal
     `response.completed.response.output`;
   - deduplicate matching representations by item ID or output index;
   - accept an item present in only one source;
   - reject different payloads or identities for the same logical item as
     `inconsistent_compaction_output`;
   - reject zero or more than one canonical compaction item.
7. Reject present identity fields that contradict the request or response form. Do not reject absent
   noncritical metadata.
8. After validation and billing commitment, build the downstream response from the original bytes.
   Preserve content type, JSON formatting, SSE event order, and payload fields. Strip hop-by-hop
   headers and recompute transfer-related headers as the existing proxy requires.
9. Add `REMOTE_COMPACTION_VALIDATION_ENABLED`, default true, as an environment-only emergency switch.
   When false, mark the request and attempt as bypassed and emit an operational warning. Do not add a
   user or administrator shadow mode.

Suggested internal invalid reasons:

- `malformed_compaction_response`
- `missing_successful_terminal`
- `failed_compaction_terminal`
- `missing_compaction_output`
- `multiple_compaction_outputs`
- `empty_compaction_encrypted_content`
- `inconsistent_compaction_output`
- `conflicting_compaction_identity`

These are sanitized evidence values, not necessarily separate public client codes.

## Phase 3: Add Serial Compaction Routing

1. Add an explicit-compaction execution branch in `ProxyForwarder` that reuses the existing Provider
   selector, request construction, endpoint pools, ordinary error classifier, and response handler,
   but disables Hedge, Discovery, and Responses upstream WebSocket.
2. Add `REMOTE_COMPACTION_TOTAL_TIMEOUT_MS`, default 1800000, range 60000 to 7200000. Start it once
   per logical request and pass the remaining time to every attempt. Retain
   `MAX_PROVIDER_SWITCHES = 20` as the second upper bound.
3. Preserve existing cache affinity for initial Provider selection unless the matching Provider and
   version have active compaction capability memory. A pre-existing pending-pricing state does not
   independently displace this initial selection.
4. On an initial Provider contract violation:
   - persist and charge returned usage first;
   - recheck spend limits;
   - retry exactly once on the same Provider Endpoint with identical model, serialized request body,
     cache parameters, and relevant headers;
   - do not consult `maxRetryAttempts` for this contract retry.
5. If the fixed retry also violates the contract, create a Compaction Capability Gap. A stable core
   signal that explicitly proves unsupported compaction creates the gap immediately.
6. When `allowNonConversationEndpointProviderFallback` is true, choose an otherwise eligible Provider
   not yet attempted by this logical request. Each fallback Provider gets one contract-validation
   attempt and then becomes a gap on violation; its non-contract failures still use ordinary retry
   policy. When false, terminate after the initial Provider's fixed retry.
7. Feed every non-contract error back into the existing routing classification:
   - request-terminal stops;
   - deterministic rectification retains its existing changed-request rule;
   - Endpoint Capability Gap advances according to existing endpoint policy;
   - Provider Capability Gap switches without circuit accounting;
   - Provider failure retains configured retry and general circuit behavior.
8. Response overflow skips the same-Provider contract retry, may switch Provider, and writes no
   circuit or capability state. Validation or total timeout uses ordinary timeout ownership and does
   not create capability memory.
9. Stop before starting another attempt when the client disconnects, the total deadline expires,
   Provider count is exhausted, fallback is disabled, billing cannot commit, pricing is pending, or a
   spend recheck denies further work.

## Phase 4: Remember Version-Specific Capability

1. Add a Redis-backed capability store and lease keyed by Provider ID plus `v1` or `v2`. Do not key
   by Endpoint or model, and do not share state between versions or ordinary traffic.
2. Write memory only for:
   - a contract violation that remains after the initial Provider's fixed retry;
   - one contract violation from a fallback Provider;
   - a stable structured core signal that explicitly proves compaction unsupported.
3. Never learn from a generic 404, fuzzy provider text, transport failure, timeout, 429, 5xx,
   overflow, client abort, or incomplete response.
4. Use the Provider's configured circuit-open duration as TTL, or thirty minutes when it has none.
5. On expiry, acquire one lease for a capability probe. Other concurrent requests skip that Provider
   without waiting; they use an alternative or return capability exhaustion. Successful validated
   output clears the state, while a qualifying failed probe follows its permitted retry and renews
   the full TTL.
6. On Redis failure, fail open: continue in-request validation, retry, fallback, and billing without
   cross-request memory or probe single-flight. Emit `compaction_capability_cache_unavailable`.
7. Clear matching capability memory after Provider type, URL, credential or authentication,
   re-enable, model support, or compatibility edits and after administrator health or circuit reset.
   Do not clear on pricing, weight, priority, or quota changes.
8. Extend existing Provider status and decision-chain UI for administrators with Provider ID,
   version, reason, creation, expiry, active probe, and audited manual clear. Do not expose global
   Provider capability state to ordinary users.

## Phase 5: Persist Every Usage-Bearing Attempt

1. Extend `src/drizzle/schema.ts` and generate the migration with `bun run db:generate`. Do not write
   the SQL migration manually.
2. Add `usage_attempt_ledger` with at least:
   - immutable row ID, `request_id`, and `attempt_ordinal` with a unique composite constraint;
   - actual Provider ID, Provider Endpoint ID, resolved model, and compaction version;
   - normalized input, output, cached, cache-creation, reasoning, and total usage fields supported by
     existing billing;
   - usage evidence source and whether upstream returned usage;
   - attempt timestamp, pricing effective timestamp, price source and snapshot, saved group and user
     multipliers, currency-normalized cost, and pricing state;
   - validation outcome and reason, response bytes, transport, completion time, and safe diagnostics;
   - creation and last-update timestamps needed for idempotency and recovery.
3. Initially write this table only for Explicit Compaction Requests. Do not migrate `hedgeLosers` or
   change ordinary request billing in the same rollout.
4. Persist one attempt row for every real upstream attempt. For a usage-bearing attempt, execute one
   idempotent transaction that:
   - inserts the attempt row for its fixed ordinal, or verifies the existing identical commitment;
   - resolves the price effective at the attempt timestamp and applies saved attempt-time multipliers;
   - recomputes the logical `usage_ledger` token and cost projection from committed attempt rows;
   - commits before any next upstream attempt or final successful delivery.
5. Never use an in-memory `+=` result as the durable aggregate. A duplicate attempt commitment must
   not change totals. Conflicting data for an existing ordinal is an integrity error and stops the
   request.
6. Add explicit logical billing state to `usage_ledger`:
   - `in_progress` permits recomputation only from immutable attempt evidence;
   - `sealed` is final and immutable;
   - ordinary requests continue writing their final sealed row directly.
7. If usage is absent, persist the attempt evidence row with no charge and no logical cost change. Do
   not estimate tokens, create a fee sentinel, or add a charge.
8. If usage exists but the attempt-time price cannot be resolved:
   - persist normalized raw usage, attempt-time pricing evidence, and saved multipliers as
     `pricing_pending`;
   - stop routing and withhold even a valid response;
   - alert administrators and return `billing_pricing_unavailable`;
   - reconcile only from historical effective pricing or an explicit administrator-supplied backfill
     price, then seal the charge permanently.
9. Retry transient database failures a finite number of times. If the attempt and logical projection
   cannot be committed, stop with `billing_persistence_unavailable` and start no more upstream work.
10. After every committed charge, recheck User, Key, and actual Provider spend limits before routing
    continues. User or Key exhaustion stops immediately. Provider exhaustion excludes that Provider
    from further work and allows fallback only when configured. Never roll back committed cost.
11. On final success, failure, overflow, timeout, capability exhaustion, billing stop, or client abort,
    recompute from attempt evidence, save final request outcome and routing attribution, and seal the
    logical usage row.
12. Add startup and periodic recovery for stale `in_progress` rows. A row becomes stale after its
    total routing timeout plus five minutes since last activity. Recovery recomputes, seals failed,
    logs an administrator event, and never resumes upstream work or refunds usage.

## Phase 6: Correct Reporting and User Experience

1. Change compact endpoints from categorically nonbilling to conditional attempt billing: returned
   usage is billable, while absent usage remains zero.
2. Keep User, Key, and global spend, quota, and request-list cost sourced from the logical
   `usage_ledger` aggregate. This makes all attempt cost visible once without increasing request count.
3. Source Provider compaction tokens, cost, and attempt count from `usage_attempt_ledger` grouped by
   actual Provider. Exclude explicit-compaction logical aggregates from Provider totals to prevent
   attribution to only the final Provider and prevent double counting.
4. Keep logical request count and success-rate calculations on the request record. A failed request
   may display a non-zero cost and multiple Provider attempts.
5. Show the version directly in the user's existing request list and detail UI. Show attempt chain,
   final error, and aggregate charge under the same visibility rules as an ordinary request.
6. Extend management APIs, OpenAPI schemas, generated client types, exports, and all five translation
   catalogs for version, billing states, capability status, stable errors, and manual clear.
7. Emit metrics for classification, validation outcome and duration, bytes buffered, same-Provider
   retry, Provider switch, capability memory and probes, billing persistence, pending pricing,
   recovery, and attempt cost. Keep metric labels bounded; do not include model input or opaque output.

## Client Error Map

| Terminal condition | HTTP | Stable code |
| --- | ---: | --- |
| Invalid response with no permitted Provider switch | 502 | `remote_compaction_invalid_response` |
| All eligible Providers have a compaction capability gap | 503 | `provider_capability_unavailable` |
| All terminal candidates exceeded response size | 502 | `remote_compaction_response_too_large` |
| Validation timeout or total routing deadline | 504 | `remote_compaction_timeout` |
| Attempt billing cannot be persisted | 503 | `billing_persistence_unavailable` |
| Returned usage cannot be priced | 503 | `billing_pricing_unavailable` |

Use the existing protocol-compatible error envelope. Return safe wording only and never include raw
Provider response data, `encrypted_content`, message content, or internal validation density.

## Test Plan

New behavior must have at least 80% unit coverage. Add focused unit tests and forwarder, repository,
integration, API, and UI tests for the following mandatory cases.

### Classification and retention

1. Direct normalized `/v1/responses/compact` is v1.
2. `/v1/responses` with one exact top-level `compaction_trigger` object or array item is v2.
3. Nested, string, replay `compaction`, unrelated, and future marker types are not v2.
4. The beta header alone is not v2; a matching request remains v2 without the header.
5. `context_management` on an ordinary Responses request is not explicit compaction.
6. v2 keeps the wire path and body while using compact management policy.
7. New request, logical usage, and attempt rows retain v1/v2 after request content expires.
8. Historical inference returns v1, v2, or unknown only under the documented evidence rules.

### JSON and SSE validation

9. An output array containing user messages plus exactly one non-empty compaction item is valid.
10. The reported production shape with two output items and zero compaction items is rejected.
11. Zero items, zero compaction items, two compaction items, empty or non-string encrypted content,
    malformed JSON, and contradictory identity are rejected with the correct internal reason.
12. Optional metadata may be absent; present conflicting identity metadata is rejected.
13. SSE requires a successful terminal event and rejects failed, incomplete, malformed, and idle
    streams.
14. Matching `output_item.done` and terminal-output views deduplicate to one item.
15. An item in only one SSE view remains valid; mismatched payload or identity is rejected.
16. Valid output preserves exact JSON bytes or SSE event order and strips only required transport
    headers.
17. Validation bypass is environment-only and records `bypassed`, never `validated`.
18. The size and validation time limits accept boundary values and reject out-of-range configuration.

### Routing and capability

19. Initial contract violation retries the same Provider Endpoint exactly once with byte-equivalent
    request body, model, cache settings, and headers before switching.
20. The initial Provider's configured retry count neither removes nor increases the fixed contract
    retry; every fallback Provider receives no additional contract retry. Non-contract errors retain
    ordinary configured retry behavior on both initial and fallback Providers.
21. With fallback disabled, two initial contract violations return 502 invalid response.
22. With fallback enabled, a valid untried Provider succeeds; attempted Providers are not revisited.
23. Cache affinity wins initial selection unless matching Provider ID plus version capability memory
    is active.
24. Contract violations write no general circuit failure. Non-contract errors retain existing error
    ownership, retry, fallback, and circuit behavior.
25. Overflow skips the same-Provider retry and capability memory but may fall back. All-overflow
    termination uses the size error.
26. Validation and total timeout do not write capability memory and return the timeout contract.
27. Explicit compaction never starts Hedge, Discovery, or upstream Responses WebSocket.
28. Capability memory is isolated by Provider ID and v1/v2, uses Provider circuit duration or the
    thirty-minute default, and ignores Endpoint/model differences.
29. Generic 404, fuzzy text, network, 429, 5xx, overflow, timeout, incomplete response, and abort do
    not create capability memory.
30. Expiry permits one leased probe; concurrent requests skip without waiting. Success clears memory
    and qualifying failure renews it.
31. Redis outage fails open and logs `compaction_capability_cache_unavailable` while in-request
    behavior remains correct.
32. Capability-relevant Provider edits and admin reset clear memory; price, weight, priority, and
    limit edits do not.

### Billing, limits, and recovery

33. A valid, invalid, retried, fallback, or final-failure attempt is charged whenever it returns
    usage. An attempt without usage contributes no estimated cost.
34. Two or more usage-bearing attempts produce one logical aggregate with the sum of independently
    priced attempts and one user request count.
35. Attempt pricing uses its actual Provider, Endpoint, model, cache usage, attempt-time price, and
    saved multipliers rather than final-Provider or latest pricing.
36. Repeating the same request ID and attempt ordinal is idempotent; conflicting evidence stops with
    an integrity failure and does not change totals.
37. Attempt insert and logical recomputation are atomic. A persistence failure blocks the next
    upstream attempt and final delivery.
38. A pricing miss persists `pricing_pending`, blocks routing and delivery, alerts administrators,
    and resolves only with effective historical pricing or explicit backfill.
39. User and Key spend exhaustion stops after the committed attempt. Provider exhaustion excludes
    that Provider and switches only when allowed. Committed cost is retained.
40. Provider reports source compaction cost and tokens from attempt rows; User, Key, and global reports
    source logical aggregates with no double counting.
41. Final success, failure, timeout, overflow, capability exhaustion, billing error, and abort all seal
    the recomputed logical aggregate.
42. Startup and periodic recovery seal stale rows idempotently without new upstream calls or refunds.
43. A pre-existing pending-pricing state does not bypass the cache-affine initial selection, while a
    new unpriceable attempt stops its own logical request.

### Abort, security, API, and UI

44. Client abort cancels the active fetch and prevents every later retry or switch. Already received
    usage is charged; incomplete response evidence creates no capability gap.
45. Public errors use the client's protocol shape and stable code without Provider or raw response
    content.
46. Logs, database evidence, metrics, exports, and UI never contain `encrypted_content`, messages,
    reasoning, or tool arguments from validation.
47. User request list/detail visibly distinguishes v1 and v2 while retaining ordinary request
    status, chain, and aggregate cost behavior.
48. Administrator capability status shows Provider ID plus version, reason, timestamps, probe state,
    and audited manual clear; ordinary users cannot read global capability state.
49. REST/OpenAPI schemas and generated clients represent nullable historical version, billing state,
    capability status, and stable errors consistently.
50. All user-facing strings exist and render in zh-CN, zh-TW, en, ja, and ru.

At least one integration test must exercise the real classifier, collector, validator, billing
transaction, and serial forwarder together. Do not satisfy the critical regression only with mocked
classification or a validator-only test.

## Delivery Order

1. Land request identity and read-only display plumbing.
2. Land the validator and raw response commitment behind the default-on emergency switch, without
   enabling cross-Provider behavior until billing durability exists.
3. Land schema migration, attempt billing, logical projection, pending pricing, and recovery.
4. Enable fixed same-Provider retry and serial Provider fallback with capability memory.
5. Switch reporting and Provider attribution, then expose administrator capability controls.
6. Complete OpenAPI, generated clients, five-language i18n, metrics, and rollout validation.

The ordering prevents retries from creating upstream usage before attempt billing can commit it.

## Verification

Run focused tests while implementing each phase. Before commit, run the repository checklist and API
contract checks:

```bash
bunx vitest run <affected-test-files>
bun run test:coverage
bun run build
bun run lint
bun run lint:fix
bun run typecheck
bun run test
bun run test:v1
bun run openapi:check
bun run openapi:lint
```

Review generated Drizzle SQL and generated OpenAPI client diffs before applying the migration.

## Completion Criteria

- The original fatal case, "expected exactly one compaction output item, got 0 from 2 output items",
  is blocked before client commitment, billed if it returned usage, retried once on the initial
  Provider, and then switched only under the configured fallback policy.
- A compliant v1 or v2 response reaches the client byte-for-byte after durable billing commitment.
- Every routing, capability, billing, timeout, overflow, abort, and recovery invariant above has a
  passing test with at least 80% coverage for new behavior.
- User and Provider reporting reconcile to attempt evidence without duplicate cost or request count.
- No new validation surface stores opaque compaction content or conversational payloads.
