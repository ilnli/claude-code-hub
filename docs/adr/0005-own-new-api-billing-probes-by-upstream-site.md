---
status: accepted
---

# Own new-api billing probes by Upstream Site

We will introduce an Upstream Site as a persistent identity derived from the normalized host of a
Provider's configured upstream URL. It is independent of Provider Vendor and owns one optional
new-api Dashboard PAT, one management-plane probe target, and one proxy policy shared by all
Providers assigned to that Site. This keeps billing credentials bound to the host that receives
them without duplicating PAT configuration across Providers or changing Provider-level billing
policies.

## Considered Options

- Store the PAT on each Provider. Rejected because the credential and authenticated pricing table
  are site-scoped and repeated configuration would drift.
- Store the PAT on Provider Vendor. Rejected because Provider Vendor is grouped by official website
  domain, while a billing credential must follow the actual upstream host; those domains may differ.
- Keep only a domain-keyed side table and derive membership at runtime. Rejected because the Site
  owns secrets, network policy, lifecycle, and an administrative surface and therefore warrants an
  explicit entity and Provider association.
- Include protocol, scheme, or path in Site identity. Rejected because the selected boundary is one
  new-api management plane per normalized `hostname[:non-default-port]`, shared across Provider
  Types. Path-isolated deployments must use distinct hosts or ports.
- Aggregate Provider token-log discovery under the PAT. Rejected because the PAT belongs to one
  new-api user, while Providers on the same host may use keys from different users. Each Provider
  continues to identify its effective group with its own API key.

## Consequences

- Every Provider with a valid configured upstream URL is automatically associated with one Upstream
  Site, regardless of whether upstream-rate following is enabled. Legacy Providers with invalid
  URLs may remain explicitly unassigned until repaired and cannot run new-api probes.
- The Site probe target must match the Site's normalized host and is used for both `/api/pricing`
  and `/api/log/token`. One optional Site proxy policy supplies a deterministic network route.
- A configured target is required before saving a PAT. HTTPS is required by default; an
  administrator may explicitly allow insecure HTTP for a Site.
- A Provider resolves a valid group rate in this order: PAT-authenticated pricing, anonymous
  pricing, then its configured default rate. Missing, invalid, or inaccessible PAT results silently
  continue to the anonymous source; successful anonymous fallback does not create a degraded state.
- The PAT is optional, stored in plaintext consistently with existing Provider keys, treated as a
  write-only management field, never returned or logged, and only replaced or cleared explicitly.
  Proxy credentials are redacted in management responses.
- PAT testing is an audited, administrator-only, read-only operation. It may use unsaved draft
  settings, validates both identity and the authenticated pricing response, and never writes
  Provider rates.
- Saving Site configuration invalidates probe caches but does not trigger synchronization. Existing
  manual and scheduled Provider-level synchronization remains authoritative.
- Empty Sites without probe configuration are removed automatically. Configured empty Sites remain
  until an administrator deletes them, while Sites that still own Providers cannot be deleted.
- Provider Vendor reclustering and runtime Provider Endpoint selection do not move or redefine an
  Upstream Site; only the Provider's configured upstream URL determines Site membership.
