#!/usr/bin/env python3
"""Use short-lived CI credentials without printing tokens or runtime config."""
import json, os, subprocess, urllib.request, urllib.error

PROJECT = 'psychic-order-512811-k6'
REGION = 'europe-west3'
SERVICE = 'tcog-staging'

def command(*args):
    return subprocess.check_output(['gcloud', *args, '--project='+PROJECT], text=True).strip()

description = json.loads(command('run', 'services', 'describe', SERVICE, '--region='+REGION, '--format=json'))
url = description['status']['url']
if not url.startswith('https://') or not url.endswith('.run.app'):
    raise RuntimeError('Unexpected Cloud Run URL')
token = os.environ['TCOG_ID_TOKEN']

def request(path, authenticated=True, method='GET'):
    req = urllib.request.Request(url+path, headers={'Authorization': 'Bearer '+token} if authenticated else {}, method=method, data=b'{}' if method=='POST' else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()

assert request('/health', False)[0] in (401, 403), 'Staging must require Cloud Run IAM'
status, body = request('/health')
assert status == 200, 'Authenticated health failed'
health = json.loads(body)
assert health.get('operational') is False and health.get('configuration') == 'awaiting-secrets-and-database'
assert request('/ready')[0] == 503, 'Do not report readiness without SQL/secrets'
assert request('/mcp', method='POST')[0] == 503, 'MCP must remain disabled in setup'
print(json.dumps({'status':'TCOG_CLOUD_STAGING_OK', 'url':url, 'health':health}, ensure_ascii=False))
