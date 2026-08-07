export const ROUTING_DISPOSITIONS = [
  "request_terminal",
  "endpoint_capability_gap",
  "provider_capability_gap",
  "provider_failure",
] as const;

export type RoutingDisposition = (typeof ROUTING_DISPOSITIONS)[number];

export function isRoutingDisposition(value: unknown): value is RoutingDisposition {
  return typeof value === "string" && (ROUTING_DISPOSITIONS as readonly string[]).includes(value);
}
