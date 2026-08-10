---
status: accepted
---

# Validate, route, and bill explicit compaction as one logical request

CCH already recognizes Codex remote compaction v2 and preserves its wire request, but a successful
HTTP response can still reach the client without proving that it contains a usable compaction item.
We will treat standalone compaction and Codex remote compaction v2 as versioned Explicit Compaction
Requests: buffer and validate their complete upstream result before client commitment, route contract
failures without poisoning general Provider health, and charge every upstream attempt that reports
usage while retaining one logical user request.

The public OpenAI contract distinguishes the standalone `POST /responses/compact` operation from
threshold-triggered server-side compaction on `POST /responses`. The standalone response contains
the input items followed by one compaction item, so validation counts logical `type: "compaction"`
items rather than requiring the entire `output` array to have length one. The public documentation
does not define the Codex `compaction_trigger` protocol; CCH therefore follows the exact classifier
introduced by commit `191bb19a`: a `/v1/responses` request with an exact top-level input item whose
type is `compaction_trigger`.

References:

- [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI compact endpoint reference](https://developers.openai.com/api/reference/python/resources/responses/methods/compact)

## Decision

### Request identity and records

- Remote compaction v1 is CCH's display name for a direct `/v1/responses/compact` request. It is not
  presented as an official OpenAI version name.
- Remote compaction v2 is `/v1/responses` with an exact top-level `compaction_trigger` input object,
  whether `input` is one object or an array. A beta header is preserved but never establishes the
  classification. Nested, string, replay `compaction`, and future-looking markers do not match.
- A normal Responses request with `context_management` remains outside this decision because the
  configured threshold may legitimately not trigger compaction.
- New request, logical usage, and attempt usage records persist `v1` or `v2` from the original wire
  request. Historical records are inferred only from conclusive retained evidence; otherwise their
  version is unknown. There is no speculative bulk backfill.
- Users see one ordinary request record with an explicit compaction version and the usual status,
  error, Provider chain, and cost presentation.

### Response commitment and validation

- An Explicit Compaction Request uses HTTP JSON or SSE upstream transport. It does not use the
  Responses upstream WebSocket path, Hedge, or Discovery.
- CCH buffers the complete upstream result before exposing any body bytes to the client. The result
  is valid only when its version and transport indicate successful completion and establish exactly
  one logical `type: "compaction"` item with a non-empty string `encrypted_content`.
- For SSE, `response.output_item.done` and the terminal `response.completed.response.output` may
  each represent the item. Matching identity by item ID or output index deduplicates the two views;
  their identity and opaque payload must agree. Either view alone is sufficient, while contradictory
  views are `inconsistent_compaction_output`.
- Malformed JSON or SSE, missing or failed terminal completion, zero or multiple logical compaction
  items, empty encrypted content, and contradictory identity fields are contract violations.
  Optional metadata such as `usage` or `created_at` is not required, but a present identity field
  must not contradict the request or response form.
- After validation and billing commitment, CCH sends the original JSON or SSE bytes and event order.
  It does not reserialize, enrich, repair, or convert between v1 and v2. Only normal hop-by-hop and
  recomputed transfer headers may change.
- Validation is enforced by default. An environment-only emergency switch may bypass it, and every
  bypass is recorded as `bypassed`, never `validated`; there is no user-facing shadow mode.

### Serial routing and capability memory

- A contract violation from the initially selected Provider receives exactly one cache-preserving
  retry on the same Provider Endpoint with the same model, request content, and cache parameters.
  This fixed retry does not inherit the Provider's configurable retry count.
- If the second result still violates the contract, CCH classifies a version-specific Compaction
  Capability Gap and may switch Provider. Each fallback Provider receives one contract-validation
  attempt and no cache-preserving contract retry; non-contract errors still use ordinary retry
  policy. Explicit, core-classified evidence that the Provider does not support compaction can
  establish the gap without the retry.
- Initial selection preserves existing cache affinity unless that Provider has an active matching
  compaction capability gap. Fallback chooses an otherwise eligible Provider not yet attempted in
  the current logical request. Existing `allowNonConversationEndpointProviderFallback` controls only
  cross-Provider switching; validation and the initial same-Provider retry always apply.
- Contract violations and Compaction Capability Gaps do not update the general circuit breaker.
  Non-contract errors retain the ordinary request-terminal, rectifier, endpoint capability,
  Provider capability, Provider failure, retry, circuit, and switching behavior.
- The existing limit of twenty attempted Providers remains. A separate total compaction budget is
  thirty minutes by default; no new attempt starts after the deadline, and an active attempt receives
  only the remaining budget.
- A response has a separate default maximum of 16 MiB, configurable from 1 to 64 MiB. Overflow aborts
  the attempt, skips the same-Provider retry, and may switch Provider, but it creates neither circuit
  failure nor capability memory. Validation has a default ten-minute timeout, configurable from one
  to thirty minutes, in addition to existing first-byte and idle timeouts.
- Capability memory is keyed by Provider ID and compaction version. It is written only after the
  permitted contract-validation attempts fail or core structured evidence proves unsupported
  compaction. Generic 404 responses, fuzzy text, network errors, rate limits, and 5xx responses do
  not write it.
- Memory lifetime matches the Provider circuit-open duration or defaults to thirty minutes. After
  expiry, a Redis lease permits one capability probe; concurrent requests skip that Provider rather
  than wait. Probe success restores availability, while a qualifying failure renews the lifetime.
  Redis failure is fail-open for cross-request memory without disabling per-request validation,
  retry, or fallback.
- Provider type, URL, credentials, enablement, model compatibility, and other capability-relevant
  edits clear the memory, as does an administrative health or circuit reset. Pricing, weight,
  priority, and limit edits do not.

### Attempt-level billing and logical accounting

- One Explicit Compaction Request remains one request record and one logical `usage_ledger` record.
  Every real upstream attempt that returns usage is charged to the user, including invalid results,
  retries, fallback attempts, and attempts belonging to a final failed request. An attempt with no
  returned usage is not estimated and creates no charge.
- A new `usage_attempt_ledger` stores one immutable, idempotent evidence row per real upstream attempt,
  keyed by request and attempt ordinal. It is structurally generic but initially receives only
  Explicit Compaction Requests; existing Hedge loser and ordinary-request accounting are not
  migrated into it. An attempt without returned usage remains an evidence row with no charge.
- Each usage-bearing attempt is priced independently from its actual Provider, Endpoint, model,
  cache-token details, attempt-time price snapshot, and saved group and user multipliers. The logical
  record is recomputed from immutable attempt rows rather than incremented blindly.
- Attempt persistence and logical aggregate recomputation form one idempotent transaction. They must
  complete before another upstream attempt starts or a valid final response becomes client-visible.
  Finite database retries are allowed; persistent failure stops routing with
  `billing_persistence_unavailable` and does not initiate more upstream cost.
- The logical aggregate is `in_progress` while routing and becomes immutable when `sealed` on success,
  failure, timeout, or abort. Startup and periodic recovery find rows stale for the request total
  timeout plus five minutes, recompute them from attempt rows, and seal them failed without resuming
  upstream work or refunding usage.
- If usage exists but attempt-time pricing cannot be resolved, the raw normalized usage and pricing
  evidence are persisted as `pricing_pending`; routing and client delivery stop with
  `billing_pricing_unavailable`. Recovery uses pricing effective at the attempt time and the saved
  multipliers. If no historical price exists, an administrator must supply an explicit backfill
  price. A charged attempt is never repriced.
- After each committed charge, CCH rechecks User, Key, and actual Provider spend limits. User or Key
  exhaustion stops with the existing quota result. Current-Provider exhaustion prevents retrying it
  and may switch when fallback is allowed. Already committed charges are never rolled back.
- A pre-existing pending-pricing condition does not displace the cache-affine initial Provider. If a
  new attempt itself cannot be priced, that logical request stops under the rule above.
- User, Key, and global spend and request lists read the logical aggregate. Provider compaction cost,
  tokens, and attempts read attempt rows so every actual Provider is credited. Provider statistics
  exclude the compaction logical aggregate, and attempt rows never add user cost a second time.
- User API call count and success rate remain one logical request. Failed logical requests may still
  have a non-zero cost.

### Abort, errors, and evidence

- Client disconnect aborts the active attempt and stops all future retry and switching. Usage already
  received remains billable; missing usage is not estimated, and an incomplete attempt cannot create
  capability memory.
- Stable client outcomes are:
  - 502 `remote_compaction_invalid_response` when a final contract violation cannot switch Provider.
  - 503 `provider_capability_unavailable` when eligible Provider capability is exhausted.
  - 502 `remote_compaction_response_too_large` when every terminal candidate overflowed.
  - 504 `remote_compaction_timeout` for validation or total-budget expiry.
  - 503 `billing_persistence_unavailable` for unrecoverable billing persistence failure.
  - 503 `billing_pricing_unavailable` when returned usage cannot be priced.
- Client errors use the existing protocol-compatible envelope and do not expose Provider identity,
  raw response content, encrypted content, or density details.
- Request history and administrative status retain safe structural evidence only: version,
  transport, reason enum, output counts and types, byte count, validation duration, Provider attempt,
  retry, and switch. Message text, reasoning, tool arguments, complete responses, and
  `encrypted_content` are never persisted as validation evidence.
- Administrators can see Provider ID plus v1/v2 capability reason, creation and expiry, active probe,
  and a manual clear action in existing status and decision-chain surfaces. Ordinary users see only
  the routing information belonging to their own request.

## Considered Options

- Require `output.length === 1`. Rejected because the official standalone response can include user
  input items followed by one compaction item; the relevant invariant is one logical compaction item.
- Validate the complete upstream schema. Rejected because nonessential metadata can differ across
  compatible Providers; CCH requires only the client-consumable semantic contract.
- Stream bytes to the client while validating. Rejected because a later missing or duplicate
  compaction item cannot be retried after response commitment.
- Switch Provider immediately on the first invalid result. Rejected because the retry may reuse the
  original Provider cache while a switch can invalidate that cache.
- Count compaction contract failures as general Provider failures. Rejected because compaction
  compatibility is version-specific and does not prove ordinary traffic is unhealthy.
- Use Hedge or Discovery to reduce latency. Rejected because concurrent attempts create avoidable
  compaction charges and conflict with cache-preserving retry order.
- Bill only the successful attempt or absorb retry cost. Rejected because CCH must pass through every
  upstream usage report and must not assume an invalid response was free.
- Store attempt charges only in request JSON or reuse Hedge loser storage. Rejected because billing
  evidence needs relational uniqueness, crash recovery, per-Provider attribution, and an auditable
  immutable source without migrating unrelated accounting in this change.
- Deliver a valid compaction result before attempt billing is durable. Rejected because a persistence
  outage would create an uncollectable charge and could permit more untracked upstream attempts.

## Consequences

- Explicit compaction has higher latency and memory or temporary-storage pressure because the full
  result is committed only after validation and billing persistence.
- A failed client request may legitimately display a non-zero charge. UI and API consumers must not
  infer zero cost from failure status.
- The schema, billing repositories, spend-limit queries, statistics, recovery jobs, Provider status,
  request history, REST/OpenAPI contracts, and all five locale catalogs require coordinated changes.
- Schema migrations must be generated from `src/drizzle/schema.ts` with `bun run db:generate`; no SQL
  migration is authored manually.
- Redis becomes an optimization and single-flight mechanism for learned compaction capability, not a
  correctness dependency.
- The validation path must preserve raw response bytes while separately parsing a bounded copy for
  semantic checks and usage extraction.
