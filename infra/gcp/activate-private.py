#!/usr/bin/env python3
"""Guarded, private activation using an exact secret version and current image."""
import json
import subprocess

PROJECT='psychic-order-512811-k6'
REGION='europe-west3'
def command(*args):return subprocess.check_output(['gcloud',*args,'--project='+PROJECT],text=True).strip()
secret=json.loads(command('secrets','versions','describe','2','--secret=tcog-runtime-env','--format=json'))
assert secret['state']=='ENABLED','Private database configuration step is required'
sql=json.loads(command('sql','instances','describe','tcog-state','--format=json'))
assert sql['state']=='RUNNABLE' and sql['connectionName']==PROJECT+':'+REGION+':tcog-state'
service=json.loads(command('run','services','describe','tcog-staging','--region='+REGION,'--format=json'))
assert service['status']['url']=='https://tcog-staging-rcz56sj3hq-ey.a.run.app'
spec=service['spec']['template']['spec']
assert spec['serviceAccountName']=='tcog-runtime@'+PROJECT+'.iam.gserviceaccount.com'
container=spec['containers'][0]
image=container['image']
assert image.startswith(REGION+'-docker.pkg.dev/'+PROJECT+'/tcog/asystent:') or image.startswith(REGION+'-docker.pkg.dev/'+PROJECT+'/tcog/asystent@sha256:')
env={e['name']:e.get('value') for e in container.get('env',[])}
assert env.get('TCOG_SETUP_MODE') in ('true','false'),'Unexpected service mode'
# Run vendor-read and SQL-reconnect checks before replacing the setup revision.
command('run','jobs','deploy','tcog-migration-check','--region='+REGION,'--image='+image,'--service-account=tcog-runtime@'+PROJECT+'.iam.gserviceaccount.com','--tasks=1','--parallelism=1','--max-retries=0','--task-timeout=300','--cpu=1','--memory=512Mi','--command=node','--args=cloud-smoke.mjs','--set-env-vars=TCOG_ENV_FILE=/secrets/tcog/config.json','--set-secrets=/secrets/tcog/config.json=tcog-runtime-env:2','--set-cloudsql-instances='+PROJECT+':'+REGION+':tcog-state','--quiet')
command('run','jobs','execute','tcog-migration-check','--region='+REGION,'--wait','--quiet')
if env.get('TCOG_SETUP_MODE')=='true':
    command('run','services','update','tcog-staging','--region='+REGION,'--update-env-vars=TCOG_SETUP_MODE=false,TCOG_ENV_FILE=/secrets/tcog/config.json','--update-secrets=/secrets/tcog/config.json=tcog-runtime-env:2','--add-cloudsql-instances='+PROJECT+':'+REGION+':tcog-state','--quiet')
print('TCOG_PRIVATE_CONFIGURATION_APPLIED')
