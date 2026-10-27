# TCOG migration status — 2026-10-27

## AI proposal preview identity fix — current handoff, 2026-10-27

PDF extraction and reviewed AI proposals were deployed in commit
208afe17647e5e8f001abb965b7f30be802a38a8, workflow 40507179127. Private runtime
rules were migrated separately; no proprietary rules belong in this public repo.
The operator configured the model through the private /ai/setup form. Automatic
agent execution, scheduler and external writes remain disabled.

The first paid-pilot attempt stopped before the model call: Gmail attachment
download IDs rotate between reads, invalidating previews of unchanged PDFs.
The fix uses message/MIME-position/metadata identity plus SHA-256 of actual PDF
bytes. Fresh-source, rule/configuration, incomplete-attachment and newer-thread
checks remain enforced. Synthetic regressions reproduced the old failure and now
pass on memory and PostgreSQL stores, including durable cache reuse and changed
source blocking. All 86 tests pass without real model calls. The operational
workflow also watches agent-ai.mjs to deploy this fix through the existing path.
Fix deployed in 0cc8fc3cdb6cb359975f15525d6708f92d77ee85; operational workflow
40510294808 completed successfully, including live readiness/OAuth checks.
Authenticated source read confirmed complete mail/PDF and stable attachment IDs.
Two consecutive free previews of the same known pilot task/context returned the
same operation_id (8 sources, 18720 characters), ai_called=false. No real model
call was made while fixing this bug; proposal quality remains untested by AI.
Do not automatically repeat the failed paid pilot; obtain authorization for a
fresh paid test. agent_status currently reports historical metadata_queue_only
and zero AI calls as constants; do not treat these as live deployment/usage proof.

## Current handoff — authoritative summary

This section supersedes earlier historical steps below.

- The public Cloud Run service is configured with PostgreSQL and Secret Manager.
- Registered ChatGPT app **TCOG FireTMS Cloud** is
  `asdk_app_6ae085e9fc40819191b0ae8ce2a568c9`. Its tools were available and
  authenticated reads succeeded in this chat: company identity, FireTMS vehicle
  `GDA81689`, Gmail mailbox `og@tcog.pl` plus 20 filters, PTV geocoding and routing.
  One initial FireTMS read returned a transient internal MCP error; subsequent
  reads and the identical vehicle lookup succeeded. No business writes were tested.
- Exact ChatGPT callback `https://chatgpt.com/connector/oauth/RiCpkjAKt4sn` is
  allowlisted via `OAUTH_ADDITIONAL_REDIRECT_URIS`. Client ID is `asystent-tcog`,
  token method `client_secret_post`; secret values stay in private configuration.
- Operational deployment run 40493476227 passed all 60 tests and live public
  OAuth/readiness checks, deploying revision `tcog-staging-00005-vqg`.
- Original package `Plugin_29d5605bc40081919d73502ae6ded0c6` is an imported
  desktop-only MCP package, distinct from the working registered cloud App.
  Replacing its bindings is optional; do not confuse it with the working App.
- Client instructions are verified in private plugin
  `Plugin_5d4109f6662c8191927bf44e93f393f4`, version **1.0.12**, release
  `pluginrel_6adf4cbf5c988191ae7de7d6a65bae77`: nine client profiles, general
  rules, kapownik/FireTMS procedure, mail classification rules and filter audit.
  They are **not yet included in the Cloud Run runtime**. Do not export their
  business content into this public repository without explicit authorization.
- Next agent-development work: private versioned client rules + backups; Gmail
  message/thread/attachment reads (current custom tools mainly manage filters);
  server-side Drive/Sheets authorization; durable task queue/history; processing
  graph and plan-change handling; approval-based pilot and monitoring.
- PostgreSQL currently persists OAuth codes and operation review receipts, not
  a full task queue, business history or learning memory. Automatic agent is off.
- Render has not been retired. Cloud App connection is now verified; any shutdown
  must first account for remaining apps that may still use Render (e.g. Asystent TCOG).
- Repository `AGENTS.md` supplies startup routing for future repository-backed
  tasks. It does not automatically configure unrelated ChatGPT chats or projects,
  and the operational App is not a cloud-admin connector.

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

## New Google Cloud plugin created

At the operator's explicit request, created a separate private workspace plugin
[TCOG FireTMS — Google Cloud](https://chatgpt.com/plugins/Plugin_29d5605bc40081919d73502ae6ded0c6).
ID `Plugin_29d5605bc40081919d73502ae6ded0c6`, release
`pluginrel_6ae07ec01e588191b71db9876511c87c`, version `1.0.0`.
Portable source is in `plugins/tcog-firetms-google-cloud/`.

The package connects directly to the verified Cloud Run `/mcp` endpoint using
provided OAuth client `asystent-tcog` and `client_secret_post`. Base/default
scopes are `firetms:read firetms:write ptv:read gmail:read gmail:write`.
It reuses the migrated server implementation and server-provided instructions;
no static tool schema copies or financial/DBK permissions are added. Client
secrets are not in the package. Original FireTMS app and operational client-rule
plugin are retained. Creator readback verified both portable and compatibility
MCP config. Installation and OAuth connection by the operator are still pending;
no new authenticated tools were available immediately after creation.

## Correction: imported MCP package is desktop-only

Operator reports the created plugin is available on desktop but absent on web.
Official documentation establishes the cause: imported plugin packages declaring
MCP servers in `mcp.json` or `.mcp.json` are marked Desktop only, including remote
HTTPS servers. This package has both declarations and no registered App binding.
Do not treat refreshing ChatGPT or successful package creation as a solution.

Sources:
- https://learn.chatgpt.com/docs/enterprise/plugin-management#desktop-only-plugins
- https://developers.openai.com/plugins/deploy/connect-chatgpt

Required repair: the operator registers the already verified Cloud Run `/mcp`
endpoint through ChatGPT web Plugins > + > Add custom MCP server, with OAuth
client `asystent-tcog` and the existing client secret entered only in that private
form. Obtain the exact new App/plugin connection reference. Then update the
existing `Plugin_29d5605bc40081919d73502ae6ded0c6` to reference that registered
App via `.app.json` and `extensions.com.openai.apps`, removing both bundled MCP
configuration files and any compatibility `mcpServers` declaration. Preserve
identity, sharing, and presentation. No App ID is known yet; do not invent one
or bind it to the old Render App. Until this is done the plugin is not web-ready.
