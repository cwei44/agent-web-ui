import base64, json, os, secrets, shutil, subprocess, tempfile, time, urllib.request, urllib.error
from pathlib import Path
root=Path(__file__).resolve().parent.parent
name='ai-web-test-'+secrets.token_hex(4); data=name+'-data'; workspace=name+'-workspace'
password=secrets.token_hex(24);auth='Basic '+base64.b64encode(('admin:'+password).encode()).decode()
env=dict(os.environ,AI_WEB_PASSWORD=password)
fixture=Path(tempfile.mkdtemp(prefix='ai-web-fixture-'));fixture.chmod(0o755)
(fixture/'server.js').write_text((root/'claude/tests/fixture-server.js').read_text().replace("require('../server.js')","require('/suite/claude/real-server.js')").replace("require('../options.js')","require('/suite/claude/options.js')"))
shutil.copyfile(str(root/'claude/server.js'),str(fixture/'real-server.js'))
for f in fixture.iterdir():f.chmod(0o644)
def docker(*args):return subprocess.check_output(['docker',*args],env=env,universal_newlines=True).strip()
def start(mode='both',mock=True):
 args=['run','-d','--name',name,'-p','127.0.0.1::8760','-e','AI_WEB_PASSWORD','-e','AI_WEB_PROVIDERS='+mode,'-v',data+':/data','-v',workspace+':/workspace']
 if mock:args+=['-e','CODEX_BIN=/suite/codex/tests/mock-codex.js','-e','CLAUDE_BIN=/suite/claude/tests/fake-claude.js','-v',str(fixture/'server.js')+':/suite/claude/server.js:ro','-v',str(fixture/'real-server.js')+':/suite/claude/real-server.js:ro']
 docker(*args,'ai-web:1.0.0');base='http://'+docker('port',name,'8760/tcp')
 for _ in range(100):
  try:
   if request(base,'/healthz',authenticated=False)[0]==200:return base
  except OSError:pass
  time.sleep(.1)
 raise AssertionError('Health failed: '+docker('logs',name))
def request(base,route,body=None,authenticated=True,extra=None):
 headers={'Authorization':auth} if authenticated else {}
 if body is not None:headers.update({'Content-Type':'application/json','X-Codex-Web':'1','X-Claude-Web':'1','Origin':base})
 headers.update(extra or {})
 try:
  with urllib.request.urlopen(urllib.request.Request(base+route,headers=headers,data=None if body is None else json.dumps(body).encode()),timeout=10) as r:return r.status,r.read()
 except urllib.error.HTTPError as e:return e.code,e.read()
def state(provider):return json.loads(request(base,'/'+provider+'/api/state')[1])
def wait(provider,condition):
 for _ in range(100):
  s=state(provider)
  if condition(s):return s
  time.sleep(.1)
 raise AssertionError(provider+' state condition failed: '+json.dumps(s))
def post(provider,action,body={}):
 status,raw=request(base,'/'+provider+'/api/'+action,body);assert status==200,(provider,action,status,raw);return json.loads(raw)
def stop():docker('stop','-t','6',name);docker('rm',name)
try:
 base=start(mock=False)
 assert docker('exec',name,'id','-u')=='1000'
 assert docker('exec',name,'claude','--version')=='2.1.310 (Claude Code)'
 assert '0.163.0' in docker('exec',name,'codex','--version')
 for route in ['/ai/','/codex/','/claude/']:
  assert request(base,route,authenticated=False)[0]==401
  assert request(base,route)[0]==200
 stop();base=start()
 histories={}
 for provider in ['codex','claude']:
  wait(provider,lambda s:s['ready'])
  assert b'href="/ai/"' in request(base,'/'+provider+'/')[1]
  assert request(base,'/'+provider+'/api/new',{},extra={'Origin':'http://invalid.example'})[0]==403
  post(provider,'message',{'text':'Inspect '+provider,'attachments':[{'name':provider+'.txt','data':base64.b64encode((provider+' attachment').encode()).decode()}]})
  histories[provider]=wait(provider,lambda s:not s['busy'] and bool(s['threadId']))
  post(provider,'access-mode',{'accessMode':'full-access'})
  terminal=post(provider,'terminal/start',{'cols':80,'rows':24});time.sleep(.4)
  req=urllib.request.Request(base+'/'+provider+'/api/terminal/events',headers={'Authorization':auth})
  with urllib.request.urlopen(req,timeout=5) as stream:
   assert stream.readline().strip()==b'event: reset';snapshot=json.loads(stream.readline().decode()[6:]);assert 'terminal ready' in base64.b64decode(snapshot['output']).decode().lower()
  post(provider,'terminal/input',{'id':terminal['id'],'data':'L2hlbHA='})
  post(provider,'terminal/stop',{'id':terminal['id']});wait(provider,lambda s:not s['terminalActive'])
 assert histories['codex']['threadId']!=histories['claude']['threadId']
 docker('exec',name,'sh','-c','echo persisted > /workspace/shared.txt');stop();base=start()
 for provider in ['codex','claude']:
  s=wait(provider,lambda s:s['ready']);assert s['threadId']==histories[provider]['threadId'] and s['items']==histories[provider]['items'] and s['accessMode']=='full-access'
  assert provider+' attachment' in docker('exec',name,'sh','-c','find /data/'+provider+'/uploads -type f -exec cat {} \\;')
 assert docker('exec',name,'cat','/workspace/shared.txt')=='persisted'
 post('codex','access-mode',{'accessMode':'workspace'});assert state('claude')['accessMode']=='full-access'
 stop()
 for provider,other in [('codex','claude'),('claude','codex')]:
  base=start(provider);portal=request(base,'/ai/')[1]
  assert ('href="/'+provider+'/"').encode() in portal and ('href="/'+other+'/"').encode() not in portal
  assert request(base,'/'+other+'/')[0]==503
  assert request(base,'/'+provider+'/')[0]==200
  stop()
 print('PASS: both CLIs, non-root, shared authentication, both UI routes, origin checks, uploads, immediate terminal SSE, independent histories/access modes, persistence, shared workspace, and all three provider modes.')
finally:
 subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['docker','volume','rm',data,workspace],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 shutil.rmtree(str(fixture))
