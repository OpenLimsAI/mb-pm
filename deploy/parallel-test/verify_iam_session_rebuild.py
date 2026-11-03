"""Isolated real Casdoor session test. Never reuses production DB/config/containers."""
import json, os, secrets, subprocess as sp, time, urllib.request, urllib.error, urllib.parse
from http.cookies import SimpleCookie
from pathlib import Path
os.umask(0o077)
run_id='iam-session-proof-'+secrets.token_hex(5)
root=Path('/home/prometheus/mb-pm-v2/releases')/run_id
root.mkdir(mode=0o700)
network=run_id
app=run_id+'-iam'
db=run_id+'-db'
volume=run_id+'-sessions'
image=json.loads(sp.check_output(['docker','inspect','mb-pm-v2-casdoor-1']))[0]['Image']
dbimage=json.loads(sp.check_output(['docker','inspect','mb-pm-v2-iam-db-1']))[0]['Image']
created=[]
def run(args, **kw):
 return sp.run(args,check=True,stdout=sp.DEVNULL,stderr=sp.DEVNULL,**kw)
def cap(args):
 return sp.check_output(args,stderr=sp.DEVNULL)
def remove_app():
 run(['docker','rm','-f',app])
def address():
 return 'http://'+json.loads(cap(['docker','inspect',app]))[0]['NetworkSettings']['Networks'][network]['IPAddress']+':8000'
cookies={}
def request(path, data=None):
 headers={'Content-Type':'application/json'}
 if cookies: headers['Cookie']='; '.join(k+'='+v for k,v in cookies.items())
 req=urllib.request.Request(address()+path,data=None if data is None else json.dumps(data).encode(),headers=headers)
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 try: response=opener.open(req,timeout=10)
 except urllib.error.HTTPError as e: response=e
 for value in response.headers.get_all('Set-Cookie',[]):
  cookie=SimpleCookie(value)
  for k,v in cookie.items(): cookies[k]=v.value
 return json.loads(response.read())
def ready():
 for _ in range(60):
  try:
   if request('/.well-known/openid-configuration').get('issuer'): return
  except Exception: pass
  time.sleep(1)
 raise RuntimeError('candidate not ready')
def start(persistent=False):
 args=['docker','run','-d','--name',app,'--label','maibo.test='+run_id,'--network',network,
       '--mount','type=bind,source='+str(root/'app.conf')+',target=/conf/app.conf,readonly',
       '--mount','type=bind,source='+str(root/'init.json')+',target=/init_data.json,readonly']
 if persistent: args+=['--mount','type=volume,source='+volume+',target=/tmp']
 run(args+[image,'--createDatabase=true'])
 if app not in created: created.append(app)
 ready()
password=secrets.token_urlsafe(32)
dbpass=secrets.token_urlsafe(32)
conf='''appname = casdoor
httpport = 8000
runmode = prod
copyrequestbody = true
driverName = postgres
dataSourceName = "user=casdoor password=PASSWORD host=iam-db port=5432 sslmode=disable dbname=casdoor"
dbName = casdoor
showSql = false
redisEndpoint =
authState = "casdoor"
isDemoMode = false
origin = "http://session-proof.invalid"
originFrontend =
defaultApplication = "proof-app"
logConfig = {"adapter":"console"}
initDataNewOnly = true
initDataFile = "/init_data.json"
'''.replace('PASSWORD',dbpass)
(root/'app.conf').write_text(conf)
(root/'init.json').write_text(json.dumps({'organizations':[{'owner':'admin','name':'proof-org','displayName':'Session Proof','passwordType':'bcrypt','passwordOptions':['AtLeast6']}],
'applications':[{'owner':'admin','name':'proof-app','displayName':'Proof','organization':'proof-org','enablePassword':True,'enableSigninSession':True,'enableAutoSignin':True,'cookieExpireInHours':168,'enableSignUp':False,'signinMethods':[{'name':'Password','displayName':'Password','rule':'All'}],'cert':'cert-built-in','clientId':'proof-client','clientSecret':secrets.token_urlsafe(32),'grantTypes':['authorization_code'],'redirectUris':['http://session-proof.invalid/callback'],'tokenFormat':'JWT','expireInHours':1}],
'users':[{'owner':'proof-org','name':'proof-user','displayName':'Synthetic Proof','type':'normal-user','password':password,'signupApplication':'proof-app','isAdmin':False}]}))
def login():
 result=request('/api/login',{'application':'proof-app','organization':'proof-org','username':'proof-user','password':password,'autoSignin':True,'type':'login','signinMethod':'Password'})
 if result.get('status')!='ok': raise RuntimeError('synthetic login rejected')
 if not authenticated(): raise RuntimeError('synthetic session missing')
def authenticated():
 result=request('/api/get-account')
 return result.get('status')=='ok' and isinstance(result.get('data'),dict) and result['data'].get('name')=='proof-user'
evidence={'production_mutated':False,'image':image}
try:
 run(['docker','network','create','--internal',network])
 run(['docker','run','-d','--name',db,'--label','maibo.test='+run_id,'--network',network,'--network-alias','iam-db','-e','POSTGRES_USER=casdoor','-e','POSTGRES_DB=casdoor','-e','POSTGRES_PASSWORD='+dbpass,dbimage]); created.append(db)
 for _ in range(60):
  if sp.run(['docker','exec',db,'pg_isready','-U','casdoor'],stdout=sp.DEVNULL,stderr=sp.DEVNULL).returncode==0: break
  time.sleep(1)
 start(); login(); evidence['initial_authenticated']=True
 original_cookie=dict(cookies)
 remove_app(); start(); cookies=original_cookie
 evidence['without_volume_rebuild_loses_identity']=not authenticated()
 assert evidence['without_volume_rebuild_loses_identity']
 cookies={}; login(); original_cookie=dict(cookies)
 run(['docker','stop',app])
 with (root/'sessions.private.tar').open('wb') as output:
  sp.run(['docker','cp',app+':/tmp/.','-'],stdout=output,stderr=sp.DEVNULL,check=True)
 run(['docker','volume','create',volume])
 run(['docker','run','--rm','--network','none','--user','0:0','--mount','type=volume,source='+volume+',target=/sessions','--mount','type=bind,source='+str(root/'sessions.private.tar')+',target=/sessions.tar,readonly','--entrypoint','sh',image,'-c','tar xf /sessions.tar -C /sessions'])
 remove_app(); start(True); cookies=dict(original_cookie)
 evidence['migration_preserves_authenticated_identity']=authenticated()
 assert evidence['migration_preserves_authenticated_identity']
 remove_app(); start(True); cookies=dict(original_cookie)
 evidence['with_volume_rebuild_preserves_identity']=authenticated()
 assert evidence['with_volume_rebuild_preserves_identity']
 print(json.dumps(evidence))
finally:
 for name in reversed(created): sp.run(['docker','rm','-fv',name],stdout=sp.DEVNULL,stderr=sp.DEVNULL)
 sp.run(['docker','volume','rm',volume],stdout=sp.DEVNULL,stderr=sp.DEVNULL)
 sp.run(['docker','network','rm',network],stdout=sp.DEVNULL,stderr=sp.DEVNULL)
 for path in root.iterdir(): path.unlink()
 root.rmdir()
