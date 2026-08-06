---
status: accepted
---

# Use explicit, independently normalized rules for cost-aware Provider weights

Providers already expose a Cost Multiplier and a relative Routing Weight. We will persist
administrator-defined Weight Adjustment Rules with explicit, non-overlapping Provider membership;
all members of a rule share one exact Provider Type and Global Priority. Each rule is an independent
comparison domain and periodically computes inverse-cost weights normalized to a mean of 50 before
rounding and clamping to `1..100`.

## Considered Options

- Dynamically include every enabled Provider matching a type and priority. Rejected because newly
  created or reconfigured Providers would silently change an existing policy.
- Normalize all rules with the same type and priority together. Rejected because administrators
  need explicit, independently managed comparison domains.
- Anchor the cheapest Provider at 100 or use `50 / costMultiplier`. Rejected because many Cost
  Multipliers are below 1; fixed anchoring would either make equal-cost sets unnecessarily max out
  or collapse many distinct costs at the upper bound.
- Recalculate immediately when Cost Multipliers change. Rejected to limit background load and keep
  adjustment independent from cost probing.

## Consequences

- Cost relationships are meaningful only inside one rule; previews must not present rule-internal
  shares as global traffic probabilities.
- Multiple rules may share a Provider Type and Global Priority, but one Provider can belong to only
  one rule.
- Each rule updates its changed Providers atomically on a shared administrator-selected interval;
  existing sticky or affinity selections are not displaced.
- A manual weight edit detaches a Provider from an enabled rule after explicit confirmation, while
  disabled-rule membership is retained.
- Persisted rule state, membership, short-lived run history, idempotency, and fault/recovery state
  are required to make scheduling and administrative behavior auditable.
