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
  # Use the stable API field for the storage cap (not available in every CLI).
  python3 - <<'PYAPI'
import json, subprocess, urllib.request, urllib.error
project='psychic-order-512811-k6'
token=subprocess.check_output(['gcloud','auth','print-access-token'],text=True).strip()
body={'name':'tcog-state','region':'europe-west3','databaseVersion':'POSTGRES_16','settings':{'tier':'db-g1-small','edition':'ENTERPRISE','availabilityType':'ZONAL','dataDiskType':'PD_SSD','dataDiskSizeGb':'10','storageAutoResize':True,'storageAutoResizeLimit':'20','deletionProtectionEnabled':True,'connectorEnforcement':'REQUIRED','ipConfiguration':{'ipv4Enabled':True,'authorizedNetworks':[],'sslMode':'ENCRYPTED_ONLY'},'backupConfiguration':{'enabled':True,'startTime':'02:00','location':'europe-west3','pointInTimeRecoveryEnabled':False,'backupRetentionSettings':{'retainedBackups':7,'retentionUnit':'COUNT'}},'maintenanceWindow':{'day':7,'hour':3,'updateTrack':'stable'}}}
request=urllib.request.Request('https://sqladmin.googleapis.com/sql/v1beta4/projects/'+project+'/instances',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
try:
    with urllib.request.urlopen(request,timeout=60) as response: operation=json.load(response)
except urllib.error.HTTPError as error:
    try: message=json.loads(error.read()).get('error',{}).get('message','')
    except Exception: message=''
    raise SystemExit('SQL provisioning HTTP '+str(error.code)+' '+message[:400]) from None
name=operation['name']
assert name and all(c.isalnum() or c=='-' for c in name)
subprocess.run(['gcloud','sql','operations','wait',name,'--project='+project,'--timeout=1200'],check=True)
PYAPI
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
