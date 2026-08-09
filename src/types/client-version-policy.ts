export const CLIENT_VERSION_POLICY_MODES = [
  "automatic_baseline",
  "minimum",
  "maximum",
  "range",
  "baseline_lag",
] as const;

export type ClientVersionPolicyMode = (typeof CLIENT_VERSION_POLICY_MODES)[number];

export interface ClientVersionPolicy {
  id: number;
  clientType: string;
  mode: ClientVersionPolicyMode;
  minimumVersion: string | null;
  maximumVersion: string | null;
  baselineLag: number | null;
  automaticBaseline: string | null;
  previousSeriesTerminalVersion: string | null;
  baselineUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ClientVersionPolicyWrite =
  | { mode: "automatic_baseline" }
  | { mode: "minimum"; minimumVersion: string }
  | { mode: "maximum"; maximumVersion: string }
  | { mode: "range"; minimumVersion: string; maximumVersion: string }
  | { mode: "baseline_lag"; baselineLag: number; previousSeriesTerminalVersion?: string | null };

export type ClientVersionStatus =
  | "below_minimum"
  | "within_range"
  | "above_maximum"
  | "unparseable"
  | "unchecked";

export interface EffectiveClientVersionRange {
  minimumVersion: string | null;
  maximumVersion: string | null;
  waitingForBaseline: boolean;
}

export interface ClientVersionEvaluation extends EffectiveClientVersionRange {
  status: ClientVersionStatus;
  comparableVersion: string | null;
}
