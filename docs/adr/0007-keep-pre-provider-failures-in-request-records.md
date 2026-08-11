---
status: accepted
---

# Keep pre-Provider failures in Request Records

An attributable request can fail before any Provider is assigned. CCH will retain that outcome in
the normal Request Record with optional Provider attribution, rather than splitting failures into a
second table or assigning a synthetic Provider, so history and request totals keep one contract
without creating false Provider attribution.

General administrator and User Request History, filters, totals, exports, and Session views include
these records. Provider-scoped projections exclude them because they have no Provider attribution.

The generated schema migration makes Provider attribution nullable and changes only historical
sensitive-word records with `providerId = 0` to null. It does not enrich any historical public error
data or reinterpret other Provider identifiers. The same narrow normalization applies to matching
Usage Ledger rows so both projections retain identical attribution.

The Usage Ledger also permits null initial and final Provider attribution and receives a zero-cost,
zero-token projection for each Provider-Unassigned Request. These rows contribute to User and Key
request totals but are excluded from Provider projections and never imply an Upstream Attempt.

Request totals use a request-count condition separate from billing conditions. An attributable local
failure still contributes one request even when a blocked-request or zero-usage rule excludes it from
billing; existing warmup and replay counting semantics remain unchanged.
