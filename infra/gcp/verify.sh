#!/usr/bin/env bash
set -Eeuo pipefail
readonly TCOG_PROJECT_ID='psychic-order-512811-k6'
readonly TCOG_EXPECTED_NUMBER='411889473620'
readonly TCOG_DEPLOYER="tcog-github-deployer@${TCOG_PROJECT_ID}.iam.gserviceaccount.com"
tcog_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)')"
[[ "$tcog_account" == "$TCOG_DEPLOYER" ]] || { printf 'Wrong deployment identity\n' >&2; exit 1; }
tcog_number="$(gcloud projects describe "$TCOG_PROJECT_ID" --format='value(projectNumber)')"
[[ "$tcog_number" == "$TCOG_EXPECTED_NUMBER" ]] || { printf 'Wrong project\n' >&2; exit 1; }
gcloud projects describe "$TCOG_PROJECT_ID" --format='yaml(projectId,projectNumber,lifecycleState)'
gcloud services list --enabled --project="$TCOG_PROJECT_ID" --format='value(config.name)' --filter='config.name:(run.googleapis.com OR artifactregistry.googleapis.com OR iamcredentials.googleapis.com OR sts.googleapis.com)'
gcloud artifacts repositories describe tcog --location=europe-west3 --project="$TCOG_PROJECT_ID" --format='yaml(name,format)'
gcloud run services list --project="$TCOG_PROJECT_ID" --region=europe-west3 --filter='metadata.name~^tcog-' --format='table(metadata.name,status.url)'
printf 'TCOG_GCP_CONNECTION_OK\n'
