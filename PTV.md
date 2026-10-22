## PTV routing and geocoding (0.6.0)

Set `PTV_API_KEY` in the existing Render service Environment page, never in this repository.
The key must allow PTV Developer Routing and Geocoding & Places. No additional OAuth client or secret is needed.
Refresh the existing ChatGPT plugin tools and reconnect with **`firetms:read firetms:write ptv:read`** (keep any previously used scopes).
New PTV tools are visible and callable only with `ptv:read`; existing FireTMS-only tokens cannot use PTV.
The consent page discloses sharing selected addresses/coordinates with PTV and consuming subscription limits.

- `ptv_status`: key presence and the last startup connection test, never the key. No upstream call.
- `ptv_geocode`: up to 5 address candidates with match quality, reference and road-access coordinates. The operator/agent must verify country, postal code, street and house number; no automatic first-result selection.
- `ptv_route`: 2–20 verified coordinates in their given order, profile `EUR_TRAILER_TRUCK`, optional actual vehicle overrides (dimensions **cm**, weights **kg**), explicit-zone departure and traffic mode. Returns total and per-leg distances, travel time, violations, combined transport events and warnings. Partial/absent critical vehicle overrides are explicitly marked for confirmation.

Routes do not reorder loading stops or book ferries. By default they avoid ferries and rail shuttles; avoidance is a preference, so returned combined transports trigger review. Calculate road portions before/after an agreed ferry separately; never enter a total that includes sea travel into a road-kilometre field.
Travel time excludes driver rest and handling; a non-violated route alone does not establish compliance with all driving bans. For Austria, retain TCOG's separate current truckban.eu check. No map&guide parity is claimed until matching profile, routing settings and a representative route are compared.

All calls use fixed HTTPS vendor endpoints and send the key only in an `ApiKey` header; redirects are not followed. No raw upstream error or credential is exposed. There are no automatic retries. In-memory caches: geocoding 24h, routes 5 minutes; max 256 entries and 100 upstream requests per rolling hour per process (both reset after restart, not a contractual billing cap). Identical in-flight calls are coalesced.
At each service start, if configured, one public-address geocoding test and one short Gdansk–Gdynia truck-route test run. `PTV_DIAGNOSTIC` logs only success/failure, candidate count and sample distance/time, never keys. Thus a restart uses at most two PTV requests. Disable/remove this startup test when production monitoring is established.

These tools do not write to Google Sheets or FireTMS. Route outputs must be reviewed before a separately authorized write.
Tests: `node --test test.mjs pilot/test.mjs firetms.test.mjs ptv.test.mjs`.
Official specifications checked 2026-10-22:
- https://api.myptv.com/meta/services/routing/v1/openapi.json
- https://api.myptv.com/meta/services/geocoding/v1/openapi.json

## Route details and PDF reports (0.7.0)

`ptv_route` now requests `ROUTE_ID`, `POLYLINE` (GeoJSON) and `MANEUVER_EVENTS`
alongside the existing safety results. `road_sequence` and `main_roads` are ordered
roads actually entered (`maneuver.roadAhead.number`); roads occurring only on a
signpost are not added. `signposted_directions` are signposted destinations, not
proof that the route visits those cities. Main roads are motorway runs or runs
at least 5 km long. No city list is fabricated from the distance or endpoint names.

Optional arguments:
- `include_geometry: true` returns the complete GeoJSON line (otherwise the full
  line is retained server-side for the report, with availability/count returned).
- `include_tolls: true` requests costs, sections and tariff systems in the same
  upstream calculation, not a second potentially different route.
- `currency: "EUR"` requests the converted total in that currency. Native currency
  totals remain separate; converted totals are not added again.
- Vehicle inputs add `emissionStandard`, `co2EmissionClass` (1–5) and
  `totalTechnicallyPermittedWeight` (kg). All actual dimensions, weights, axle count,
  EURO and CO2 class must be checked. Missing inputs mark costs for review. Use the
  actual planned departure for future tariffs; an absent departure uses PTV defaults.

The response contains a cryptographically random `route_token`, expiring after
30 minutes (or on process restart/eviction). Invoke:

```json
{"name":"ptv_route_report","arguments":{"route_token":"<from ptv_route>","title":"Plan trasy"}}
```

The original route must have `include_tolls: true`. The PDF uses that immutable
route snapshot for the distance, geometry, road sequence, parameters and toll
rows. No new routing is performed while generating a PDF. It includes totals by
country/currency, toll sections, tariff versions and visible review notes.
Missing toll data is printed as unavailable, never as zero. All costs are vendor
estimates, not a financial posting, invoice, payment or guarantee.

A map background uses at most 16 fixed-host PTV Raster Maps image tiles, charged
against the same local 100-request/hour guard and cached for 5 minutes. The PTV
key must also allow Raster Maps for this background. The original map attribution
is requested on every tile. If tiles cannot be fetched/decoded, the PDF explicitly
labels the line-only drawing as a route schematic (`map_kind=route_schematic`),
with a `map_warning`; it does not claim to contain a full map. `ptv_raster` indicates
a PTV map background. No key is embedded in the PDF or browser-visible URL.

Generation and the new tool require the existing `ptv:read` scope. Download is an
unguessable capability URL (`/ptv-reports/<random>.pdf`), accessible to anyone it is
shared with, for 30 minutes or until restart/eviction. Cache headers forbid client
caching; there is no listing endpoint. At most 20 snapshots and 20 PDFs are kept
in memory; PDFs are capped at 6 MB, generation concurrency at 2. This ephemeral
storage is appropriate for immediate download only; save a downloaded report to
Library or another approved destination for long-term retention.

After deployment refresh the existing TCOG FireTMS tool catalog. No additional
OAuth scope or FireTMS permission is needed. Test suite: `npm test` (34 tests).

Specifications checked 2026-10-22:
- https://api.myptv.com/meta/services/routing/v1/openapi.json (v1.41)
- https://api.myptv.com/meta/services/rastermaps/v1/openapi.json
