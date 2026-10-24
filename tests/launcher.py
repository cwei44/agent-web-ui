import base64,json,os,shutil,socket,subprocess,tempfile,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parent.parent
bundle=Path(tempfile.mkdtemp(prefix='ai-web-launcher-'))
def run(*args):return subprocess.check_output(list(args),universal_newlines=True).strip()
def launch(*args):return run(str(bundle/'ai-web.sh'),*args)
try:
 if subprocess.call(['docker','inspect','ai-web-portable'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)==0:raise RuntimeError('Refusing to use a pre-existing ai-web-portable container')
 shutil.copy2(str(root/'ai-web.sh'),str(bundle/'ai-web.sh'));shutil.copytree(str(root/'proxy'),str(bundle/'proxy'))
 (bundle/'IMAGE_ID').write_text(run('docker','image','inspect','ai-web:1.0.0','--format','{{.Id}}')+'\n')
 launch('init')
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 config=(bundle/'web.env').read_text().replace('WEB_PORT=8082','WEB_PORT='+str(port));(bundle/'web.env').write_text(config)
 secret=dict(line.split('=',1) for line in config.splitlines())['AI_WEB_PASSWORD']
 launch('start','both');assert 'running' in launch('status')
 details=json.loads(run('docker','inspect','ai-web-portable'))[0]
 mounts={m['Destination']:m['Source'] for m in details['Mounts']}
 assert mounts['/workspace']==str(bundle/'workspace') and mounts['/data']==str(bundle/'data')
 (bundle/'workspace/host.txt').write_text('host file');os.chown(str(bundle/'workspace/host.txt'),1000,1000)
 assert run('docker','exec','ai-web-portable','cat','/workspace/host.txt')=='host file'
 base='http://127.0.0.1:'+str(port)
 auth='Basic '+base64.b64encode(('admin:'+secret).encode()).decode()
 for route in ['/ai/','/codex/','/claude/']:
  assert urllib.request.urlopen(urllib.request.Request(base+route,headers={'Authorization':auth})).status==200
 if os.environ.get('AI_WEB_BROWSER_TEST')=='1':
  from playwright.sync_api import sync_playwright
  browser_name='ai-web-browser-test'
  run('docker','run','-d','--name',browser_name,'--network','host','--entrypoint','/usr/bin/chromium-browser','grafana-render:latest','--headless','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-address=127.0.0.1','--remote-debugging-port=19222','about:blank')
  try:
   import time
   time.sleep(2)
   with sync_playwright() as p:
    browser=p.chromium.connect_over_cdp('http://127.0.0.1:19222')
    context=browser.new_context(http_credentials={'username':'admin','password':secret},bypass_csp=True)
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    for width,height in [(1440,1000),(390,844)]:
     page.set_viewport_size({'width':width,'height':height});page.goto(base+'/ai/')
     for provider in ['codex','claude']:
      page.locator('a[href="/'+provider+'/"]').click();page.wait_for_selector('a.provider-switch')
      assert page.locator('body').inner_text().find('Full Access')>=0
      page.locator('a.provider-switch').click();page.wait_for_selector('h1')
      assert 'Choose your coding assistant.' in page.locator('h1').inner_text()
     assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    assert not errors,errors
    context.close();browser.close()
  finally:subprocess.call(['docker','rm','-f',browser_name],stdout=subprocess.DEVNULL)
 launch('stop');launch('start','codex')
 assert run('docker','exec','ai-web-portable','cat','/workspace/host.txt')=='host file'
 launch('stop');launch('proxy-setup',str(port))
 assert 'AI_WEB_PASSWORD='+secret in (bundle/'web.env').read_text()
 for server in ['apache','nginx']:
  text=(bundle/'proxy'/ (server+'.conf')).read_text()
  for route in ['/ai/','/codex/','/claude/']:assert route in text
  assert str(port) in text
 print('PASS: launcher initialization, both/provider-only starts, host bind mounts, restart persistence, shared credentials, proxy rendering'+(', desktop/mobile browser navigation' if os.environ.get('AI_WEB_BROWSER_TEST')=='1' else '')+'.')
finally:
 # Remove only the disposable container owned by this test bundle.
 try:
  if run('docker','inspect','--format','{{index .Config.Labels "ai-web.bundle"}}','ai-web-portable')==str(bundle):launch('stop')
 except subprocess.CalledProcessError:pass
 shutil.rmtree(str(bundle))
