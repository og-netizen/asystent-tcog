#!/usr/bin/env python3
"""Read-only live checks: health, OAuth discovery, and exact callback allowlist."""
import json
import urllib.error
import urllib.parse
import urllib.request

URL='https://tcog-staging-rcz56sj3hq-ey.a.run.app'
CALLBACK='https://chatgpt.com/connector/oauth/RiCpkjAKt4sn'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
def request(path,method='GET'):
    req=urllib.request.Request(URL+path,method=method,data=b'{}' if method=='POST' else None)
    try:
        with urllib.request.build_opener(NoRedirect).open(req,timeout=40) as r:return r.status,r.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
for path in ('/health','/ready'):
    status,raw=request(path);assert status==200
    data=json.loads(raw);assert data.get('operational') is True and data.get('state_storage')=='postgresql'
status,raw=request('/.well-known/oauth-protected-resource/mcp')
assert status==200 and json.loads(raw)['resource']==URL+'/mcp'
assert request('/mcp','POST')[0]==401
for callback,expected in ((CALLBACK,200),(CALLBACK+'other',400),('https://evil.example/oauth/callback',400)):
    q=urllib.parse.urlencode({'client_id':'asystent-tcog','redirect_uri':callback,'response_type':'code','code_challenge_method':'S256','code_challenge':'A'*43,'scope':'firetms:read ptv:read gmail:read','resource':URL+'/mcp'})
    status,raw=request('/authorize?'+q);assert status==expected,'OAuth callback acceptance mismatch'
    if expected==200:assert b'name="password"' in raw
print('TCOG_PUBLIC_OAUTH_CALLBACK_OK')
