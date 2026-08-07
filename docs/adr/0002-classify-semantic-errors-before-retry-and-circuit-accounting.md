---
status: accepted
---

# Classify semantic errors before retry and circuit accounting

Upstream request errors may arrive inside an HTTP 200 stream and be wrapped by the proxy as a 502
before any content is committed. Treating that synthetic status as a Provider failure causes the
same invalid request to fan out across Providers and incorrectly opens their circuit breakers. CCH
will determine error ownership from the Public Request Contract and explicit Error Ownership
Evidence before deciding retry, Provider switching, or health accounting.

## Decision

Routing Error Classification produces an explicit Routing Disposition:

- A Request-Terminal Error stops the request immediately, returns a protocol-compatible 4xx error,
  and never affects Endpoint or Provider health. Context Window Exceeded and Safety Rejection are
  request-terminal. A Core Request Error remains request-terminal regardless of HTTP status,
  administrative configuration, database availability, or rollout mode.
- A Rectifiable Request Error may retry the same Provider once only after a named deterministic
  rectifier changes the request. It never affects circuit state.
- An Endpoint Capability Gap advances to another eligible Provider Endpoint without a health
  penalty. Endpoint exhaustion advances to a Provider Switch.
- A Provider Capability Gap switches Provider without a health penalty. Provider Capability
  Exhaustion returns 503 with the stable code `provider_capability_unavailable`.
- A Provider health failure retains the existing retry, switching, and circuit-accounting policy.

A generic HTTP status or error family such as `invalid_request_error` is not Error Ownership
Evidence. Stable structured protocol codes are maintained as non-configurable Core Request Errors.
Reviewed error rules may also establish ownership, including overriding a real upstream 5xx, but
every rule must declare its Routing Disposition explicitly. Broad defaults such as `invalid request`
will be removed or narrowed. Existing custom rules remain in legacy state until an administrator
reviews them; migration will not silently grant them authority to override 5xx responses.

The Stream Content Gate reports a Precommit Stream Error with its original frame and source. It does
not decide business ownership or routing behavior. Before Response Commitment, a Request-Terminal
Error cancels all concurrent attempts and takes precedence over uncommitted candidates. After
commitment, the client response is immutable; later loser errors are recorded without circuit
penalties. A terminal request also cancels hedge losers instead of draining them solely for billing.

Client errors follow the Client Error Contract: configured response-body overrides remain allowed,
but request-terminal status overrides must remain 4xx. Raw Provider bodies are not newly exposed.
Safety Rejections remain terminal so automatic Provider switching cannot bypass a safety policy.

## Considered Options

- Keep HTTP 5xx precedence. Rejected because both locally synthesized 502 responses and contradictory
  upstream 5xx responses can contain conclusive request-error evidence and otherwise poison every
  Provider circuit.
- Treat every `invalid_request_error` as terminal. Rejected because errors such as `Invalid URL
  (POST /v1/alpha/search)` prove an Endpoint or Provider capability gap, not an invalid client
  request.
- Automatically migrate all existing custom rules to request-terminal. Rejected because those rules
  were authored under status-first precedence and would silently gain authority over real 5xx
  responses.
- Add per-request token counting to this repair. Rejected as a separate feature requiring
  model-specific tokenizers and accounting for tools, images, and other modalities.

## Consequences

- Error rules require a generated Drizzle migration, API and UI changes, five-language i18n, and a
  complete audit of built-in rules.
- General rule dispositions roll out through `legacy`, `shadow`, and `enforce` modes. Core Request
  Errors are enforced in every mode. Promotion from shadow is manual and evidence-based.
- Logs and Provider decision chains record disposition, evidence source, original and client status,
  matched core code or rule ID, retry and switch decisions, and circuit-accounting outcome. Existing
  sanitized and truncated diagnostics remain the only location for raw upstream text.
- Existing circuit states are not reset automatically.
