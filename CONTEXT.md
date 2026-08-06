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
