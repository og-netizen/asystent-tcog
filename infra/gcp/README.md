# TCOG Google Cloud migration: bootstrap

Project `psychic-order-512811-k6`, number `411889473620`, region
`europe-west3` (Frankfurt). Repository metadata verified with GitHub:
`og-netizen/asystent-tcog`, repository ID `1360098137`, owner ID `326012925`.

## Step 1: operator bootstrap in Cloud Shell

Review and run `bootstrap.sh` as the project administrator. The script validates
the project number and enabled billing before mutations. It enables the APIs
needed for identity, Cloud Run and Artifact Registry, creates separate deployment
and runtime service accounts, and creates an empty Docker image repository.
It creates no service-account keys and never asks for pasted credentials.

GitHub authentication is limited by numeric repository and owner IDs, branch
`main`, and push/manual workflow events. Pull requests and forks do not match.
An existing provider with different trust settings is rejected, not overwritten.

The deployer receives Browser, Cloud Run Developer, Logs Viewer, Service Usage
Consumer, Artifact Registry Writer on the `tcog` image repository, and Service
Account User on the separate runtime account. The runtime account receives no
application permissions yet. No Owner/Editor, IAM administration, secret reads,
SQL administration or billing management is granted to the deployer.

Deployment permission can change application code; add application secret/database
access to the runtime identity only when that migration step is reviewed.

## Step 2: verify GitHub access

The connection-check workflow performs read-only calls after federated login.
The initial push may fail before Cloud Shell bootstrap has been completed. After
bootstrap and IAM propagation, rerun the failed workflow (or start it manually).
Never print access tokens, credential files, runtime secrets or complete env vars.

The workflow only verifies identity and migration resources. It does not deploy
the application or change the current Render/ChatGPT connection.

## Remaining migration work

- Add durable storage for OAuth codes, review receipts, task state and deduplication.
- Select and price the PostgreSQL setup, backups and retention.
- Containerize the existing service and deploy a separately tested Cloud Run copy.
- Import keys into Secret Manager through an authorized secret flow.
- Reauthorize Gmail: its current encrypted refresh envelope is origin-bound.
- Configure public access for the MCP service separately; Cloud Run Developer
  does not grant service IAM management.
- Test Gmail/PTV/FireTMS read paths, separately review writes and verify restart
  behavior before changing the ChatGPT server URL or retiring Render.
- Keep native Gmail filters in place. No AI watcher/queue is enabled here.

References: Google Cloud documentation for workload identity federation with
deployment pipelines and Cloud Run container deployment; official
`google-github-actions/auth` and `setup-gcloud` actions. Action revisions are pinned.

## Staging container and SQL state adapter (next stage)

`gcp-staging.yml` builds and tests a container, publishes it to the existing image
repository, and creates private `tcog-staging` in `europe-west3`. Settings: one
vCPU, 512 MiB, minimum zero and maximum one instance, request-based default
billing. Docker image storage and requests may incur usage charges. No SQL
instance is created by this workflow. Its service URL stays IAM-protected.

Setup mode only reports health. Operational readiness is 503 and all MCP/Google
OAuth routes are disabled until configuration and SQL are present. It is not a
working replacement for Render yet. The existing npm start entry point on Render
is preserved. The staging workflow refuses to reset an operational service to
setup mode.

Cloud startup uses a Secret Manager JSON file (`TCOG_ENV_FILE`) with a bounded
set of configuration keys, then requires a `/cloudsql/` Unix socket and database
credentials. OAuth code consumption and Gmail/FireTMS review claims use SQL
atomic operations. Interrupted writes retain their in-progress/unknown state;
no automatic retry is enabled. The database adapter is tested against the actual
PostgreSQL engine embedded in PGlite, including two competing application clients.
This does not replace the later live Cloud SQL/restart checks.

`prepare-data-access.sh` is the next project-administrator step. Review it before
execution: it grants the GitHub deployer **Cloud SQL Admin on this project** and
adds a single empty `tcog-runtime-env` secret replicated in Frankfurt. The runtime
gets Cloud SQL Client and read access to that secret. The deployer can add secret
versions and read metadata, but cannot read secret values directly. Deployed code
can use runtime secret access, so keep deployment access restricted to this repo.
No database instance, password or application credential is created by this step.

The SQL instance size, backups, recurring cost and secret transfer must be settled
before provisioning. Existing Render credentials are not available through the
current connector's read tools; use an authorized operator transfer into Secret
Manager, never a chat message or public GitHub workflow log. Gmail's encrypted
token remains bound to its original origin and must be reauthorized or explicitly
re-encrypted in an authorized private migration process.

Task queues, plan history, experience feedback, classifiers and learning behavior
are still future application features. The current SQL table stores expiring
OAuth and operation receipts only; do not describe it as deployed agent memory.

## Operator-only credential import

`import-render-secrets.py` runs interactively in Cloud Shell using the operator's
Google identity and a temporary Render API key entered via a hidden prompt.
It reads only the pinned Render service, checks workspace/URL and Cloud Run setup
mode, copies an explicit configuration allowlist to one Secret Manager version,
and re-encrypts the existing Gmail envelope for the verified Cloud Run origin.
The helper imports the application's existing encryption implementation. No
plaintext token, Render API key or credential file is written to disk or printed.
Only direct service environment variables are supported; missing variables from
environment groups abort the import. Existing secret versions also abort it.
Inspect metadata after an uncertain network response instead of retrying blindly.

The import does not create SQL, change the production service, refresh Gmail
credentials, modify filters, enable public access or activate the agent. Database
connection settings must be added through a separate private operator step before
activation. Add the new `/google/oauth/callback` URL to the existing Google OAuth
client before future reauthorization; the existing callback remains valid on Render.
Revoke the temporary Render API key after a successful import.
