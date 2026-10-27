#!/usr/bin/env python3
"""Cloud Shell operator step: least-privilege SQL user + private secret update.

No credential values on disk, argv or stdout. Does not activate Cloud Run.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

spec=importlib.util.spec_from_file_location('transfer',Path(__file__).with_name('import-render-secrets.py'))
transfer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)
Stop=transfer.Stop
PROJECT=transfer.PROJECT
CONNECTION=PROJECT+':europe-west3:tcog-state'
SQL='https://sqladmin.googleapis.com/sql/v1beta4/projects/'+PROJECT
PROXY='https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.26.3/cloud-sql-proxy.linux.amd64'
PROXY_SHA='5533a05cdbf12f8a0cb46db34c775847a496e181d47f863284d3d02b0fad49fa'

def sql_api(path,token,body=None,method='GET'):
    headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(SQL+path,data=data,headers=headers,method=method)
    try:
        with urllib.request.build_opener(transfer.NoRedirect).open(req,timeout=30) as r:
            return json.load(r)
    except Exception:
        raise Stop('CLOUD_SQL_API_FAILED: sprawdź operację w konsoli; nie ujawniono odpowiedzi.') from None

def reset_admin(token,password):
    op=sql_api('/instances/tcog-state/users?name=postgres',token,{'name':'postgres','password':password},'PUT')
    name=op.get('name','')
    if not name or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' for c in name):
        raise Stop('INVALID_SQL_OPERATION')
    for _ in range(120):
        status=sql_api('/operations/'+name,token)
        if status.get('status')=='DONE':
            if status.get('error'):raise Stop('SQL_ADMIN_PASSWORD_UPDATE_FAILED')
            return
        time.sleep(1)
    raise Stop('SQL_OPERATION_TIMEOUT: sprawdź stan operacji przed ponowieniem.')

def psql(host,password,statement,user='postgres',database='postgres',timeout=15):
    env={**os.environ,'PGHOST':host,'PGPORT':'5432','PGUSER':user,'PGDATABASE':database,'PGPASSWORD':password,'PGCONNECT_TIMEOUT':'5','PGSSLMODE':'disable','PSQL_HISTORY':'/dev/null'}
    return subprocess.run(['psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input=statement,text=True,capture_output=True,env=env,timeout=timeout)

def main():
    if not shutil.which('psql'):raise Stop('Brak psql. W Cloud Shell zainstaluj: sudo apt-get install -y postgresql-client')
    run=json.loads(transfer.gcloud('run','services','describe','tcog-staging','--region=europe-west3','--project='+PROJECT,'--format=json'))
    env={e['name']:e.get('value') for e in run['spec']['template']['spec']['containers'][0].get('env',[])}
    if run['status']['url']!=transfer.TARGET or env.get('TCOG_SETUP_MODE')!='true':raise Stop('STAGING_NOT_IN_SETUP_MODE')
    token=transfer.gcloud('auth','print-access-token')
    instance=sql_api('/instances/tcog-state',token)
    if instance.get('connectionName')!=CONNECTION or instance.get('state')!='RUNNABLE' or instance.get('databaseVersion')!='POSTGRES_16':raise Stop('DATABASE_NOT_READY')
    versions=transfer.request(transfer.SECRET+'/versions?pageSize=100',token)
    enabled={v['name'].rsplit('/',1)[-1] for v in versions.get('versions',[]) if v['state']=='ENABLED'}
    if enabled not in ({'1'},{'1','2'}) or versions.get('nextPageToken'):raise Stop('SECRET_VERSION_CHANGED: sprawdź postęp przed ponowieniem.')
    raw=transfer.request(transfer.SECRET+'/versions/1:access',token)
    config=json.loads(base64.b64decode(raw['payload']['data']))
    if config.get('PUBLIC_URL')!=transfer.TARGET or any(k.startswith('PG') for k in config):raise Stop('INVALID_IMPORTED_CONFIGURATION')
    app_password=secrets.token_urlsafe(40)
    if '2' in enabled:
        saved=transfer.request(transfer.SECRET+'/versions/2:access',token)
        previous=json.loads(base64.b64decode(saved['payload']['data']))
        if any(previous.get(k)!=v for k,v in config.items()) or previous.get('PGHOST')!='/cloudsql/'+CONNECTION or previous.get('PGDATABASE')!='tcog_state' or previous.get('PGUSER')!='tcog_app':raise Stop('PREVIOUS_DATABASE_CONFIG_MISMATCH')
        app_password=previous.get('PGPASSWORD','')
        if len(app_password)<40 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in app_password):raise Stop('INVALID_SAVED_DATABASE_PASSWORD')
    admin_password=secrets.token_urlsafe(40)
    with tempfile.TemporaryDirectory(prefix='tcog-db-') as directory:
        executable=Path(directory)/'proxy'
        # Only a public, pinned binary is written to disk; no credential files.
        with urllib.request.build_opener(transfer.NoRedirect).open(PROXY,timeout=60) as r:
            binary=r.read(60000001)
        if hashlib.sha256(binary).hexdigest()!=PROXY_SHA:raise Stop('PROXY_CHECKSUM_MISMATCH')
        executable.write_bytes(binary);executable.chmod(0o700)
        reset_admin(token,admin_password)
        process=subprocess.Popen([str(executable),'--gcloud-auth','--unix-socket',directory,CONNECTION],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            host=directory+'/'+CONNECTION
            for attempt in range(45):
                if process.poll() is not None:raise Stop('CLOUD_SQL_PROXY_FAILED')
                try:
                    ready=psql(host,admin_password,'SELECT 1;',timeout=7)
                    if ready.returncode==0:break
                except subprocess.TimeoutExpired:pass
                time.sleep(1)
            else:raise Stop('DATABASE_CONNECTION_FAILED')
            # A retry can repair an interrupted pilot while setup mode is still on.
            # Once version 2 exists its password is reused, never rotated here.
            check=psql(host,admin_password,"SELECT CASE WHEN rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) THEN 'unsafe' ELSE 'safe' END FROM pg_roles WHERE rolname='tcog_app';")
            if check.returncode or check.stdout.strip() not in ('','safe'):raise Stop('EXISTING_APPLICATION_ROLE_UNSAFE')
            if check.stdout.strip()=='safe':
                # PostgreSQL disallows ALTER of SUPERUSER/REPLICATION/BYPASSRLS
                # by a non-superuser, even when the requested values are false.
                action="ALTER ROLE tcog_app LOGIN PASSWORD '"+app_password+"'; "
            else:
                action="CREATE ROLE tcog_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+app_password+"'; "
            statement="BEGIN; "+action+"GRANT tcog_app TO postgres WITH SET TRUE; ALTER DATABASE tcog_state OWNER TO tcog_app; COMMIT;"
            created=psql(host,admin_password,statement)
            if created.returncode:raise Stop('APPLICATION_ROLE_SETUP_FAILED')
            check=psql(host,app_password,'SELECT current_user;',user='tcog_app',database='tcog_state')
            if check.returncode or check.stdout.strip()!='tcog_app':raise Stop('APPLICATION_DATABASE_LOGIN_FAILED')
            config.update(PGHOST='/cloudsql/'+CONNECTION,PGDATABASE='tcog_state',PGUSER='tcog_app',PGPASSWORD=app_password)
            payload=json.dumps(config).encode()
            if len(payload)>65536:raise Stop('CONFIG_TOO_LARGE')
            if '2' not in enabled:
                saved=transfer.request(transfer.SECRET+':addVersion',token,{'payload':{'data':base64.b64encode(payload).decode()}})
                if not saved.get('name','').endswith('/versions/2'):raise Stop('SECRET_SAVE_UNCERTAIN: sprawdź metadane przed ponowieniem.')
        finally:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()
            # Discard the temporary administrator credential. Only app password is saved.
            reset_admin(token,secrets.token_urlsafe(48))
    print('TCOG_DATABASE_CONFIG_OK')
    print('Konto aplikacji utworzone. Konfiguracja z bazą zapisana jako wersja 2.')
    print('Serwer pozostaje prywatny i w trybie przygotowania. Render działa.')

if __name__=='__main__':
    try:main()
    except Stop as error:
        print(str(error),file=sys.stderr);sys.exit(1)
    except KeyboardInterrupt:sys.exit(130)
    except Exception:
        print('DATABASE_CONFIG_FAILED: sprawdź metadane i poprzednią próbę; nie ujawniono danych.',file=sys.stderr);sys.exit(1)
