# Claude Code Hub

This context defines the domain language used by the proxy routing and user recharge areas.

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
