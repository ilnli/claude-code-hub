# Semantic Error Routing Repair Plan

## Outcome

Prevent request-owned failures from being retried across Providers or counted against Endpoint and
Provider circuit breakers. Preserve failover for Endpoint and Provider capability gaps and preserve
existing health handling for actual Provider failures.

The production regression used as the primary acceptance case is a stream error frame containing:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "code": "context_length_exceeded",
    "message": "Your input exceeds the context window of this model.",
    "param": "input"
  }
}
```

Today the Stream Content Gate wraps this frame in a local 502, status precedence classifies it as a
Provider failure, and the forwarder retries and opens circuits. The repaired path must return one
client-compatible 400 response without another upstream attempt or any health penalty.

## Scope

Included:

- Semantic classification for streaming and non-streaming errors, including real and synthetic 5xx
  responses when conclusive ownership evidence exists.
- Explicit routing dispositions for built-in and administrator-defined error rules.
- Endpoint-before-Provider fallback for capability gaps.
- Sequential, hedged, discovery, and reactive-rectifier execution parity.
- Protocol-compatible client errors, observability, management UI, API, migration, and i18n.
- Staged `legacy`, `shadow`, and `enforce` rollout.

Excluded:

- Per-request token counting or model-specific tokenizer integration.
- Automatic clearing of existing Endpoint or Provider circuit state.
- Persistent learning of Provider capabilities from one failed request.
- Additional storage of raw upstream error bodies.

## Routing Invariants

| Disposition | Same Endpoint | Same Provider | Other Provider | Health accounting | Client result |
| --- | --- | --- | --- | --- | --- |
| `request_terminal` | Stop | Stop | Stop | None | Protocol error, 4xx |
| Rectifiable request | One changed request | No further retry | Stop | None | Retry result or 4xx |
| `endpoint_capability_gap` | Stop | Next Endpoint | Then switch | None | Result or capability exhaustion |
| `provider_capability_gap` | Stop | Stop | Switch | None | Result or capability exhaustion |
| `provider_failure` | Existing policy | Existing policy | Existing policy | Existing policy | Existing final error |

Provider Capability Exhaustion returns HTTP 503 with code `provider_capability_unavailable`.

## Phase 1: Emergency Core Protection

1. Add a structured error-envelope parser and core registry in a focused module such as
   `src/app/v1/_lib/proxy/routing-error-classifier.ts`.
   - Parse stable fields from Claude, OpenAI, Responses, and Gemini error envelopes.
   - Use exact structured paths and values for core evidence; never use a generic error type as a
     core signal.
   - Register `context_length_exceeded` as the initial mandatory Core Request Error.
   - Keep the registry in code so database and cache failures cannot disable it.
2. Mark Stream Content Gate failures with explicit origin metadata.
   - Preserve `frameData` for the existing sanitized diagnostic path.
   - Distinguish upstream transport status from a locally synthesized carrier status.
   - Avoid importing `StreamPrecommitError` into `errors.ts`; use shared metadata or classifier
     input to prevent a module cycle.
3. Run core semantic classification before HTTP status precedence in `categorizeErrorAsync` or its
   replacement.
   - Core evidence overrides real and synthetic 5xx responses.
   - Client abort, local admission failure, and native transport errors retain source-aware handling.
   - Unproven errors continue through existing status-based behavior.
4. Return the Client Error Contract for a core terminal error.
   - Default to HTTP 400.
   - Preserve `context_length_exceeded` as the stable client code.
   - Use the client's original protocol format and a safe message.
   - Allow configured response-body overrides, but reject terminal status overrides outside 4xx.
5. Stop all retry and health side effects.
   - Do not call Endpoint or Provider `recordFailure` functions.
   - Do not tombstone affinity as a health failure.
   - Do not add the Provider to a failure set that triggers Provider Switch.
   - Record a request-terminal decision-chain entry and finish the request.
6. Apply the same terminal signal to hedged and discovery attempts.
   - Before Response Commitment, cancel all other attempts immediately.
   - Do not drain losers only to collect billing usage; retain usage already observed.
   - After commitment, keep the successful response and record late loser errors without penalties.

Phase 1 is enforced immediately and is not controlled by the general rollout mode.

## Phase 2: Explicit Rule Dispositions

1. Extend `src/drizzle/schema.ts` with a nullable `routing_disposition` on `error_rules`.
   Supported reviewed values are:
   - `request_terminal`
   - `endpoint_capability_gap`
   - `provider_capability_gap`
   - `provider_failure`
2. Generate the migration with `bun run db:generate`; do not author SQL manually.
3. Preserve compatibility during migration.
   - Built-in rules receive an audited explicit disposition.
   - Existing custom rules remain null and therefore use legacy precedence.
   - New rules require an explicit disposition.
   - Editing a legacy custom rule requires the administrator to choose a disposition.
4. Propagate the field through:
   - `src/repository/error-rules.ts`
   - `src/lib/error-rule-detector.ts`
   - Server Actions and REST/OpenAPI schemas
   - generated API client types
   - error-rule test and cache-refresh responses
   - the management UI and all five locale catalogs
5. Validate status overrides against disposition.
   - Request-terminal rules accept only 4xx overrides.
   - Runtime validation must defend against manually corrupted database rows.
   - Capability and Provider-failure rules may retain 5xx overrides.

## Phase 3: Unified Classifier and Execution Policy

1. Replace the status-only enum result with a structured classification result containing:
   - disposition
   - evidence source and source kind
   - core code or matched rule ID
   - original transport status and synthetic status
   - client status and stable client code
   - legacy versus shadow versus enforced result
2. Give the classifier request context.
   - Public model availability and normalized endpoint determine whether `model_not_found` is a
     request error or capability gap.
   - A legal endpoint rejected as `Invalid URL (METHOD /path)` is an Endpoint Capability Gap.
   - A valid feature unsupported across one Endpoint pool is a Provider Capability Gap.
3. Centralize disposition execution so sequential and hedged paths cannot drift.
   - `request_terminal`: terminate the request.
   - `endpoint_capability_gap`: exclude only the current Endpoint and advance within its pool.
   - `provider_capability_gap`: exclude the current Provider for this request and switch.
   - `provider_failure`: preserve existing retries, affinity handling, and circuit accounting.
4. Preserve named reactive rectifiers as a pre-terminal exception.
   - Retry once only when the rectifier changes the request.
   - Never count the failed pre-rectification attempt against a circuit.
   - A non-applicable or failed rectifier falls through to its final disposition.
5. Implement capability exhaustion as a first-class terminal outcome rather than "all Providers
   failed."

## Phase 4: Audit Built-In Rules

Audit every entry in `DEFAULT_ERROR_RULES`; each rule needs ownership evidence, an explicit
disposition, a positive test, and a counterexample test.

Required changes include:

- Remove or narrow the generic `非法请求|illegal request|invalid request` default. The error family
  alone is not ownership evidence.
- Keep hard context-window limits, malformed request structures, tool/message relationship errors,
  hard media limits, and Safety Rejections request-terminal when the rule proves violation of the
  Public Request Contract.
- Classify `pricing plan does not include Long Context` as a Provider Capability Gap.
- Classify `Invalid URL (METHOD /path)` for a public endpoint as an Endpoint Capability Gap.
- Resolve model errors against the public model set: invalid public model is request-terminal;
  current Endpoint or Provider model absence is a capability gap.
- Keep deterministic thinking rectifiers separate from terminal rules.
- Mark genuine storage, authentication, transport, and service failures as Provider failures unless
  a more specific ownership rule proves otherwise.

Do not infer routing behavior from display category names.

## Phase 5: Client Contract and Observability

1. Add a protocol-aware error response builder keyed by `session.originalFormat`.
   - Preserve stable codes and safe messages.
   - Apply valid administrator response overrides first.
   - Never newly expose Provider identity or raw Provider response bodies.
2. Extend decision-chain and structured log data with:
   - routing disposition
   - error origin
   - original, synthetic, and client status
   - core code or matched rule ID
   - retry, Endpoint switch, Provider switch, and circuit-accounting decisions
3. Show the same structured classification in the management log UI.
4. Add metrics for classification counts, shadow differences, degraded rule loading, prevented
   circuit writes, capability switches, and capability exhaustion.
5. Reuse the existing sanitized and truncated upstream-body field for diagnostics. Do not copy raw
   text into new metrics or columns.

## Phase 6: Rollout Modes

1. Add a system setting with `legacy`, `shadow`, and `enforce` values.
   - `legacy`: old behavior for non-core and unreviewed rules.
   - `shadow`: compute old and new outcomes, execute old non-core behavior, and record differences.
   - `enforce`: execute reviewed rule dispositions.
   - Core Request Errors are enforced in all modes.
2. Keep the last successfully loaded rule snapshot when refresh fails.
   - If no snapshot has ever loaded, core classification remains available and other errors use
     legacy status behavior.
   - Emit `classification_degraded` logs and metrics.
3. Deploy Phase 1 protection immediately, then deploy the general classifier in shadow mode.
4. Promote to enforce manually only after:
   - every built-in rule has been reviewed;
   - enabled legacy custom rules have been reviewed or explicitly left on legacy behavior;
   - unit, integration, hedge, UI, API, and migration tests pass;
   - a complete business cycle includes real samples for request-terminal, capability-gap, and
     Provider-failure outcomes;
   - every material shadow difference is explained;
   - rollback to legacy has been exercised.
5. Do not automatically reset existing circuit state during any rollout phase.

## Test Plan

Add focused unit and integration coverage with at least 80% coverage for all new behavior.

Mandatory cases:

1. The production `context_length_exceeded` SSE frame wrapped as local 502 becomes
   request-terminal, returns 400, makes one upstream attempt, and performs no circuit write.
2. A real upstream 500 or 502 with the same structured core code is also request-terminal.
3. A real 5xx containing only generic `invalid request` remains a Provider failure.
4. A reviewed specific request-terminal rule overrides a real 5xx only in enforce mode; shadow logs
   the difference without changing execution.
5. A legacy custom rule retains status-first behavior after migration.
6. `Invalid URL (POST /v1/alpha/search)` advances Endpoint, then Provider, without circuit writes.
7. Malformed JSON and proven public-contract parameter errors terminate without fallback.
8. A legal parameter unsupported only by the current Provider produces a capability gap.
9. Safety Rejection terminates and does not switch Provider.
10. Public-model validation distinguishes an invalid requested model from Endpoint and Provider
    model capability gaps.
11. A rectifier retries exactly once only after changing the request.
12. In a hedge, a precommit terminal error cancels uncommitted candidates and skips loser draining.
13. After Response Commitment, a late loser terminal error cannot replace success and cannot affect
    circuits.
14. Capability exhaustion returns 503 `provider_capability_unavailable` without health penalties.
15. Rule-cache cold-start failure preserves core behavior and emits degraded observability.
16. Terminal rules reject 5xx status overrides in API, Server Action, UI, and runtime validation.
17. Protocol-compatible error bodies are correct for Claude, OpenAI Chat, Responses, and Gemini.

Do not repeat the existing stream-gate integration test pattern that mocks
`categorizeErrorAsync` to `PROVIDER_ERROR`; at least one end-to-end forwarder test must exercise the
real classifier and real error frame.

## Verification

Run focused tests during each phase, then the repository checklist before commit:

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

Review generated migration SQL and generated OpenAPI client changes before applying the migration.

## Completion Criteria

The repair is complete when the production regression cannot cause a second upstream attempt or a
circuit write; all reviewed dispositions behave identically in sequential and concurrent paths;
capability gaps retain non-penalizing fallback; client contracts and five-language UI are complete;
shadow evidence supports manual enforce promotion; and existing circuit state remains untouched.
