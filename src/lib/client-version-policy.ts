import type {
  ClientVersionEvaluation,
  ClientVersionPolicy,
  ClientVersionPolicyWrite,
  EffectiveClientVersionRange,
} from "@/types/client-version-policy";

export interface ComparableClientVersion {
  major: number;
  minor: number;
  patch: number;
  normalized: string;
}

const CLIENT_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i;

export function parseComparableClientVersion(raw: string): ComparableClientVersion | null {
  const match = raw.trim().match(CLIENT_VERSION_PATTERN);
  if (!match) return null;

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;

  return {
    major,
    minor,
    patch,
    normalized: `${major}.${minor}.${patch}`,
  };
}

export function normalizeClientVersion(raw: string): string | null {
  return parseComparableClientVersion(raw)?.normalized ?? null;
}

export function compareClientVersions(a: string, b: string): number | null {
  const left = parseComparableClientVersion(a);
  const right = parseComparableClientVersion(b);
  if (!left || !right) return null;

  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

export function isSameVersionSeries(a: string, b: string): boolean {
  const left = parseComparableClientVersion(a);
  const right = parseComparableClientVersion(b);
  return !!left && !!right && left.major === right.major && left.minor === right.minor;
}

export function isValidPreviousSeriesTerminal(
  baseline: string,
  previousSeriesTerminalVersion: string
): boolean {
  const comparison = compareClientVersions(previousSeriesTerminalVersion, baseline);
  return comparison === -1 && !isSameVersionSeries(previousSeriesTerminalVersion, baseline);
}

export function calculateBaselineLagMinimum(
  baseline: string,
  baselineLag: number,
  previousSeriesTerminalVersion: string | null
): string | null {
  const parsed = parseComparableClientVersion(baseline);
  if (!parsed || !Number.isSafeInteger(baselineLag) || baselineLag <= 0) return null;

  if (baselineLag <= parsed.patch) {
    return `${parsed.major}.${parsed.minor}.${parsed.patch - baselineLag}`;
  }

  if (
    previousSeriesTerminalVersion &&
    isValidPreviousSeriesTerminal(baseline, previousSeriesTerminalVersion)
  ) {
    return normalizeClientVersion(previousSeriesTerminalVersion);
  }

  return `${parsed.major}.${parsed.minor}.0`;
}

export function resolveEffectiveClientVersionRange(
  policy: Pick<
    ClientVersionPolicy,
    | "mode"
    | "minimumVersion"
    | "maximumVersion"
    | "baselineLag"
    | "automaticBaseline"
    | "previousSeriesTerminalVersion"
  > | null
): EffectiveClientVersionRange {
  if (!policy) {
    return { minimumVersion: null, maximumVersion: null, waitingForBaseline: false };
  }

  switch (policy.mode) {
    case "automatic_baseline":
      return {
        minimumVersion: policy.automaticBaseline,
        maximumVersion: null,
        waitingForBaseline: policy.automaticBaseline === null,
      };
    case "minimum":
      return {
        minimumVersion: policy.minimumVersion,
        maximumVersion: null,
        waitingForBaseline: false,
      };
    case "maximum":
      return {
        minimumVersion: null,
        maximumVersion: policy.maximumVersion,
        waitingForBaseline: false,
      };
    case "range":
      return {
        minimumVersion: policy.minimumVersion,
        maximumVersion: policy.maximumVersion,
        waitingForBaseline: false,
      };
    case "baseline_lag":
      return {
        minimumVersion:
          policy.automaticBaseline && policy.baselineLag
            ? calculateBaselineLagMinimum(
                policy.automaticBaseline,
                policy.baselineLag,
                policy.previousSeriesTerminalVersion
              )
            : null,
        maximumVersion: null,
        waitingForBaseline: policy.automaticBaseline === null,
      };
  }
}

export function evaluateClientVersion(
  rawVersion: string,
  policy: Parameters<typeof resolveEffectiveClientVersionRange>[0]
): ClientVersionEvaluation {
  const range = resolveEffectiveClientVersionRange(policy);
  if (!policy || range.waitingForBaseline) {
    return { ...range, status: "unchecked", comparableVersion: normalizeClientVersion(rawVersion) };
  }

  const comparableVersion = normalizeClientVersion(rawVersion);
  if (!comparableVersion) {
    return { ...range, status: "unparseable", comparableVersion: null };
  }

  if (
    range.minimumVersion &&
    compareClientVersions(comparableVersion, range.minimumVersion) === -1
  ) {
    return { ...range, status: "below_minimum", comparableVersion };
  }

  if (
    range.maximumVersion &&
    compareClientVersions(comparableVersion, range.maximumVersion) === 1
  ) {
    return { ...range, status: "above_maximum", comparableVersion };
  }

  return { ...range, status: "within_range", comparableVersion };
}

export function computeAutomaticVersionBaseline(
  versions: Array<{ userId: number; version: string }>,
  adoptionThreshold: number
): string | null {
  if (!Number.isSafeInteger(adoptionThreshold) || adoptionThreshold <= 0) return null;

  const usersByVersion = new Map<string, Set<number>>();
  for (const item of versions) {
    const normalized = normalizeClientVersion(item.version);
    if (!normalized) continue;
    const userIds = usersByVersion.get(normalized) ?? new Set<number>();
    userIds.add(item.userId);
    usersByVersion.set(normalized, userIds);
  }

  let baseline: string | null = null;
  for (const [version, userIds] of usersByVersion) {
    if (userIds.size < adoptionThreshold) continue;
    if (baseline === null || compareClientVersions(version, baseline) === 1) {
      baseline = version;
    }
  }
  return baseline;
}

export function advanceAutomaticBaselineHistory(
  currentBaseline: string | null,
  candidateBaseline: string | null,
  previousSeriesTerminalVersion: string | null
): {
  automaticBaseline: string | null;
  previousSeriesTerminalVersion: string | null;
  changed: boolean;
} {
  const candidate = candidateBaseline ? normalizeClientVersion(candidateBaseline) : null;
  const current = currentBaseline ? normalizeClientVersion(currentBaseline) : null;
  if (!candidate || (current && compareClientVersions(candidate, current) !== 1)) {
    return {
      automaticBaseline: current,
      previousSeriesTerminalVersion,
      changed: false,
    };
  }

  return {
    automaticBaseline: candidate,
    previousSeriesTerminalVersion:
      current && !isSameVersionSeries(current, candidate) ? current : previousSeriesTerminalVersion,
    changed: true,
  };
}

export function buildFixedPolicyOverride(
  policy: Pick<ClientVersionPolicy, "mode" | "baselineLag">,
  selectedVersion: string
): Extract<ClientVersionPolicyWrite, { mode: "range" }> | null {
  const selected = parseComparableClientVersion(selectedVersion);
  if (!selected) return null;

  if (policy.mode === "automatic_baseline") {
    return {
      mode: "range",
      minimumVersion: selected.normalized,
      maximumVersion: selected.normalized,
    };
  }

  if (policy.mode === "baseline_lag" && policy.baselineLag) {
    return {
      mode: "range",
      minimumVersion: `${selected.major}.${selected.minor}.${Math.max(
        0,
        selected.patch - policy.baselineLag
      )}`,
      maximumVersion: selected.normalized,
    };
  }

  return null;
}
