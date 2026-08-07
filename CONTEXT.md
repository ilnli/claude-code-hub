# Provider Routing

This context defines how providers compete for routed requests and how relative cost informs
routing policy.

## Language

**Provider**:
A concrete routable API credential and configuration record.
_Avoid_: Provider Vendor, vendor

**Provider Vendor**:
A vendor entity that groups Providers by official website domain.
_Avoid_: Provider, API credential

**Provider Type**:
The API protocol or format implemented by a Provider, such as Claude, Codex, Gemini, or
OpenAI-compatible.
_Avoid_: Vendor, brand

**Provider Endpoint**:
A concrete upstream base URL eligible within a Provider Vendor and Provider Type endpoint pool.
_Avoid_: Provider, Provider Vendor

**Endpoint Capability Gap**:
A Provider Endpoint-specific inability to serve a request that is valid under the Public Request
Contract. Another eligible Provider Endpoint may still serve it without any health penalty.
_Avoid_: Provider Capability Gap, Endpoint outage

**Provider Capability Gap**:
A Provider-specific inability to serve a request that is valid under the Public Request Contract.
The request may move to another Provider without treating the gap as a Provider health failure.
_Avoid_: Request-Terminal Error, Provider outage

**Provider Capability Exhaustion**:
The state in which a request is valid under the Public Request Contract but every eligible Provider
has a Provider Capability Gap.
_Avoid_: Invalid request, all Providers failed

**Provider Switch**:
The continuation of a valid request on a different eligible Provider after the current Provider
cannot serve it.
_Avoid_: Same-Provider retry, request retry

**Public Request Contract**:
The endpoint, model, parameter, and input semantics that the proxy promises to accept from clients,
independent of any one Provider's capabilities.
_Avoid_: Provider API contract, upstream capability

**Request-Terminal Error**:
A failure caused by request semantics that applies across eligible Providers and therefore belongs
to the request rather than any Provider.
_Avoid_: Provider failure, retryable error

**Rectifiable Request Error**:
A request error for which the proxy has a named, deterministic one-shot transformation. It may be
retried once only when that transformation changes the request.
_Avoid_: Provider retry, retryable Provider failure

**Core Request Error**:
A Request-Terminal Error identified by stable protocol semantics whose routing classification
cannot be changed by transport status or disabled by administrative configuration.
_Avoid_: Custom error rule, Provider failure

**Context Window Exceeded**:
A Request-Terminal Error stating that the requested model cannot accept the input context.
_Avoid_: Provider outage, Provider failure

**Safety Rejection**:
A refusal based on content safety policy that terminates routing so the proxy does not automatically
bypass the rejecting Provider's policy.
_Avoid_: Provider Capability Gap, Provider outage

**Precommit Stream Error**:
An upstream error frame received before any response content is committed to the client. Its
semantic cause, rather than a proxy-generated status, determines whether it belongs to the request
or the Provider.
_Avoid_: Provider 502, transport failure

**Client Error Contract**:
The protocol-compatible status, stable error code, and safe message returned to the calling client,
independent of the error shape received from a Provider.
_Avoid_: Raw upstream error, Provider response body

**Response Commitment**:
The boundary at which the first valid response content becomes client-visible. Routing outcomes may
change before commitment, while the client response is immutable afterward.
_Avoid_: First upstream byte, response headers

**Routing Error Classification**:
The assignment of a failed attempt to a Request-Terminal Error, Provider Capability Gap, or Provider
health failure before retry, Provider switching, and health accounting decisions are made.
_Avoid_: HTTP status mapping, response formatting

**Routing Disposition**:
The explicit routing outcome assigned by Routing Error Classification: request-terminal, Provider
capability gap, or Provider health failure.
_Avoid_: Error category, HTTP status

**Error Ownership Evidence**:
Specific protocol structure or semantics that establish whether an error belongs to the request or
a Provider. A generic error family or HTTP status alone is not ownership evidence.
_Avoid_: `invalid_request_error` alone, message prefix alone

**Global Priority**:
The Provider's own priority value. It is distinct from an effective priority produced by a user
group override.
_Avoid_: Effective priority, group priority

**Cost Multiplier**:
A Provider's relative usage-cost factor and the input to cost-aware weight adjustment.
_Avoid_: Routing Weight, adjustment multiplier

**Routing Weight**:
A Provider's relative selection weight among eligible Providers at the same effective priority. It
is not a traffic percentage by itself.
_Avoid_: Traffic percentage, Cost Multiplier

**Weight Adjustment Rule**:
An administrator-defined, uniquely named policy whose explicitly selected Providers share one
Provider Type and Global Priority. A Provider belongs to at most one rule.
_Avoid_: Provider batch update, cost multiplier rule

**Adjustment Set**:
The enabled, valid members of one Weight Adjustment Rule that participate in a recalculation. A
Provider's transient routing health does not determine membership.
_Avoid_: All matching Providers, Provider Vendor

**Cost-Aware Weight Adjustment**:
A recalculation that assigns Routing Weights inversely to Cost Multipliers within one Adjustment
Set. Each rule is an independent cost-comparison domain.
_Avoid_: Cost multiplier synchronization, cross-rule normalization

**Periodic Recalculation**:
Timer-based evaluation of Weight Adjustment Rules using one administrator-selected interval
duration. Cost Multiplier changes do not trigger recalculation immediately.
_Avoid_: Event-triggered adjustment, continuous synchronization

**Adjustment Run**:
One scheduled or administrator-requested execution of a Weight Adjustment Rule.
_Avoid_: Request log, provider audit event

**Adjustment Preview**:
A read-only projection of a rule's members, current Cost Multipliers, and expected Routing Weight
changes. It describes only the rule's internal comparison domain.
_Avoid_: Adjustment Run, global traffic forecast

**Adjustment Alert**:
A system notification that opens a fault episode when an Adjustment Run fails, is due but cannot
execute, or succeeds with an operational warning, and closes it after recovery.
_Avoid_: Adjustment Run history, application log
