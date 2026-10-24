import base64,json,os,subprocess,tempfile,time
from pathlib import Path
from playwright.sync_api import sync_playwright
source=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='claude-browser-') as tmp:
    folder=Path(tmp);(folder/'workspace').mkdir()
    env=dict(os.environ,CLAUDE_BIN=str(source/'tests/fake-claude.js'),DATA_DIR=str(folder/'data'),WORKSPACE_DIR=str(folder/'workspace'),CLAUDE_WEB_PASSWORD='test',CLAUDE_WEB_USERNAME='test',PORT='18768',HOST='127.0.0.1',CLAUDE_TEST_FAKE_UID='1')
    server=subprocess.Popen([os.environ.get('NODE_BIN','node'),str(source/'tests/fixture-server.js')],env=env,stdout=subprocess.PIPE,text=True)
    try:
        for line in server.stdout:
            if line.strip()=='READY':break
        else:raise RuntimeError('Fixture server failed')
        with sync_playwright() as p:
            browser=p.chromium.connect_over_cdp(os.environ['BROWSER_CDP_URL']) if os.environ.get('BROWSER_CDP_URL') else p.chromium.launch(headless=True,args=['--no-sandbox'])
            context=browser.new_context(http_credentials={'username':'test','password':'test'},bypass_csp=bool(os.environ.get('BROWSER_CDP_URL')))
            page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto('http://127.0.0.1:18768/claude/')
            page.wait_for_function("() => !document.getElementById('send').disabled")
            page.locator('#access-toggle').click();page.wait_for_function("() => document.getElementById('access-toggle').getAttribute('aria-checked')==='true' && !document.getElementById('access-toggle').disabled")
            page.reload();page.wait_for_function("() => !document.getElementById('send').disabled")
            assert page.locator('#access-toggle').get_attribute('aria-checked')=='true'
            page.locator('#prompt').fill('/model');page.locator('#prompt').press('Enter')
            page.wait_for_function("() => !document.getElementById('model-apply').disabled")
            page.locator('#model-select').select_option('sonnet');page.locator('#effort-select').select_option('high');page.locator('#model-apply').click()
            png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXi0AAAAASUVORK5CYII=')
            with page.expect_file_chooser() as chooser:page.get_by_role('button',name='Attach files').click()
            chooser.value.set_files({'name':'notes.txt','mimeType':'text/plain','buffer':b'browser notes'})
            page.locator('#prompt').evaluate("""(el,b64)=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],'pasted.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}""",base64.b64encode(png).decode())
            assert page.locator('.attachment').count()==2
            page.locator('#send').click();page.wait_for_function("() => document.querySelectorAll('.attachment').length===0 && !document.getElementById('send').disabled")
            turn=json.loads((folder/'data/last-turn.json').read_text());assert turn['model']=='sonnet' and turn['effort']=='high' and turn['permissionMode']=='bypassPermissions'
            assert turn['input']['message']['content'][1]['source']['media_type']=='image/png'
            page.locator('#access-toggle').click();page.wait_for_function("() => document.getElementById('access-toggle').getAttribute('aria-checked')==='false' && !document.getElementById('access-toggle').disabled")
            page.locator('#prompt').fill('ask permission');page.locator('#send').click();page.get_by_role('button',name='Allow once',exact=True).wait_for()
            assert page.locator('#access-toggle').is_disabled()
            page.get_by_role('button',name='Allow once',exact=True).click();page.wait_for_function("() => !document.getElementById('send').disabled")
            page.locator('#prompt').fill('wait');page.locator('#send').click();page.locator('#stop').wait_for(state='visible');page.locator('#stop').click();page.wait_for_function("() => !document.getElementById('send').disabled")
            page.locator('#terminal-tab').click();page.locator('#terminal-start').click()
            page.wait_for_function("() => document.getElementById('terminal-screen').textContent.includes('Claude native terminal ready')")
            page.wait_for_function("() => document.getElementById('access-toggle').disabled")
            page.locator('.xterm-helper-textarea').type('/help')
            page.wait_for_function("() => document.getElementById('terminal-screen').textContent.includes('/help')")
            page.reload();page.locator('#terminal-tab').click();page.wait_for_function("() => document.getElementById('terminal-screen').textContent.includes('/help')")
            page.on('dialog',lambda d:d.accept());page.locator('#terminal-end').click();page.wait_for_function("() => document.getElementById('terminal-state').textContent.startsWith('Exited')")
            page.locator('#chat-tab').click();page.wait_for_function("() => !document.getElementById('send').disabled")
            page.set_viewport_size({'width':390,'height':844});assert page.locator('#access-toggle').is_visible();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=os.environ.get('BROWSER_SCREENSHOT','/tmp/claude-web-mobile.png'))
            assert not errors,errors
            browser.close()
            print('Browser passed: model/effort, Full Access/reload, paste/upload, approvals, stop, terminal input/replay/end, mobile layout.')
    finally:
        server.terminate();server.wait(timeout=10)
