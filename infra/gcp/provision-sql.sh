#!/usr/bin/env bash
# Small, zonal pilot. No passwords, secret values or application data here.
set -Eeuo pipefail
readonly project='psychic-order-512811-k6'
readonly instance='tcog-state'
[[ "$(gcloud projects describe "$project" --format='value(projectNumber)')" == '411889473620' ]]
gcloud secrets versions describe 1 --secret=tcog-runtime-env --project="$project" --format=json > /tmp/tcog-secret-metadata.json
python3 - <<'PY'
import json
assert json.load(open('/tmp/tcog-secret-metadata.json'))['state']=='ENABLED', 'Imported configuration version 1 is required'
PY
gcloud sql instances list --project="$project" --format=json > /tmp/tcog-sql-metadata.json
if python3 - <<'PY'
import json
raise SystemExit(0 if any(x['name']=='tcog-state' for x in json.load(open('/tmp/tcog-sql-metadata.json'))) else 1)
PY
then
  gcloud sql instances describe "$instance" --project="$project" --format=json > /tmp/tcog-existing-sql.json
  python3 - <<'PY'
import json
x=json.load(open('/tmp/tcog-existing-sql.json'));s=x['settings']
assert x['region']=='europe-west3' and x['databaseVersion']=='POSTGRES_16'
assert s['tier']=='db-g1-small' and s['availabilityType']=='ZONAL'
assert not s.get('ipConfiguration',{}).get('authorizedNetworks'), 'Public authorized networks are forbidden'
assert s.get('deletionProtectionEnabled') is True
PY
else
  gcloud sql instances create "$instance" --project="$project" --region=europe-west3 --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-g1-small --availability-type=ZONAL --storage-type=SSD --storage-size=10 --storage-auto-increase --storage-auto-increase-limit=20 --backup-start-time=02:00 --backup-location=europe-west3 --retained-backups-count=7 --deletion-protection --ssl-mode=ENCRYPTED_ONLY --connector-enforcement=REQUIRED --maintenance-window-day=SUN --maintenance-window-hour=3 --quiet
fi
gcloud sql databases list --instance="$instance" --project="$project" --format='value(name)' > /tmp/tcog-db-names.txt
if ! python3 - <<'PY'
from pathlib import Path
raise SystemExit(0 if 'tcog_state' in Path('/tmp/tcog-db-names.txt').read_text().splitlines() else 1)
PY
then
  gcloud sql databases create tcog_state --instance="$instance" --project="$project" --quiet
fi
gcloud sql instances describe "$instance" --project="$project" --format='yaml(name,connectionName,state,region,databaseVersion,settings.tier,settings.dataDiskSizeGb,settings.backupConfiguration,settings.deletionProtectionEnabled)'
printf 'TCOG_SQL_PROVISIONED\n'
