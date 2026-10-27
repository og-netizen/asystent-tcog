# TCOG project guidance

## Resume work without repeating setup

Before continuing infrastructure, authentication or agent-development work, read
`infra/gcp/MIGRATION_STATUS.md`, starting with its **Current handoff** section.
Then inspect the current code and live evidence relevant to the requested change.
Historical sections record earlier migration stages, not the present connection.
Keep that handoff current after verified progress so Oskar does not have to paste
prior-chat history or repeat project identifiers. Do not assume access to the full
conversation history. Reply to Oskar in concise Polish.

Reuse the existing Google Cloud project, service accounts, GitHub federation,
Secret Manager configuration and connected apps. Do not ask the user to recreate
API keys, OAuth clients or the cloud project unless a concrete fault requires it.
The operational MCP app is `asdk_app_6ae085e9fc40819191b0ae8ce2a568c9`
(TCOG FireTMS Cloud). Its operational tools do not grant cloud administration.
Cloud deployments use the existing GitHub Actions identity federation; no static
Google service-account key is needed. Access in a new chat still depends on the
apps and repository context actually exposed to that chat.

## Source and authorization boundaries

The repository is public. Never commit credentials, secret payloads, access
or refresh tokens, or proprietary client-profile exports. Use private approved
storage for client rules. Their current authoritative source is the private
TCOG Operacyjny plugin; see the handoff for its identity and version.

The agent is operational: driver plans, kapowniki, routing and authorized FireTMS
operations. It does not handle invoices, payments or financial settlement.
Do not send messages to drivers/clients without explicit authorization.
Follow tool OAuth scopes, review-token requirements and existing write guards.
Do not retry uncertain FireTMS writes or create real orders as connection tests.
A project note is not authorization to broaden IAM or expose secrets.

## Deployment and verification

Use the operational Cloud Run workflow for the configured service. Setup/private
migration workflows are historical and can reject an already operational/public
service. Read the relevant workflow before choosing it; preserve secret mounts,
SQL connections, service identity and current traffic configuration.

Inspect fresh remote main and preserve other changes. Use guarded updates and
never force a branch to bypass a conflict. For authentication, storage or API
behavior changes, run the meaningful existing test suite (`npm test`) and verify
applicable live read paths. Documentation-only changes do not need that suite.
Report what was verified and what remains unverified. No autonomous mail worker
or learning system should be claimed deployed merely because the MCP API works.
