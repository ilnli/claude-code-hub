import type { FormMode } from "./provider-form-types";

export interface CostMultiplierSubmitInput {
  mode: FormMode;
  /** rateFollowUpstream as it was when the form/dialog was opened (edit mode only). */
  initialRateFollowUpstream: boolean;
  /** Current (possibly user-toggled) rateFollowUpstream value. */
  currentRateFollowUpstream: boolean;
  /** costMultiplier snapshotted when the form/dialog was opened (edit mode only). */
  initialCostMultiplier: number;
  /** Current costMultiplier value held in form state. */
  currentCostMultiplier: number;
}

/**
 * Resolves what to send as `cost_multiplier` in the provider create/edit payload.
 *
 * While `rate_follow_upstream` is on, a background probe owns `cost_multiplier` and keeps
 * writing the effective upstream rate into it; the form disables the input in that state and
 * only ever holds a snapshot taken when the dialog opened. Submitting that stale snapshot on an
 * unrelated save (e.g. a rename) would overwrite the probe-synced value and also break the
 * probe's optimistic-concurrency write on its next attempt.
 *
 * Returning `undefined` means "omit the field from the payload" — `JSON.stringify` drops
 * undefined-valued object keys, so the server sees the field as untouched and applies its own
 * fallback (restoring the default multiplier when follow is being turned off).
 */
export function resolveCostMultiplierForSubmit({
  mode,
  initialRateFollowUpstream,
  currentRateFollowUpstream,
  initialCostMultiplier,
  currentCostMultiplier,
}: CostMultiplierSubmitInput): number | undefined {
  if (mode !== "edit") {
    return currentCostMultiplier;
  }

  // Follow was on and stayed on: the field is disabled and probe-owned, never submit it.
  if (initialRateFollowUpstream && currentRateFollowUpstream) {
    return undefined;
  }

  // Follow just got turned off: only forward a value the user actually changed;
  // otherwise let the server restore the configured default multiplier.
  if (initialRateFollowUpstream && !currentRateFollowUpstream) {
    const userEditedValue = currentCostMultiplier !== initialCostMultiplier;
    return userEditedValue ? currentCostMultiplier : undefined;
  }

  // Follow was off throughout: unchanged behavior.
  return currentCostMultiplier;
}
