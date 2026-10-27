#!/usr/bin/env python3
"""Private service readiness and OAuth metadata; no vendor writes or secret reads."""
import json
import os
import urllib.error
import urllib.request

URL='https://tcog-staging-rcz56sj3hq-ey.a.run.app'
TOKEN=os.environ['TCOG_ID_TOKEN']
def get(path,authenticated=True,method='GET'):
    request=urllib.request.Request(URL+path,headers={'Authorization':'Bearer '+TOKEN} if authenticated else {},method=method,data=b'{}' if method=='POST' else None)
    try:
        with urllib.request.urlopen(request,timeout=40) as response:return response.status,response.read()
    except urllib.error.HTTPError as error:return error.code,error.read()

assert get('/health',False)[0] in (401,403),'Private Cloud Run IAM check failed'
for path in ('/health','/ready'):
    status,raw=get(path);assert status==200,'Service is not ready'
    health=json.loads(raw)
    assert health.get('operational') is True and health.get('state_storage')=='postgresql'
status,raw=get('/.well-known/oauth-protected-resource/mcp')
assert status==200 and json.loads(raw)['resource']==URL+'/mcp','OAuth resource origin mismatch'
assert get('/mcp',method='POST')[0]==401,'Application OAuth authentication must remain enforced'
print('TCOG_PRIVATE_OPERATIONAL_OK')
