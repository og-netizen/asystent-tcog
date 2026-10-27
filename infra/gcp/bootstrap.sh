#!/usr/bin/env bash
# Run once as the project administrator in Google Cloud Shell.
# No service account keys are generated. Do not run with bash -x.
set -Eeuo pipefail
trap 'printf "Konfiguracja zatrzymana na linii %s. Nie ponawiaj po bledzie uprawnien bez sprawdzenia komunikatu.\n" "$LINENO" >&2' ERR

readonly TCOG_PROJECT_ID='psychic-order-512811-k6'
readonly TCOG_PROJECT_NUMBER='411889473620'
readonly TCOG_REGION='europe-west3'
readonly TCOG_REPO_ID='1360098137'
readonly TCOG_OWNER_ID='326012925'
readonly TCOG_POOL='tcog-github'
readonly TCOG_PROVIDER='github'
readonly TCOG_DEPLOYER="tcog-github-deployer@${TCOG_PROJECT_ID}.iam.gserviceaccount.com"
readonly TCOG_RUNTIME="tcog-runtime@${TCOG_PROJECT_ID}.iam.gserviceaccount.com"
readonly TCOG_MAPPING='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id'
readonly TCOG_CONDITION="assertion.repository_id=='${TCOG_REPO_ID}' && assertion.repository_owner_id=='${TCOG_OWNER_ID}' && assertion.ref=='refs/heads/main' && assertion.event_name in ['push','workflow_dispatch']"

command -v gcloud >/dev/null
command -v python3 >/dev/null
printf 'Sprawdzam projekt TCOG i wlaczone rozliczenia...\n'
tcog_actual_number="$(gcloud projects describe "$TCOG_PROJECT_ID" --format='value(projectNumber)')"
if [[ "$tcog_actual_number" != "$TCOG_PROJECT_NUMBER" ]]; then
  printf 'Niezgodny numer projektu; przerwano przed zmianami.\n' >&2
  exit 1
fi
tcog_billing="$(gcloud billing projects describe "$TCOG_PROJECT_ID" --format='value(billingEnabled)')"
if [[ "${tcog_billing,,}" != 'true' ]]; then
  printf 'Rozliczenia nie sa wlaczone; przerwano przed zmianami.\n' >&2
  exit 1
fi

gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com run.googleapis.com artifactregistry.googleapis.com --project="$TCOG_PROJECT_ID" --quiet

ensure_account() {
  local account_id="$1" account_email="$2" display_name="$3"
  if ! gcloud iam service-accounts describe "$account_email" --project="$TCOG_PROJECT_ID" --format='value(email)' >/dev/null 2>&1; then
    gcloud iam service-accounts create "$account_id" --display-name="$display_name" --project="$TCOG_PROJECT_ID" --quiet
  fi
}
ensure_account 'tcog-github-deployer' "$TCOG_DEPLOYER" 'TCOG GitHub deployment'
ensure_account 'tcog-runtime' "$TCOG_RUNTIME" 'TCOG application runtime'

if ! gcloud iam workload-identity-pools describe "$TCOG_POOL" --location=global --project="$TCOG_PROJECT_ID" --format='value(name)' >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$TCOG_POOL" --location=global --display-name='TCOG GitHub' --project="$TCOG_PROJECT_ID" --quiet
fi

if tcog_provider_json="$(gcloud iam workload-identity-pools providers describe "$TCOG_PROVIDER" --workload-identity-pool="$TCOG_POOL" --location=global --project="$TCOG_PROJECT_ID" --format=json 2>/dev/null)"; then
  # Never silently widen or replace an existing trust configuration.
  python3 -c 'import json,sys; p=json.loads(sys.argv[1]); mapping=dict(x.split("=",1) for x in sys.argv[2].split(",")); assert p.get("attributeMapping")==mapping and p.get("attributeCondition")==sys.argv[3] and p.get("oidc",{}).get("issuerUri")=="https://token.actions.githubusercontent.com" and not p.get("disabled",False), "Istniejacy provider ma inna konfiguracje. Wymagana weryfikacja."' "$tcog_provider_json" "$TCOG_MAPPING" "$TCOG_CONDITION"
else
  gcloud iam workload-identity-pools providers create-oidc "$TCOG_PROVIDER" --workload-identity-pool="$TCOG_POOL" --location=global --issuer-uri='https://token.actions.githubusercontent.com' --attribute-mapping="$TCOG_MAPPING" --attribute-condition="$TCOG_CONDITION" --project="$TCOG_PROJECT_ID" --quiet
fi

# The numeric repository ID is immutable; matching only a repo name is weaker.
gcloud iam service-accounts add-iam-policy-binding "$TCOG_DEPLOYER" --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/${TCOG_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${TCOG_POOL}/attribute.repository_id/${TCOG_REPO_ID}" --condition=None --project="$TCOG_PROJECT_ID" --quiet

# Deployment permissions, not project Owner/Editor or IAM administrator.
# SQL, secrets, mail and public-service IAM are separate migration steps.
for tcog_role in roles/browser roles/run.developer roles/logging.viewer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$TCOG_PROJECT_ID" --member="serviceAccount:${TCOG_DEPLOYER}" --role="$tcog_role" --condition=None --quiet >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$TCOG_RUNTIME" --member="serviceAccount:${TCOG_DEPLOYER}" --role=roles/iam.serviceAccountUser --condition=None --project="$TCOG_PROJECT_ID" --quiet

if ! gcloud artifacts repositories describe tcog --location="$TCOG_REGION" --project="$TCOG_PROJECT_ID" --format='value(name)' >/dev/null 2>&1; then
  gcloud artifacts repositories create tcog --repository-format=docker --location="$TCOG_REGION" --description='TCOG application images' --project="$TCOG_PROJECT_ID" --quiet
fi
gcloud artifacts repositories add-iam-policy-binding tcog --location="$TCOG_REGION" --member="serviceAccount:${TCOG_DEPLOYER}" --role=roles/artifactregistry.writer --condition=None --project="$TCOG_PROJECT_ID" --quiet

printf '\nTCOG_GCP_BOOTSTRAP_OK\nProject: %s\nRegion: %s\nGitHub: og-netizen/asystent-tcog (main)\n' "$TCOG_PROJECT_ID" "$TCOG_REGION"
printf 'IAM moze potrzebowac kilku minut na propagacje. Wroc do czatu i napisz: gotowe.\n'
