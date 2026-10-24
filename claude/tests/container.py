import base64,json,os,secrets,subprocess,time,urllib.request,urllib.error
from pathlib import Path
root=Path(__file__).resolve().parent.parent
name='claude-web-test-'+secrets.token_hex(4);data=name+'-data';workspace=name+'-workspace'
password=secrets.token_hex(24);auth='Basic '+base64.b64encode(('admin:'+password).encode()).decode()
env=dict(os.environ,CLAUDE_WEB_PASSWORD=password)
def docker(*args):return subprocess.check_output(['docker',*args],env=env,universal_newlines=True).strip()
def start(mock):
 args=['run','-d','--name',name,'-p','127.0.0.1::8766','-e','CLAUDE_WEB_PASSWORD','-v',data+':/data','-v',workspace+':/workspace']
 if mock:args+=['-e','CLAUDE_BIN=/app/tests/fake-claude.js','-v',str(root/'tests')+':/app/tests:ro']
 args+=['claude-web:1.0.0']
 if mock:args+=['node','/app/tests/fixture-server.js']
 docker(*args);return 'http://'+docker('port',name,'8766/tcp')
def request(base,route,body=None,authenticated=True,extra=None):
 headers={'Authorization':auth} if authenticated else {}
 if body is not None:headers.update({'Content-Type':'application/json','X-Claude-Web':'1'})
 headers.update(extra or {})
 try:
  with urllib.request.urlopen(urllib.request.Request(base+route,headers=headers,data=None if body is None else json.dumps(body).encode()),timeout=10) as r:return r.status,r.read()
 except urllib.error.HTTPError as e:return e.code,e.read()
def state(base):return json.loads(request(base,'/claude/api/state')[1])
def wait(base,condition):
 for _ in range(100):
  try:
   s=state(base)
   if condition(s):return s
  except (OSError,ValueError):pass
  time.sleep(.1)
 raise AssertionError('Container failed: '+docker('logs',name))
def stop():docker('stop','-t','5',name);docker('rm',name)
def post(action,body={}):
 status,raw=request(base,'/claude/api/'+action,body);assert status==200,(status,raw);return json.loads(raw)
try:
 base=start(False);s=wait(base,lambda s:bool(s['error']));assert 'needs a login' in s['error']
 assert request(base,'/healthz',authenticated=False)[0]==200
 assert request(base,'/claude/',authenticated=False)[0]==401
 assert b'Full Access' in request(base,'/claude/')[1]
 assert docker('exec',name,'id','-u')=='1000'
 assert docker('exec',name,'claude','--version')=='2.1.310 (Claude Code)'
 docker('exec',name,'node','/app/healthcheck.js');stop()
 base=start(True);wait(base,lambda s:s['ready'])
 assert request(base,'/claude/api/new',{},extra={'Origin':'http://invalid.example'})[0]==403
 post('model',{'model':'sonnet','effort':'high'})
 png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXi0AAAAASUVORK5CYII='
 post('message',{'text':'Inspect uploads','attachments':[{'name':'../../image.png','data':png},{'name':'notes.txt','data':base64.b64encode(b'container test').decode()}]})
 before=wait(base,lambda s:not s['busy'] and bool(s['threadId']))
 turn=json.loads(docker('exec',name,'cat','/data/last-turn.json'));assert turn['model']=='sonnet' and turn['effort']=='high'
 content=turn['input']['message']['content'];assert content[1]['source']['media_type']=='image/png'
 notes=json.loads(content[0]['text'].splitlines()[-1]);assert docker('exec',name,'cat',notes)=='container test'
 post('access-mode',{'accessMode':'full-access'});stop()
 base=start(True);after=wait(base,lambda s:s['ready']);assert after['threadId']==before['threadId'] and after['items']==before['items'] and after['accessMode']=='full-access'
 assert docker('exec',name,'cat',notes)=='container test'
 post('message',{'text':'Continue'});wait(base,lambda s:not s['busy'])
 turn=json.loads(docker('exec',name,'cat','/data/last-turn.json'));assert turn['permissionMode']=='bypassPermissions' and turn['resume']==before['threadId']
 terminal=post('terminal/start',{'cols':80,'rows':24});time.sleep(.4)
 assert request(base,'/claude/api/access-mode',{'accessMode':'workspace'})[0]==409
 req=urllib.request.Request(base+'/claude/api/terminal/events',headers={'Authorization':auth})
 with urllib.request.urlopen(req,timeout=5) as stream:
  assert stream.readline().strip()==b'event: reset';snapshot=json.loads(stream.readline().decode()[6:]);output=base64.b64decode(snapshot['output']).decode();assert 'bypassPermissions' in output and 'Claude native terminal ready' in output,output
 post('terminal/input',{'id':terminal['id'],'data':'L2hlbHA='});post('terminal/resize',{'id':terminal['id'],'cols':100,'rows':30});post('terminal/stop',{'id':terminal['id']});wait(base,lambda s:not s['terminalActive'])
 post('access-mode',{'accessMode':'workspace'});stop();base=start(True);assert wait(base,lambda s:s['ready'])['accessMode']=='workspace'
 print('PASS: real CLI/non-root startup, auth, health, uploads, model/effort, persisted conversation/access modes, native PTY input/resize/replay/stop and origin checks.')
finally:
 subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['docker','volume','rm',data,workspace],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
