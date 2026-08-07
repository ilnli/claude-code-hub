# Recharge increases usage limits instead of introducing a wallet

The first-party recharge flow treats a successful Alipay face-to-face payment as an additive increase
to the current Login Key's total usage limit, and increases the configured User Total Usage Limit by the
same amount. We chose this model because the proxy already enforces cumulative usage limits from the
usage ledger; introducing a wallet would require changing request authorization, concurrent debit
semantics, refunds, and accounting across the proxy pipeline. Payment orders therefore settle against
the existing limit model rather than creating an independent balance.

## Consequences

- A Recharge Order is scoped to the currently authenticated Key.
- A positive Key Total Usage Limit is required to start a recharge.
- Settlement is atomic across the order, Key, and configured User Total Usage Limit.
- The flow does not add automatic recharge bonuses or Alipay refunds.
