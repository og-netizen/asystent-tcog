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
