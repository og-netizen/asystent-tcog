#!/usr/bin/env python3
"""Operator-only migration. Secrets remain in memory; Render is read-only.

Run in Cloud Shell from a reviewed, pinned checkout. This does NOT deploy,
create a database, modify Gmail filters or activate the agent.
"""
import base64
import getpass
import json
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

PROJECT = 'psychic-order-512811-k6'
REGION = 'europe-west3'
TARGET = 'https://tcog-staging-rcz56sj3hq-ey.a.run.app'
SOURCE = 'https://asystent-tcog.onrender.com'
SERVICE = 'srv-daf9ivn40ujc73a9mu30'
SECRET = f'https://secretmanager.googleapis.com/v1/projects/{PROJECT}/secrets/tcog-runtime-env'
KEYS = set('ADMIN_PASSWORD OAUTH_CLIENT_SECRET OAUTH_REDIRECT_URIS WFIRMA_COMPANY_ID WFIRMA_ACCESS_KEY WFIRMA_SECRET_KEY WFIRMA_APP_KEY FIRETMS_API_KEY FIRETMS_BASE_URL FIRETMS_OPERATIONAL_PUT_VERIFIED PTV_API_KEY DBK_API_KEY DBK_API_SECRET GOOGLE_GMAIL_CLIENT_ID GOOGLE_GMAIL_CLIENT_SECRET GOOGLE_GMAIL_EXPECTED_EMAIL GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED'.split())
REQUIRED = set('ADMIN_PASSWORD OAUTH_CLIENT_SECRET WFIRMA_COMPANY_ID WFIRMA_ACCESS_KEY WFIRMA_SECRET_KEY WFIRMA_APP_KEY FIRETMS_API_KEY PTV_API_KEY GOOGLE_GMAIL_CLIENT_ID GOOGLE_GMAIL_CLIENT_SECRET GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED'.split())

class Stop(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def gcloud(*args):
    result = subprocess.run(['gcloud', *args], capture_output=True, text=True)
    if result.returncode:
        raise Stop('GCLOUD_FAILED: sprawdź konto i uprawnienia projektu.')
    return result.stdout.strip()

def request(url, token, body=None):
    if urllib.parse.urlsplit(url).hostname not in ('api.render.com', 'secretmanager.googleapis.com'):
        raise Stop('DESTINATION_REJECTED')
    headers = {'Authorization': 'Bearer '+token, 'Accept': 'application/json'}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
            raw = response.read(1048577)
            if len(raw)>1048576:
                raise Stop('RESPONSE_TOO_LARGE')
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        # Never reflect HTTP bodies: these may contain credential values.
        raise Stop(f'HTTP_{error.code}: {urllib.parse.urlsplit(url).hostname}') from None
    except (OSError, ValueError):
        raise Stop('NETWORK_OR_RESPONSE_ERROR') from None

def main():
    if not sys.stdin.isatty():
        raise Stop('Uruchom w interaktywnym terminalu Cloud Shell.')
    if gcloud('projects','describe',PROJECT,'--format=value(projectNumber)')!='411889473620':
        raise Stop('WRONG_PROJECT')
    run = json.loads(gcloud('run','services','describe','tcog-staging','--region='+REGION,'--project='+PROJECT,'--format=json'))
    env = {item['name']:item.get('value') for item in run['spec']['template']['spec']['containers'][0].get('env',[])}
    if run['status']['url']!=TARGET or env.get('TCOG_SETUP_MODE')!='true':
        raise Stop('STAGING_NOT_IN_SETUP_MODE')
    google_token = gcloud('auth','print-access-token')
    versions = request(SECRET+'/versions?pageSize=1',google_token)
    if versions.get('versions'):
        raise Stop('SECRET_ALREADY_HAS_VERSIONS: zatrzymano, aby nie nadpisać wcześniejszego transferu.')
    render_token = getpass.getpass('Wklej tymczasowy Render API key (niewidoczny): ').strip()
    if not render_token:
        raise Stop('EMPTY_RENDER_KEY')
    meta = request('https://api.render.com/v1/services/'+SERVICE,render_token)
    if meta.get('ownerId')!='tea-daf95u5bedkc7389u4u0' or meta.get('serviceDetails',{}).get('url')!=SOURCE:
        raise Stop('WRONG_RENDER_SERVICE')
    config, cursor, seen = {}, '', set()
    for _ in range(10):
        page = request('https://api.render.com/v1/services/'+SERVICE+'/env-vars?'+urllib.parse.urlencode({'limit':100,**({'cursor':cursor} if cursor else {})}),render_token)
        if not isinstance(page,list):
            raise Stop('INVALID_RENDER_RESPONSE')
        for item in page:
            var = item.get('envVar',{})
            if var.get('key') in KEYS:
                if not isinstance(var.get('value'),str):
                    raise Stop('INVALID_ENV_VALUE')
                config[var['key']] = var['value']
        if len(page)<100:
            break
        cursor = page[-1].get('cursor')
        if not cursor or cursor in seen:
            raise Stop('INVALID_RENDER_PAGINATION')
        seen.add(cursor)
    else:
        raise Stop('RENDER_PAGINATION_LIMIT')
    missing = sorted(key for key in REQUIRED if not config.get(key,'').strip())
    if missing:
        raise Stop('Brak zmiennych usługi (możliwa grupa Environment): '+', '.join(missing))
    if any(len(config[k])<32 for k in ('ADMIN_PASSWORD','OAUTH_CLIENT_SECRET')):
        raise Stop('INVALID_AUTH_CONFIGURATION')
    helper = Path(__file__).with_name('rebind-gmail.mjs')
    result = subprocess.run(['node',str(helper)],input=json.dumps({'config':config,'source':SOURCE,'target':TARGET}),capture_output=True,text=True)
    if result.returncode:
        raise Stop('Nie udało się bezpiecznie przepiąć zaszyfrowanego połączenia Gmail.')
    payload = result.stdout.encode()
    if len(payload)>65536:
        raise Stop('CONFIG_TOO_LARGE')
    # No retry: an uncertain addVersion response must be checked before repeating.
    saved = request(SECRET+':addVersion',google_token,{'payload':{'data':base64.b64encode(payload).decode()}})
    if not saved.get('name','').startswith(f'projects/411889473620/secrets/tcog-runtime-env/versions/'):
        raise Stop('SECRET_SAVE_RESPONSE_UNCERTAIN: sprawdź metadane przed ponowieniem.')
    print('TCOG_SECRET_TRANSFER_OK')
    print('Wersja sekretu: '+saved['name'].rsplit('/',1)[-1])
    print('Klucze zapisane. Render bez zmian. Agent w Google Cloud nadal wyłączony.')

if __name__=='__main__':
    try:
        main()
    except Stop as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        print('TRANSFER_FAILED: bez ujawniania danych. Sprawdź zasób sekretu przed ponowieniem.',file=sys.stderr)
        sys.exit(1)
