import base64,json,os,secrets,subprocess,time,urllib.request,urllib.error
from pathlib import Path
root=Path(__file__).resolve().parent.parent
name='codex-web-test-'+secrets.token_hex(4)
data=name+'-data'
workspace=name+'-workspace'
password=secrets.token_hex(24)
auth='Basic '+base64.b64encode(('admin:'+password).encode()).decode()
env=dict(os.environ,CODEX_WEB_PASSWORD=password)

def docker(*args):
    return subprocess.check_output(['docker',*args],env=env,universal_newlines=True).strip()

def start(mock):
    args=['run','-d','--name',name,'-p','127.0.0.1::8765','-e','CODEX_WEB_PASSWORD','-v',data+':/data','-v',workspace+':/workspace']
    if mock: args+=['-e','CODEX_BIN=/mock-codex.js','-v',str(root/'tests/mock-codex.js')+':/mock-codex.js:ro']
    docker(*args,'codex-web:1.4.0')
    return 'http://'+docker('port',name,'8765/tcp')

def request(base,path,data=None,authenticated=True,extra=None):
    headers={'Authorization':auth} if authenticated else {}
    if data is not None: headers.update({'Content-Type':'application/json','X-Codex-Web':'1'})
    headers.update(extra or {})
    req=urllib.request.Request(base+path,data=None if data is None else json.dumps(data).encode(),headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=5) as response:return response.status,response.read()
    except urllib.error.HTTPError as e:return e.code,e.read()

def ready(base,logged_in):
    for _ in range(60):
        try:
            state=json.loads(request(base,'/codex/api/state')[1])
            if state['ready'] or (not logged_in and state['error']):return state
        except (OSError,ValueError):pass
        time.sleep(.2)
    raise AssertionError('Container failed to initialize: '+docker('logs',name))

def stop():
    docker('stop','-t','5',name);docker('rm',name)

try:
    base=start(False)
    state=ready(base,False)
    assert 'needs a login' in state['error'],state
    assert state['workspace']=='/workspace'
    assert request(base,'/healthz',authenticated=False)[0]==200
    assert request(base,'/codex/',authenticated=False)[0]==401
    assert b'Attach files' in request(base,'/codex/')[1]
    assert b'all / commands' in request(base,'/codex/')[1]
    assert b'Terminal' in request(base,'/codex/xterm.js')[1]
    assert docker('exec',name,'id','-u')=='1000'
    assert docker('exec',name,'codex','--version')=='codex-cli 0.163.0'
    docker('exec',name,'node','/app/healthcheck.js')
    stop()
    base=start(True);ready(base,True)
    assert json.loads(request(base,'/codex/api/models')[1])['models'][0]['model']=='test-deep'
    assert request(base,'/codex/api/model',{'model':'test-deep','effort':'high'})[0]==200
    png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXi0AAAAASUVORK5CYII='
    message={'text':'Inspect these attachments','attachments':[{'name':'../../image.png','data':png},{'name':'notes.txt','data':base64.b64encode(b'container test').decode()}]}
    assert request(base,'/codex/api/message',message,extra={'Origin':'http://untrusted.invalid'})[0]==403
    assert request(base,'/codex/api/message',message)[0]==200
    state=ready(base,True)
    for _ in range(20):
        state=json.loads(request(base,'/codex/api/state')[1])
        if not state['busy'] and state['items']:break
        time.sleep(.1)
    reply=json.loads(state['items'][-1]['text'])
    assert reply['model']=='test-deep' and reply['effort']=='high'
    inputs=reply['input']
    assert inputs[1]['type']=='localImage'
    imagepath=inputs[1]['path']
    assert imagepath.startswith('/data/uploads/') and imagepath.endswith('0-image.png')
    assert docker('exec',name,'stat','-c','%a',imagepath)=='600'
    notes=json.loads(inputs[0]['text'].splitlines()[-1])
    assert docker('exec',name,'cat',notes)=='container test'
    assert request(base,'/codex/api/message',{'text':'','attachments':[{'name':'a','data':'!'}]})[0]==400
    assert request(base,'/codex/api/access-mode',{'accessMode':'full-access'})[0]==200
    assert json.loads(request(base,'/codex/api/state')[1])['accessMode']=='full-access'
    stop()
    base=start(True);after=ready(base,True)
    assert after['selectedModel']=='test-deep' and after['selectedEffort']=='high'
    assert after['threadId']==state['threadId'] and after['items']==state['items']
    assert after['accessMode']=='full-access'
    assert docker('exec',name,'cat',notes)=='container test'
    assert request(base,'/codex/api/message',{'text':'Plain text still works'})[0]==200
    for _ in range(100):
        if not json.loads(request(base,'/codex/api/state')[1])['busy']:break
        time.sleep(.02)
    endpoint='/codex/api/terminal/'
    code,body=request(base,endpoint+'start',{'cols':80,'rows':24})
    assert code==200,body
    terminal_id=json.loads(body)['id']
    assert request(base,'/codex/api/message',{'text':'blocked'})[0]==409
    assert request(base,'/codex/api/access-mode',{'accessMode':'workspace'})[0]==409
    assert request(base,endpoint+'input',{'id':terminal_id,'data':'Lw=='})[0]==200
    assert request(base,endpoint+'resize',{'id':terminal_id,'cols':100,'rows':30})[0]==200
    assert request(base,endpoint+'events',authenticated=False)[0]==401
    req=urllib.request.Request(base+endpoint+'events',headers={'Authorization':auth})
    with urllib.request.urlopen(req,timeout=5) as stream:
        assert stream.readline().strip()==b'event: reset'
        snapshot=json.loads(stream.readline().decode()[6:])
        assert snapshot['running'] and base64.b64decode(snapshot['output'])==b'Native terminal ready'
    assert request(base,endpoint+'stop',{'id':terminal_id})[0]==200
    for _ in range(100):
        if not json.loads(request(base,'/codex/api/state')[1])['terminalActive']:break
        time.sleep(.02)
    assert request(base,'/codex/api/access-mode',{'accessMode':'workspace'})[0]==200
    stop()
    base=start(True)
    assert ready(base,True)['accessMode']=='workspace'
    print('PASS: real Codex startup without login, non-root user, health check, authentication, assets, origin protection, file/image handoff with mock RPC, validation, persistent history/uploads across container replacement, text messages.')
finally:
    subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['docker','volume','rm',data,workspace],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
