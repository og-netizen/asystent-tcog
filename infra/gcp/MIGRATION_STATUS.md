# TCOG migration status — 2026-10-27

## Verified live

- Project: `psychic-order-512811-k6` / `411889473620`; region `europe-west3`.
- Runtime: `tcog-staging`, URL `https://tcog-staging-rcz56sj3hq-ey.a.run.app`.
- Private activation verified at revision `tcog-staging-00004-964`; setup mode disabled.
- Operator subsequently enabled public invocation; application OAuth remains enforced.
- Configuration: exact Secret Manager version `tcog-runtime-env:2`; no values in Git.
- PostgreSQL 16 `tcog-state`, database `tcog_state`, runtime role `tcog_app`.
- Paid pilot sizing/backups/limits are documented in README and provision script.
- Native Gmail filters remain managed by Google; no watcher or AI queue is enabled.

GitHub run [40488406441](https://github.com/og-netizen/asystent-tcog/actions/runs/40488406441)
completed successfully. Cloud Run execution `tcog-migration-check-rlms2` checked:
SQL state survives closing/reopening the client and is consumed once; Gmail
refresh/profile for the expected mailbox; one read-only FireTMS truck query;
one PTV geocode and one route calculation. No transport order or mail filter
was created or changed. Probe rows use an isolated, expiring namespace.

Readiness, private IAM enforcement, MCP application authentication and OAuth
resource metadata all passed (`TCOG_PRIVATE_OPERATIONAL_OK`). This is not yet
a completed ChatGPT reconnection or an end-to-end live FireTMS write test.

## Public endpoint verified

After the operator's Cloud Shell change, direct unauthenticated HTTPS checks
returned 200 for `/health` and `/ready` with `operational:true` and
`state_storage:postgresql`. Authorization-server and protected-resource discovery
returned 200 with the Cloud Run origin and `/mcp` resource. An unauthenticated
POST to `/mcp` returned 401 with the OAuth challenge, as required. No application
access token or customer record was needed for these checks.

The GitHub deployer still deliberately lacks `run.services.setIamPolicy`; no
project IAM permissions were expanded. The private-only activation checker is
now historical: it intentionally expects an IAM-protected service and must not
be rerun after public cutover without updating that expectation.

## Next step: ChatGPT connection

Then update/reconnect the existing ChatGPT integration to the Cloud Run `/mcp`
URL, retaining OAuth client ID `asystent-tcog` and the existing secret via private
configuration. The available plugin-management tools do not edit an existing
App connection URL; the operator must update it in ChatGPT, or use the supported
custom MCP creation UI if URL editing is unavailable. Never ask for secrets in chat.
Add the new `/google/oauth/callback` to the existing Google OAuth client before
any future Gmail reauthorization. Existing Gmail refresh was privately rebound
and passed the live read check, so immediate reauthorization is unnecessary.

Render `srv-daf9ivn40ujc73a9mu30` remains active and is the current ChatGPT target.
Do not retire it before the new ChatGPT connection and relevant tools are verified.
Task queues, business history, automatic plan processing, controlled learning,
monitoring/alerts and a normal production deployment workflow remain future work.
The setup deployment workflow refuses to overwrite this operational service.
