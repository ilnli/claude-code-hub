---
status: accepted
---

# Separate public errors from administrator diagnostics

CCH will persist a Public Error Snapshot when a Failed Request is finalized instead of deriving
user-visible text later from administrator diagnostics. The User Error Summary exposes only the
existing final status, a safe reason, and the CCH Session ID; Provider and routing detail remains
private. If no diagnostic text can be proven safe, CCH uses a localized Safe Error Fallback rather
than risking partial redaction, because read-time sanitization can drift and expose retained raw
data under future rules.

Historical Request Records are not enriched: absence of a Public Error Snapshot preserves their
previous user-visible fields without deriving new detail from status, timestamps, or raw errors.
User read-only projections return only the User Error Summary; administrator projections retain
their existing diagnostic access.

The Request Record stores nullable `publicErrorCode` and `publicErrorMessage` fields and reuses its
existing final status and CCH Session ID. User projections explicitly allowlist those fields and
never fall back to the administrator `errorMessage` when the public fields are absent.

`publicErrorCode` belongs to a small stable User-safe taxonomy. Internal Provider, routing, circuit,
rule, and infrastructure codes map to that taxonomy and never cross the User API boundary directly.

Known public codes and Safe Error Fallbacks render through the five-language UI catalog in the
User's current locale. A safe dynamic message remains the request-time snapshot because CCH cannot
translate arbitrary upstream detail reliably; the stable code is not displayed.

The feature has no long-lived administrator toggle. User detail appears only when a new public error
field is present, so historical null fields retain their prior rendering and deployment follows the
nullable schema migration.

The cleanup-managed Request Record retains both public error fields. The permanent Usage Ledger
retains only `publicErrorCode`, never arbitrary dynamic public text; after detailed logs expire, the
UI renders the localized code or a Safe Error Fallback.

A logical request that succeeds after one or more failed Upstream Attempts has no Public Error
Snapshot. Attempt failures remain administrator diagnostics and do not create a contradictory User
error entry on a successful Request Record.

Administrator Error Detail shows the User Error Summary for support comparison and then the existing
privileged diagnostics. A Provider-Unassigned Request is labeled as not having reached an upstream,
without a synthetic Provider identity.
