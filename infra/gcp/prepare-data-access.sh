#!/usr/bin/env bash
# Administrator-only step: enable data APIs and grant the migration roles.
# Does not create a SQL instance or import/expose any credential value.
set -Eeuo pipefail
readonly TCOG_PROJECT='psychic-order-512811-k6'
readonly TCOG_DEPLOYER="tcog-github-deployer@${TCOG_PROJECT}.iam.gserviceaccount.com"
readonly TCOG_RUNTIME="tcog-runtime@${TCOG_PROJECT}.iam.gserviceaccount.com"
[[ "$(gcloud projects describe "$TCOG_PROJECT" --format='value(projectNumber)')" == '411889473620' ]] || { printf 'Wrong project\n' >&2; exit 1; }
gcloud iam service-accounts describe "$TCOG_DEPLOYER" --project="$TCOG_PROJECT" --format='value(email)' >/dev/null
gcloud services enable sqladmin.googleapis.com secretmanager.googleapis.com --project="$TCOG_PROJECT" --quiet
gcloud projects add-iam-policy-binding "$TCOG_PROJECT" --member="serviceAccount:${TCOG_DEPLOYER}" --role=roles/cloudsql.admin --condition=None --quiet >/dev/null
gcloud projects add-iam-policy-binding "$TCOG_PROJECT" --member="serviceAccount:${TCOG_RUNTIME}" --role=roles/cloudsql.client --condition=None --quiet >/dev/null
if ! gcloud secrets describe tcog-runtime-env --project="$TCOG_PROJECT" --format='value(name)' >/dev/null 2>&1; then
  gcloud secrets create tcog-runtime-env --replication-policy=user-managed --locations=europe-west3 --project="$TCOG_PROJECT" --quiet
fi
gcloud secrets add-iam-policy-binding tcog-runtime-env --member="serviceAccount:${TCOG_RUNTIME}" --role=roles/secretmanager.secretAccessor --condition=None --project="$TCOG_PROJECT" --quiet >/dev/null
for tcog_role in roles/secretmanager.viewer roles/secretmanager.secretVersionAdder; do
  gcloud secrets add-iam-policy-binding tcog-runtime-env --member="serviceAccount:${TCOG_DEPLOYER}" --role="$tcog_role" --condition=None --project="$TCOG_PROJECT" --quiet >/dev/null
done
printf 'TCOG_GCP_DATA_ACCESS_OK\n'
