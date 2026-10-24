import base64,json,os,shutil,subprocess,tempfile,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='claude-launcher-') as tmp:
 bundle=Path(tmp)/'claude-web-portable';bundle.mkdir()
 shutil.copy2(str(root/'claude-web.sh'),str(bundle/'claude-web.sh'))
 shutil.copytree(str(root/'proxy'),str(bundle/'proxy'))
 image=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}','claude-web:1.0.0'],universal_newlines=True)
 (bundle/'IMAGE_ID').write_text(image)
 def launch(*args):subprocess.run([str(bundle/'claude-web.sh'),*args],cwd=str(bundle),check=True,stdout=subprocess.DEVNULL)
 launch('init');p=bundle/'web.env';p.write_text(p.read_text().replace('WEB_PORT=8081','WEB_PORT=18871'))
 try:
  launch('start')
  info=json.loads(subprocess.check_output(['docker','inspect','claude-web-portable']))[0]
  assert info['Config']['Labels']['claude-web.bundle']==str(bundle)
  mounts={m['Destination']:m for m in info['Mounts']}
  assert mounts['/workspace']['Type']=='bind' and mounts['/workspace']['Source']==str(bundle/'workspace')
  assert mounts['/data']['Source']==str(bundle/'data')
  subprocess.run(['docker','exec','claude-web-portable','sh','-c','echo host-visible > /workspace/mounted.txt'],check=True)
  assert (bundle/'workspace/mounted.txt').read_text().strip()=='host-visible'
  env=dict(line.split('=',1) for line in p.read_text().splitlines())
  auth='Basic '+base64.b64encode((env['CLAUDE_WEB_USERNAME']+':'+env['CLAUDE_WEB_PASSWORD']).encode()).decode()
  with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18871/claude/files/mounted.txt',headers={'Authorization':auth})) as response:assert response.read().strip()==b'host-visible'
  launch('stop');launch('start');assert (bundle/'workspace/mounted.txt').read_text().strip()=='host-visible'
  launch('stop');launch('proxy-setup','18872')
  assert 'BIND_ADDRESS=127.0.0.1' in p.read_text() and 'WEB_PORT=18872' in p.read_text()
  assert 'http://127.0.0.1:18872/claude/' in (bundle/'proxy/apache.conf').read_text()
  assert env['CLAUDE_WEB_PASSWORD'] in p.read_text()
  print('PASS: portable launcher start/recreate, host workspace/data bind mounts, authenticated downloads, proxy generation and preserved credentials.')
 finally:launch('stop')
