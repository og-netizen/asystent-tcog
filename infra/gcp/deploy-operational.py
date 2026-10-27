#!/usr/bin/env python3
"""Update an already configured Cloud Run service without replacing secrets/IAM."""
import json
import os
import re
import subprocess

PROJECT='psychic-order-512811-k6'
REGION='europe-west3'
URL='https://tcog-staging-rcz56sj3hq-ey.a.run.app'
CALLBACK='https://chatgpt.com/connector/oauth/RiCpkjAKt4sn'
def command(*args):return subprocess.check_output(['gcloud',*args,'--project='+PROJECT],text=True).strip()
service=json.loads(command('run','services','describe','tcog-staging','--region='+REGION,'--format=json'))
assert service['status']['url']==URL
spec=service['spec']['template']['spec']
assert spec['serviceAccountName']=='tcog-runtime@'+PROJECT+'.iam.gserviceaccount.com'
env={e['name']:e.get('value') for e in spec['containers'][0].get('env',[])}
assert env.get('TCOG_SETUP_MODE')=='false' and env.get('TCOG_ENV_FILE')=='/secrets/tcog/config.json','Configured operational service required'
assert service['metadata'].get('annotations',{}).get('run.googleapis.com/invoker-iam-disabled')=='true','Expected public service with application OAuth'
sha=os.environ['GITHUB_SHA'];assert re.fullmatch('[0-9a-f]{40}',sha)
image=REGION+'-docker.pkg.dev/'+PROJECT+'/tcog/asystent:'+sha
command('run','services','update','tcog-staging','--region='+REGION,'--image='+image,'--update-env-vars=OAUTH_ADDITIONAL_REDIRECT_URIS='+CALLBACK,'--quiet')
print('TCOG_OPERATIONAL_IMAGE_UPDATED')
