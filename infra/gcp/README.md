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
