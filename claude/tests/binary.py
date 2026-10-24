import base64,json,os,secrets,ssl,subprocess,tempfile,time,urllib.request,urllib.error
from pathlib import Path
root=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='claude-binary-') as tmp:
 folder=Path(tmp);workspace=folder/'workspace';workspace.mkdir();(workspace/'hello.txt').write_text('binary download')
 key=workspace/'key.pem';cert=workspace/'cert.pem'
 subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=localhost'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 password=secrets.token_hex(24);auth='Basic '+base64.b64encode(('admin:'+password).encode()).decode()
 env=dict(os.environ,CLAUDE_WEB_PASSWORD=password)
 process=subprocess.Popen([str(root/'dist/claude-ui-linux-x64'),'--claude',str(root/'tests/fake-claude.js'),'--folder',str(workspace),'--data-dir',str(folder/'data'),'--port','18770','--tls-cert',str(cert),'--tls-key',str(key)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 def req(route,data=None,authenticated=True):
  headers={'Authorization':auth} if authenticated else {}
  if data is not None:headers.update({'Content-Type':'application/json','X-Claude-Web':'1'})
  try:
   with urllib.request.urlopen(urllib.request.Request('https://127.0.0.1:18770'+route,headers=headers,data=None if data is None else json.dumps(data).encode()),context=ssl._create_unverified_context(),timeout=5) as r:return r.status,r.read()
  except urllib.error.HTTPError as e:return e.code,e.read()
 try:
  for i in range(100):
   try:
    if json.loads(req('/claude/api/state')[1])['ready']:break
   except (OSError,ValueError):pass
   assert process.poll() is None,process.stderr.read().decode()
   time.sleep(.1)
  else:raise AssertionError('Binary startup timeout')
  assert req('/claude/',authenticated=False)[0]==401
  assert req('/claude/files/hello.txt')[1]==b'binary download'
  assert req('/claude/files/key.pem')[0]==403
  assert req('/claude/files/cert.pem')[0]==403
  status,data=req('/claude/api/terminal/start',{'cols':80,'rows':24});assert status==200,data
  time.sleep(.3)
  stream=urllib.request.urlopen(urllib.request.Request('https://127.0.0.1:18770/claude/api/terminal/events',headers={'Authorization':auth}),context=ssl._create_unverified_context(),timeout=5)
  assert stream.readline().strip()==b'event: reset';snapshot=json.loads(stream.readline().decode()[6:]);stream.close()
  assert b'Claude native terminal ready' in base64.b64decode(snapshot['output'])
  assert req('/claude/api/terminal/stop',{'id':json.loads(data)['id']})[0]==200
  print('PASS: standalone ELF startup, HTTPS, auth, folder downloads, TLS-key exclusion and native PTY.')
 finally:
  process.terminate();process.wait(timeout=10)
