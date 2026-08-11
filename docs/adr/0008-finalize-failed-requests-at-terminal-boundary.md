---
status: accepted
---

# Finalize failed requests at the terminal boundary

Some attributable failures occur before the normal Provider-bound Request Record exists. CCH will
use one idempotent Failure Finalization path that updates an existing record or creates a
Provider-Unassigned Request only after the final non-2xx outcome is known. This preserves probe,
warmup, and replay short-circuit semantics and avoids stale in-progress rows; guard-specific
best-effort inserts are not a second recording path. Finalization uses bounded, awaited persistence,
but a recording failure raises an internal alert and never replaces the original client response.

Failure filters use the Failed Request definition: a non-null final client status outside the 2xx
range. They do not treat successful non-200 statuses or unfinished records as failures.

Status-based success-rate classification also uses only 2xx as success, eliminating the former 3xx
conflict. Existing exclusions for non-upstream outcomes such as limits, local guards, and unavailable
Provider selection remain unchanged, so the feature does not otherwise redefine operational health.

Public request-history APIs add `failedOnly=true`. The legacy `excludeStatusCode200` parameter keeps
its literal behavior and is deprecated; supplying both filters is rejected rather than assigned an
implicit precedence.

Authentication rejection is finalized only when credential resolution identifies a real User and
Key, such as a disabled or expired account. Missing, invalid, or conflicting credentials remain in
security and application logs because they cannot own a Request Record.

Once identity is attributable, CCH assigns the support CCH Session ID through a lightweight step
before recordable local guards. Full Session mutation and diagnostic content retention remain after
sensitive-content checks; assigning an ID does not retain the request body.

Pre-Identity Parse Failures remain outside Request History. This change does not reorder request-body
parsing and authentication.

Local guards return a structured Guard Failure rather than writing their own rows or requiring the
outer handler to parse a rendered error response. Thrown errors are normalized to the same terminal
inputs before Failure Finalization.

Each new Request Record receives a private Request UUID before persistence. A nullable unique
`request_uuid` column leaves historical rows untouched and makes insert retries conflict-safe after
an ambiguous commit; this identity is never exposed as User support detail.
