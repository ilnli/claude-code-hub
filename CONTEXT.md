# Claude Code Hub

This context defines the domain language used by the proxy routing and user recharge areas.

## Language

**Request Record**:
A single logical proxy request attributable to a resolved User and Key, retained regardless of
whether it succeeds or where it terminates. A request that cannot be attributed during
authentication is not a Request Record.
_Avoid_: Usage Log, Upstream Attempt, authentication failure log

**Attributable Authentication Failure**:
An authentication rejection in which credentials resolve to a real User and Key but an account
state such as disablement or expiration prevents access. It is a Request Record even though access
was not granted.
_Avoid_: Invalid credential, unknown Key, successful authentication

**Pre-Identity Parse Failure**:
A request-body parsing, decompression, or size failure that occurs before CCH can resolve a User and
Key. It remains an application-log event and is not a Request Record.
_Avoid_: Attributable Authentication Failure, early local guard failure

**Request History**:
The User or administrator projection of Request Records, including Provider-Unassigned Requests.
User projections expose only User Error Summaries, while Provider-scoped projections exclude
records without Provider attribution.
_Avoid_: Billing ledger, Upstream Attempt history, application log

**Upstream Attempt**:
One actual upstream call made while resolving a Request Record, including a retry, Provider Switch,
or Hedge attempt. Any number of Upstream Attempts still belongs to one Request Record.
_Avoid_: Request Record, user request

**Failed Request**:
A Request Record whose final client response status is outside the HTTP 2xx range. A Request Record
without a final status is still in progress and is not a Failed Request.
_Avoid_: Non-200 request, Provider failure

**Failed Request Filter**:
A Request History filter that selects exactly Failed Requests. It is distinct from the legacy
literal operation that excludes only status 200.
_Avoid_: Non-200 filter, `excludeStatusCode200`

**Failed Request Accounting**:
The rule that a Failed Request contributes one logical request to request totals, while cost and
tokens come only from reported Upstream Attempt usage. A failure before any Upstream Attempt has no
Provider success-rate or availability attribution.
_Avoid_: Free failed request, Provider failure count, per-attempt request count

**Provider-Unassigned Request**:
A Request Record that terminates before any Provider is assigned. It remains a normal Request Record
and has no Provider attribution; the absent Provider is a valid outcome rather than missing data.
_Avoid_: System Provider request, orphaned request, Provider zero

**Failure Finalization**:
The bounded, awaited terminal recording of a Failed Request after its final non-2xx outcome is
known. It updates or creates its Request Record exactly once, while a persistence failure raises an
internal alert without changing the Client Error Contract.
_Avoid_: Background error logging, Upstream Attempt log, provisional failure row

**Guard Failure**:
A structured terminal outcome from a local request guard that carries the Client Error Contract,
Public Error Snapshot inputs, and administrator diagnostic context to Failure Finalization.
_Avoid_: Parsed error Response, guard-specific database write, Upstream Attempt failure

**Provider**:
A concrete routable API credential and configuration record.
_Avoid_: Provider Vendor, vendor

**Provider Vendor**:
A vendor entity that groups Providers by official website domain.
_Avoid_: Provider, API credential

**Upstream Site**:
An upstream host identity that groups Providers by the normalized host of each Provider's configured
upstream URL; scheme and path do not affect identity, `www.` is ignored, subdomains and non-default
ports remain distinct, and runtime Provider Endpoint selection does not change identity. Every
Provider with a valid endpoint belongs to one Site independently of feature enablement; the Site is
independent of Provider Vendor, represents one new-api management plane, and leaves a legacy
Provider unassigned and unable to run new-api probes until its invalid endpoint is repaired.
_Avoid_: Provider Vendor, Provider Endpoint, website domain

**Site Billing Probe Credential**:
A single current new-api Dashboard PAT owned by one Upstream Site for discovering upstream
billing-group rates. It is shared by all of the Site's Providers, regardless of Provider Type, but
does not replace each Provider's API credential when identifying that Provider's effective billing
group and does not represent model-price synchronization.
_Avoid_: Site Pricing Credential, Provider PAT, Endpoint PAT, protocol credential

**Site Billing Probe Target**:
The single management-plane base URL selected for all of an Upstream Site's billing-rate discovery
requests. It is configured independently, may retain a deployment path prefix, and must match the
Site's normalized host and non-default port.
_Avoid_: Provider URL, Provider Endpoint, website URL

**Upstream Billing Rate Resolution**:
The ordered selection of a Provider's valid upstream billing-group rate: prefer the rate visible
through the Site Billing Probe Credential, then the anonymously visible rate, and finally the
Provider's default rate. A missing or invalid higher-priority rate does not block the next source.
_Avoid_: PAT-only probing, anonymous-only probing, model-price resolution

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

**Postcommit Stream Failure**:
A stream failure that occurs after Response Commitment and therefore cannot replace the established
2xx client status. It is outside Failed Request and User Error Summary semantics.
_Avoid_: Failed Request, non-2xx response, ordinary upstream failure

**Client Error Contract**:
The protocol-compatible status, stable error code, and safe message returned to the calling client,
independent of the error shape received from a Provider.
_Avoid_: Raw upstream error, Provider response body

**Public Error Snapshot**:
The retained user-visible result of the Client Error Contract for a Failed Request, fixed when the
response is produced and containing its final status, stable code, safe message, and CCH Session ID.
It is independent of administrator diagnostics.
_Avoid_: Sanitized administrator error, raw upstream error, recomputed error message

**Public Error Code**:
A stable, User-safe category used for Public Error Rendering without exposing Provider, routing,
circuit, rule, or infrastructure identity. Internal error codes map to it rather than crossing the
User API boundary.
_Avoid_: Internal error code, routing disposition, Provider error code

**User Error Summary**:
The limited Request Record view of a Public Error Snapshot: the existing final status, a sanitized
error reason, and a CCH Session ID for support correlation. It excludes Provider and routing
diagnostics and is intended only to orient the User before administrator investigation.
_Avoid_: Administrator error detail, raw error, routing summary

**Administrator Error Detail**:
The privileged Request History view that pairs the User Error Summary with retained internal,
routing, and Provider diagnostics. A Provider-Unassigned Request is identified as not having reached
an upstream rather than being assigned a synthetic Provider.
_Avoid_: User Error Summary, public error response, synthetic Provider detail

**Safe Error Fallback**:
A localized category-level reason used in a User Error Summary when no diagnostic message can be
proven safe. It replaces unsafe detail completely rather than partially redacting or omitting it.
_Avoid_: Partially redacted raw error, blank error reason, Provider error excerpt

**Public Error Rendering**:
The rendering rule that uses the current User locale for a known public error code or Safe Error
Fallback and otherwise shows the retained safe dynamic message. The stable code selects content but
is not itself displayed.
_Avoid_: Machine-translated diagnostic, displayed error code, localized raw Provider error

**Public Error Retention**:
The rule that safe dynamic error text follows Request Record log retention, while the permanent
Usage Ledger retains only its stable public error code. After detail expires, rendering uses the
localized code or a Safe Error Fallback.
_Avoid_: Permanent dynamic error text, permanent administrator diagnostic, historical enrichment

**Historical Error Visibility**:
The rule that a historical Request Record without a Public Error Snapshot retains its prior user
visibility and gains no synthesized error reason or correlation detail.
_Avoid_: Error backfill, read-time historical sanitization, inferred Public Error Snapshot

**CCH Session ID**:
The support correlation identity assigned to every Request Record, including an Attributable
Authentication Failure or a request that terminates during an early local guard. Its assignment does
not mean the request passed validation or that request content was retained for Session diagnostics.
_Avoid_: Upstream request ID, Provider request ID, request acceptance marker

**Request UUID**:
The private, immutable identity allocated to a Request Record before persistence and used only to
make creation idempotent across ambiguous database retries. It is not User support information.
_Avoid_: CCH Session ID, database row ID, client retry key

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

## Compaction Language

**Explicit Compaction Request**:
A request whose immediate expected result is a canonical compacted context, including a Standalone
Compaction Request or a Codex Remote Compaction v2 Request.
_Avoid_: Server-side Compaction-Enabled Request, ordinary Responses request

**Standalone Compaction Request**:
An explicit, stateless compaction operation that accepts a complete context window and returns the
canonical compacted context window for a subsequent Responses request. CCH labels this wire form as
Remote Compaction v1 only when contrasting it with Codex Remote Compaction v2.
_Avoid_: Official Compaction API v1, Server-side Compaction

**Server-side Compaction-Enabled Request**:
A Responses generation request that permits threshold-triggered compaction during inference; it may
complete without executing compaction when the threshold is not crossed.
_Avoid_: Explicit Compaction Request, Codex Remote Compaction v2 Request

**Codex Remote Compaction v2 Request**:
An explicit compaction operation issued through the Responses route with an exact top-level
`compaction_trigger` input item rather than through the public standalone endpoint.
_Avoid_: Server-side Compaction-Enabled Request, public Compaction API v2

**Compaction Request Version**:
The user-visible classification of an Explicit Compaction Request based on its original client wire
form: v1 for standalone compaction and v2 for Codex Remote Compaction v2.
_Avoid_: Managed endpoint, inferred endpoint label

**Compaction Version Attribution**:
The assignment of a Compaction Request Version from persisted request evidence: new records store the
version explicitly, while historical records may infer it only from conclusive wire evidence and
otherwise remain version-unknown.
_Avoid_: Database backfill guess, managed-endpoint-only inference

**Compaction Version Retention**:
The preservation of Compaction Request Version in detailed request history, long-lived usage records,
and attempt billing evidence independently of retained request content.
_Avoid_: Request-body-dependent version history, short-lived version label

**Compaction Request Record**:
A normal user request record augmented with its Compaction Request Version; status, error, and
routing-attempt visibility follow the same rules as other request records.
_Avoid_: Separate compaction audit record, compaction-only log format

**Compaction Logical Request**:
The single user operation and request record represented by an Explicit Compaction Request,
regardless of same-Provider retries or Provider Switches. Billable usage from every upstream attempt
is aggregated into this record rather than represented as additional user requests, and remains
chargeable even when the logical request ultimately fails.
_Avoid_: Per-attempt user request, final-attempt-only billing

**Compaction Attempt Usage**:
Usage reported by any upstream attempt for a Compaction Logical Request, including an attempt whose
response violates the Compaction Response Contract; every such report contributes to user billing.
An attempt without reported usage is not estimated and contributes no charge.
_Avoid_: Successful-attempt-only usage, proxy-absorbed retry cost

**Compaction Attempt Charge**:
The charge calculated independently for one Compaction Attempt Usage report using that attempt's
actual Provider, model, pricing snapshot, multipliers, and cache-token details before aggregation into
the Compaction Logical Request.
_Avoid_: Final-Provider repricing, aggregate-token repricing

**Pending Compaction Pricing**:
Committed Compaction Attempt Usage whose charge cannot yet be calculated from an available pricing
source; it blocks further routing and client delivery until billing reconciliation can resolve it
from pricing effective at the attempt time. A resolved charge is sealed against later price changes.
_Avoid_: Zero-cost fallback, discarded usage

**Compaction Attempt Ledger**:
The immutable, idempotent billing evidence for each real upstream attempt within a Compaction Logical
Request, retained separately from the request's aggregated usage record and keyed by request and
attempt identity. Its initial ownership is limited to Explicit Compaction Requests rather than
replacing existing Hedge or ordinary-request billing.
_Avoid_: Request-row JSON billing array, per-attempt user request

**Compaction Cost Attribution**:
The allocation of Compaction Attempt Charges to the requesting User and Key and to each attempt's
actual Provider for spend limits and statistics, while request count and success remain properties of
the single Compaction Logical Request.
_Avoid_: Final-Provider-only cost, per-attempt user call count

**Compaction Accounting Projection**:
The reporting split in which logical usage records provide User, Key, global cost, and request-count
totals, while compaction attempt records provide actual Provider cost, token, and attempt totals
without contributing a second time to user cost.
_Avoid_: Double-counted attempt cost, final-Provider aggregate attribution

**Provisional Compaction Usage**:
The in-progress logical usage aggregate recomputed from committed Compaction Attempt Ledger entries
after each billed attempt so spend limits can observe durable cost before routing continues.
_Avoid_: Untracked in-memory total, additive-only ledger update

**Sealed Compaction Usage**:
The final immutable logical usage aggregate for a completed, failed, or aborted Compaction Logical
Request; stale provisional usage is reconciled and sealed from its attempt ledger evidence.
_Avoid_: Permanently mutable usage ledger, discarded failed-request cost

**Compaction Attempt Billing Commitment**:
The durability boundary requiring reported Compaction Attempt Usage to be persisted idempotently
before another upstream attempt begins or a successful response becomes client-visible. A persistence
failure terminates routing rather than creating additional untracked cost or delivering unbilled
compaction state.
_Avoid_: Best-effort attempt billing, post-retry billing

**Compaction Spend Recheck**:
The re-evaluation of User, Key, and actual Provider spend limits after each Compaction Attempt Charge
is committed and before another upstream attempt begins.
_Avoid_: Request-start-only spend check, post-routing limit enforcement

**Compaction Response Contract**:
The version-aware minimum semantics required for a client-consumable compaction result: successful
completion with exactly one compaction output item containing non-empty opaque encrypted content.
_Avoid_: Full upstream response schema, metadata completeness check

**Compaction Contract Violation**:
An upstream result that cannot satisfy the Compaction Response Contract, including missing,
duplicate, empty, malformed, failed, or protocol-contradictory compaction output.
_Avoid_: Valid empty response, client request error

**Compaction Capability Gap**:
A Provider Capability Gap established by explicit core evidence that compaction is unsupported or
when an Explicit Compaction Request still violates the Compaction Response Contract after its
permitted cache-preserving retry. It does not affect the Provider's general health or ordinary
conversation traffic.
_Avoid_: Provider outage, general circuit failure

**Compaction Capability Memory**:
A temporary, version-specific memory of a Compaction Capability Gap used to avoid repeatedly routing
new Explicit Compaction Requests to a recently incompatible Provider. Its identity is the Provider
and Compaction Request Version, independent of Provider Endpoint and model; its duration matches the
Provider's circuit-open duration, or thirty minutes when no duration is configured. Capability-relevant
Provider changes and administrative health reset clear it before expiry.
_Avoid_: General circuit state, permanent Provider disablement

**Compaction Capability Probe**:
The single Explicit Compaction Request allowed to re-evaluate a Provider after its Compaction
Capability Memory expires. Success restores availability; a repeated contract violation renews the
full memory duration, and concurrent probes for the same Provider and version are not allowed. While
the probe is active, other requests skip that Provider and report Provider Capability Exhaustion when
no alternative is eligible.
_Avoid_: Parallel half-open probes, permanent capability verdict

**Compaction Capability Status**:
The administrator-visible state of a Provider's version-specific Compaction Capability Memory,
including its evidence, expiry, active probe, and manual-clear control, without exposing the state to
ordinary users outside their own routing records.
_Avoid_: General Provider health, user-visible global Provider state

**Compaction Cache-Preserving Retry**:
A single immediate retry of a failed Explicit Compaction Request on the same Provider and Provider
Endpoint, preserving the model, request content, and cache parameters before Provider Switch. The
two-attempt limit is fixed and available only to the initially selected Provider; Providers selected
after a switch receive one attempt each.
_Avoid_: Provider Switch, unbounded compaction retry

**Validated Compaction Commitment**:
The Response Commitment rule for an Explicit Compaction Request: no upstream content becomes
client-visible until the complete JSON or event stream satisfies the Compaction Response Contract.
_Avoid_: First upstream byte commitment, partial compaction delivery

**Validated Raw Compaction Response**:
An upstream compaction response delivered with its original protocol content and event order after
validation, without conversion between compaction versions or injection of proxy-specific fields.
_Avoid_: Re-serialized compaction payload, v2-to-v1 conversion

**Compaction Upstream Transport**:
The HTTP JSON or SSE transport used between CCH and a Provider for Explicit Compaction Requests so
validation, billing commitment, and serial routing complete before client delivery.
_Avoid_: Responses upstream WebSocket, transport-dependent validation bypass

**Compaction Fallback Policy**:
The routing policy in which Compaction Response Contract validation and the initial cache-preserving
retry always apply, while Provider Switch remains governed by the existing non-conversation endpoint
fallback setting.
_Avoid_: Validation bypass, fallback-controlled validation

**Serial Compaction Routing**:
The routing mode in which an Explicit Compaction Request uses one upstream attempt at a time,
including its cache-preserving retry and later Provider Switches, without Hedge or Discovery races.
_Avoid_: Concurrent Provider race, parallel compaction attempts

**Cache-Affine Compaction Start**:
The initial Provider selection for an Explicit Compaction Request, preserving ordinary cache affinity
unless the Provider has a matching version-specific Compaction Capability Gap.
_Avoid_: Fallback-first routing, pricing-pending pre-exclusion

**Compaction Fallback Candidate**:
An otherwise eligible Provider that has not yet been attempted within the current Compaction Logical
Request and may be selected after the initial Provider cannot complete it.
_Avoid_: Previously failed Provider, globally untried Provider

**Compaction Routing Budget**:
The total wall-clock allowance for all serial attempts within one Compaction Logical Request; when it
is exhausted, no new retry or Provider Switch begins even if the general Provider-switch limit remains.
_Avoid_: Per-attempt timeout sum, unbounded Provider traversal

**Compaction Error Routing**:
The routing rule that applies ordinary error classification, retry, switching, and health accounting
to non-contract failures, while reserving the fixed cache-preserving retry and capability treatment
for Compaction Contract Violations.
_Avoid_: All-compaction-errors capability gap, separate transport retry system

**Compaction Validation Enforcement**:
The default requirement that every Explicit Compaction Request satisfy the Compaction Response
Contract before client delivery. An emergency operational bypass may disable enforcement but must
remain visible as bypassed rather than validated.
_Avoid_: Shadow success, silent validation bypass

**Compaction Client Error**:
The safe client-facing failure for an Explicit Compaction Request: an invalid final upstream result
is a 502 compaction-response error, while Compaction Capability Exhaustion uses the existing 503
Provider capability unavailable contract.
_Avoid_: Raw upstream response, encrypted-content disclosure

**Compaction Client Abort**:
The termination of a Compaction Logical Request when its client disconnects before commitment;
future retries and switches stop, already reported usage remains billable, and no incomplete attempt
establishes a Compaction Capability Gap.
_Avoid_: Background compaction continuation, aborted capability verdict

**Compaction Validation Evidence**:
Sanitized structural facts explaining a compaction validation outcome, such as version, transport,
failure code, item counts and types, response size, duration, and routing decisions, without opaque
encrypted content or conversational payloads.
_Avoid_: Full upstream response, message content, reasoning content

**Canonical Compaction Output**:
The single logical compaction item established across a completed response, with duplicate stream
representations reconciled by item identity or output position and contradictory representations
rejected.
_Avoid_: Raw event count, first compaction-looking frame

## Client Version Language

**Client Type**:
A recognizable category of calling software, such as the Claude CLI or Claude VSCode extension,
whose version sequence is managed independently from other client categories.
_Avoid_: Client, User-Agent

**Client Version Policy**:
The version-compatibility policy assigned to one Client Type. It is either an Automatic Baseline
Policy or Version Constraints, independently of the policies for other Client Types.
_Avoid_: Global version rule, implicit baseline fallback

**Comparable Client Version**:
The numeric `major.minor.patch` core extracted from a client version. Prefixes and suffixes do not
affect policy ordering, so prerelease and build variants with the same core are equal; the original
version remains available for display.
_Avoid_: Full SemVer precedence, raw User-Agent version

**Unparseable Client Version**:
A client request whose User-Agent does not contain a comparable `major.minor.patch` core. It is
allowed through version enforcement but remains visible as an identification problem.
_Avoid_: Version zero, unsupported client version

**Effective Client Version Range**:
The inclusive range actually enforced for one Client Type after evaluating its selected policy mode,
automatic baseline, and any stored version-line boundary.
_Avoid_: Configured fields, observed version spread

**Client Version Status**:
The classification of a recognized client version against its Effective Client Version Range:
below minimum, within range, above maximum, or unparseable.
_Avoid_: Latest/oldest label, generic client health

**Version Enforcement Preview**:
The non-enforcing classification of observed client versions against stored policies while the
Global Client Version Check is disabled.
_Avoid_: Active enforcement, version distribution alone

**Client Upgrade Required**:
The blocking outcome for a client version below its Effective Client Version Range, retaining the
existing client-facing error identity.
_Avoid_: Client Version Too New, update suggestion

**Client Version Too New**:
The blocking outcome for a client version above its Effective Client Version Range, directing the
caller to a supported version at or below the maximum.
_Avoid_: Client Upgrade Required, unknown client

**Automatic Version Baseline**:
The highest Comparable Client Version whose distinct-user adoption during the Client Observation
Window reaches the configured threshold; suffix variants share one adoption bucket, and one user may
count once for each comparable version they used in that window.
It is a locally detected compatibility baseline, not a vendor-declared GA release or the highest
version seen from any single user. Until such a baseline exists, the policy imposes no restriction;
once advanced, the baseline never decreases when older observations leave the Client Observation
Window. If recalculation fails, version enforcement follows the existing fail-open behavior for that
request.
_Avoid_: GA version, latest observed version, official stable release

**Client Observation Window**:
The preceding seven days of client requests used to discover active Client Types and measure version
adoption for an Automatic Version Baseline. Observations continue while the Global Client Version
Check is disabled and include requests blocked by version enforcement, although enforcement and
baseline advancement remain paused while the global check is disabled.
_Avoid_: All historical clients, policy lifetime

**Automatic Baseline Policy**:
A Client Version Policy that uses the Automatic Version Baseline as its compatibility threshold
rather than administrator-entered version boundaries. Returning to this policy after an override
discards the prior baseline and detects a new one from the current Client Observation Window while
retaining the Previous Series Terminal Version only when it remains lower than the new baseline and
belongs to a different Version Series.
_Avoid_: Version Constraints, official GA policy

**Baseline-Driven Policy**:
An Automatic Baseline Policy or Baseline Lag Tolerance mode whose Effective Client Version Range
depends on the Automatic Version Baseline. Switching between those two modes preserves the baseline
and previous-series history; returning from fixed Version Constraints recalculates the baseline.
_Avoid_: Fixed Version Constraints, automatic policy creation

**Automatic Policy Override**:
An administrator operation that replaces a Baseline-Driven Policy with fixed Version Constraints. An
Automatic Baseline Policy becomes an exact range whose minimum and maximum are the selected version;
a Baseline Lag Tolerance becomes a range whose maximum is selected and whose minimum is derived from
the retained tolerance within the selected Version Series and clamped to its `.0` release, without
using the Previous Series Terminal Version. Later baseline observations do not move the generated range.
Editing an existing fixed constraint preserves its mode and changes only its configured boundaries.
Fixed modes suspend automatic baseline tracking until the policy is explicitly changed back to a
Baseline-Driven Policy.
_Avoid_: Automatic baseline correction, continuing automatic detection

**Version Constraints**:
A Client Version Policy with exactly one constraint mode: a Minimum Supported Version, a Maximum
Supported Version, both boundaries, or a Baseline Lag Tolerance. Constraint modes do not combine.
_Avoid_: Automatic Baseline Policy, global version rule

**Baseline Lag Tolerance**:
The positive maximum permitted number of patch-number steps below the Automatic Version Baseline.
Steps descend within the current Version Series; when the tolerance reaches the previously adopted
series, the minimum is clamped to that series' terminal version and never crosses into an earlier
series. Versions newer than the baseline are not restricted.
_Avoid_: Symmetric version window, maximum supported version

**Version Series**:
The ordered client releases sharing the same major and minor version components, such as `2.0.x`.
_Avoid_: Client Type, arbitrary version range

**Previous Series Terminal Version**:
The last Automatic Version Baseline in the previously adopted Version Series, even when intervening
numeric series never reached the adoption threshold. It is the hard floor when a Baseline Lag
Tolerance crosses the current series boundary and may be seeded or corrected by an administrator;
no earlier series is considered. If it is missing, the lag floor remains at the current series' `.0`
release until an administrator supplies it.
_Avoid_: Latest observed version, Minimum Supported Version

**Unconfigured Client Type**:
A Client Type for which no Client Version Policy exists. It has no version restriction even when the
Global Client Version Check is enabled; removing a policy also removes its detection history and
returns its type to this state.
_Avoid_: Automatic Baseline Policy, disabled policy record

**Minimum Supported Version**:
The inclusive lower boundary of a Client Version Policy. A client version below it is unsupported.
_Avoid_: Recommended version, Automatic Version Baseline

**Maximum Supported Version**:
The inclusive upper boundary of a Client Version Policy. A client version above it is unsupported.
_Avoid_: Latest version, recommended version

**Global Client Version Check**:
The administrator-controlled switch that enables or suspends all Client Version Policies without
deleting their per-client boundaries. Migration or the first enable establishes an Automatic
Baseline Policy for each Client Type recognized during the Client Observation Window at that time;
later Client Types remain unconfigured, and disabling then re-enabling does not create missing
policies. Disabling pauses enforcement while preserving policy and automatic-baseline history.
_Avoid_: Per-client policy, Automatic Version Baseline

**Policy Initialization**:
The one-time migration or first-enable operation that preserves existing policies and creates
Automatic Baseline Policies only for other Client Types active in the Client Observation Window,
immediately deriving any available initial baselines from that window. Later toggles do not repeat
initialization.
_Avoid_: Policy refresh, automatic policy recreation

## Recharge Language

**Login Key**:
The API key that authenticates a person into the Web UI and identifies the key whose usage limit is
being managed.
_Avoid_: User account, payment identity

**Rechargeable Key**:
A Login Key with a positive total usage limit that is eligible to start a recharge. A missing, zero,
or negative limit does not make a key rechargeable.
_Avoid_: Any API key, user wallet

**Key Total Usage Limit**:
The maximum cumulative usage amount that one Login Key may consume.
_Avoid_: Balance, available funds

**User Total Usage Limit**:
The aggregate cumulative usage ceiling across a user's keys. When a Recharge increases a Key Total
Usage Limit, the same purchased amount increases this ceiling when it is configured.
_Avoid_: User balance, account credit

**Recharge**:
A user-initiated payment in which the user chooses a USD-denominated usage-limit increase for the
current Rechargeable Key; the corresponding User Total Usage Limit is increased by the same amount
when configured. The business rule uses a fixed one-to-one conversion: one CNY paid produces one USD
of usage limit. The configured minimum and maximum apply to the requested credit, not the gross
payable amount. A configured Payment Fee is grossed up from the requested credit, and the payable CNY
amount is rounded upward to the nearest cent so the requested credit remains covered after fees.
_Avoid_: Deposit, wallet top-up

**Payment Fee**:
The percentage retained by the payment channel from the gross CNY payment. It is applied when the
payable amount is calculated, not deducted from the requested usage-limit increase. Administrators
enter it as a percentage, where 0.38 means 0.38 percent.
_Avoid_: Recharge discount, usage surcharge

**Payable Amount**:
The gross CNY amount shown to the user and sent to Alipay after applying the Payment Fee and rounding
up to cents.
_Avoid_: Recharge amount, credited amount

**Recharge Order**:
A payment intent owned by one Rechargeable Key. At most one unpaid Recharge Order may be pending for
the same key at a time.
_Avoid_: User wallet, usage record

**Pending Recharge Order**:
An unpaid Recharge Order that still blocks creation of another order for the same key and may be
cancelled by its user.
_Avoid_: Failed payment, completed recharge

**Cancelled Recharge Order**:
A Recharge Order the user has stopped waiting for before payment confirmation. Cancellation does not
invalidate a later verified successful payment; such a payment still completes the Recharge Order and
applies its credit.
_Avoid_: Refunded order, rejected payment

**Expired Recharge Order**:
A Pending Recharge Order that has remained unpaid for five minutes. It no longer blocks a new order
for the same key, but a later verified successful payment still applies its credit.
_Avoid_: Cancelled payment, failed order

**Recharge Order Administration**:
The administrator capability to list, inspect, filter, manually confirm, or cancel Recharge Orders.
_Avoid_: Payment configuration, user self-service

**Recharge Eligibility**:
An authenticated ordinary Login Key is eligible to recharge when its total usage limit is positive;
the key's Web UI mode changes the presentation surface but not this qualification.
_Avoid_: User-level eligibility, dashboard permission

**Payment Configuration**:
The single global administrator-managed Alipay face-to-face payment settings, including ordinary
merchant details and write-only sensitive credentials.
_Avoid_: User payment profile, payment order

**Payment Configuration Disable**:
A setting that prevents new Recharge Orders while leaving already-created orders, verified callbacks,
and Processing Recharge Order retries operational.
_Avoid_: Global order shutdown, callback rejection

**Manual Recharge Confirmation**:
An administrator operation that settles a pending Recharge Order using the same atomic crediting rules
as a verified payment notification and records the operator and reason.
_Avoid_: Status-only override, manual balance edit

**Recharge Audit Trail**:
The complete record of Recharge Order transitions, payment verification outcomes, settlement attempts,
operator actions, and usage-limit values before and after crediting, excluding payment secrets and raw
signatures.
_Avoid_: Order history, application debug log

**Recharge Settlement Alert**:
An administrator-visible warning emitted once after a Recharge Order's third settlement failure,
surfaced both in the administration UI and through configured Webhook notifications. The alert states
the current number of Recharge Orders waiting for manual attention and uses its own bindable notification
type.
_Avoid_: Payment receipt, retry debug log

**Recharge Order Snapshot**:
The immutable credit, fee, payable amount, product information, and Payment Configuration version fixed
when a Recharge Order is created. Referenced configuration versions remain available for the lifetime
of their orders so later verified payment notifications can still be processed.
_Avoid_: Current payment settings, recalculated checkout

**Manual Usage Limit Adjustment**:
An administrator-initiated usage-limit change outside Recharge Settlement, used for exceptional cases
rather than promotional recharge credit.
_Avoid_: Recharge bonus, automatic payment settlement

**Manual Refund Handling**:
An exceptional process in which an administrator refunds outside the application and separately
records a Manual Usage Limit Adjustment; the application does not initiate Alipay refunds.
_Avoid_: Automatic refund, Recharge Settlement reversal

**Verified Payment Notification**:
An Alipay success notification with the required signature, status, local order number, and external
transaction number; any optional merchant or amount fields that are present must also match the order.
_Avoid_: Browser return, payment hint

**Recharge Settlement**:
The atomic operation that applies a successful Recharge to its Key Total Usage Limit and, when
configured at settlement time, the User Total Usage Limit before the Recharge Order is completed.
It increments current positive limits and never restores a missing or non-positive Key Total Usage
Limit from an earlier snapshot.
_Avoid_: Callback receipt, asynchronous balance update

**Processing Recharge Order**:
A Recharge Order for which a Verified Payment Notification has been accepted but Recharge Settlement
has not yet completed.
_Avoid_: Paid balance, completed recharge

**Completed Recharge Order**:
A Recharge Order whose Recharge Settlement has committed successfully.
_Avoid_: Paid notification, pending payment

**Manually Closed Recharge Order**:
A paid Recharge Order closed by an administrator after an offline full refund, either instead of
Recharge Settlement or after fully reversing a completed settlement. It records the operator, reason,
and refund evidence and no longer requires settlement attention.
_Avoid_: Cancelled Recharge Order, completed recharge

**Blocked Recharge Settlement**:
A Processing Recharge Order that cannot settle automatically because its target records are deleted
or its Key Total Usage Limit is no longer positive, requiring administrator resolution.
_Avoid_: Failed payment, cancelled recharge

**Recharge Settlement Retry**:
A repeat attempt to complete Recharge Settlement for a Processing Recharge Order. Automatic attempts
occur after one, five, and thirty minutes; after the third failure the order waits for administrator
resolution.
_Avoid_: Duplicate recharge, repeated payment

**Recharge Status Polling**:
The user page checks an active Recharge Order every ten seconds and stops when it reaches a terminal
state such as completed, cancelled, or expired.
_Avoid_: Payment push stream, rapid payment polling

**Recharge History**:
The orders created by one Login Key, visible only to that key for payment and settlement auditing.
_Avoid_: User-wide payment history, administrator order list
