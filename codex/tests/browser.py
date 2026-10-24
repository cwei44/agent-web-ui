import base64,json,os,subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent
server=subprocess.Popen(['node',str(root/'backend.js'),'--serve'],stdout=subprocess.PIPE,text=True)
try:
    for line in server.stdout:
        print(line.strip())
        if line.strip()=='READY': break
    else: raise RuntimeError('Test server failed')
    with sync_playwright() as p:
        browser=p.chromium.connect_over_cdp(os.environ['BROWSER_CDP_URL']) if os.environ.get('BROWSER_CDP_URL') else p.chromium.launch(headless=True,args=['--no-sandbox'])
        # Older remote Chromium requires CSP bypass for Playwright's injected polling helpers.
        context=browser.new_context(http_credentials={'username':'test','password':'test'},bypass_csp=bool(os.environ.get('BROWSER_CDP_URL')))
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:18765/codex/')
        page.wait_for_function("() => !document.getElementById('send').disabled")
        assert page.locator('#access-toggle').get_attribute('aria-checked')=='false'
        page.locator('#access-toggle').click()
        page.wait_for_function("() => document.getElementById('access-toggle').getAttribute('aria-checked') === 'true' && !document.getElementById('access-toggle').disabled")
        page.reload()
        page.wait_for_function("() => !document.getElementById('access-toggle').disabled")
        assert page.locator('#access-toggle').get_attribute('aria-checked')=='true'
        page.locator('#access-toggle').click()
        page.wait_for_function("() => document.getElementById('access-toggle').getAttribute('aria-checked') === 'false' && !document.getElementById('access-toggle').disabled")
        page.locator('#prompt').fill('/')
        assert page.locator('#command-menu button').count()==6
        page.get_by_role('button',name='/model — Choose a model and reasoning effort',exact=True).click()
        page.wait_for_function("() => !document.getElementById('model-apply').disabled")
        assert page.locator('#model-select').input_value()=='test-deep'
        page.locator('#model-select').select_option('test-fast')
        assert page.locator('#effort-select').input_value()=='low'
        page.get_by_role('button',name='Apply',exact=True).click()
        page.wait_for_function("() => document.getElementById('model-panel').hidden")
        assert 'test-fast' in page.locator('#model-open').inner_text()
        page.locator('#prompt').fill('Use chosen model')
        page.locator('#prompt').press('Enter')
        page.wait_for_function("() => document.getElementById('prompt').value === '' && !document.getElementById('send').disabled")
        selected=context.request.get('http://127.0.0.1:18765/test/turns').json()[-1]
        assert selected['model']=='test-fast' and selected['effort']=='low'
        page.reload()
        page.wait_for_function("() => !document.getElementById('send').disabled")
        assert 'test-fast' in page.locator('#model-open').inner_text()
        page.locator('#prompt').fill('/help')
        page.locator('#prompt').press('Enter')
        page.wait_for_function("() => document.getElementById('prompt').value === ''")
        assert '/model' in page.locator('#command-output').inner_text()
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXi0AAAAASUVORK5CYII=')
        with page.expect_file_chooser() as chooser: page.get_by_role('button',name='Attach files').click()
        chooser.value.set_files([{'name':'screen.png','mimeType':'image/png','buffer':png},{'name':'notes.txt','mimeType':'text/plain','buffer':b'notes from browser'}])
        assert page.locator('.attachment').count()==2
        page.wait_for_function("() => document.querySelector('.attachment img').naturalWidth === 1")
        page.get_by_role('button',name='Remove notes.txt').click()
        assert page.locator('.attachment').count()==1
        page.get_by_role('button',name='Remove screen.png').click()
        # Clipboard files use the same DataTransfer interface as a real paste event.
        page.locator('#prompt').evaluate("""(el, b64) => {
          const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],'pasted.png',{type:'image/png'}));
          el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
        }""",base64.b64encode(png).decode())
        assert page.locator('.attachment').count()==1
        page.wait_for_function("() => document.querySelector('.attachment img').naturalWidth === 1")
        page.get_by_role('button',name='Send ↑').click()
        page.wait_for_function("() => document.querySelectorAll('.attachment').length === 0 && !document.getElementById('send').disabled")
        turns=context.request.get('http://127.0.0.1:18765/test/turns').json()
        assert turns[-1]['input'][1]['type']=='localImage'
        page.locator('#file-input').set_input_files({'name':'retry.txt','mimeType':'text/plain','buffer':b'retry file'})
        page.locator('#prompt').fill('Keep my draft')
        context.request.get('http://127.0.0.1:18765/test/reject')
        page.get_by_role('button',name='Send ↑').click()
        page.wait_for_function("() => !document.getElementById('send').disabled && document.getElementById('error').textContent.includes('Simulated')")
        assert page.locator('#prompt').input_value()=='Keep my draft'
        assert page.locator('.attachment').count()==1
        page.get_by_role('button',name='Send ↑').click()
        page.wait_for_function("() => document.querySelectorAll('.attachment').length === 0 && !document.getElementById('send').disabled")
        assert page.locator('#prompt').input_value()==''
        # Ordinary text paste is left to the browser.
        assert page.locator('#prompt').evaluate("""el => {const dt=new DataTransfer();dt.setData('text/plain','hello'); const e=new ClipboardEvent('paste',{clipboardData:dt,cancelable:true});el.dispatchEvent(e);return !e.defaultPrevented;}""")
        page.locator('#prompt').fill('Text still works')
        page.locator('#prompt').press('Enter')
        page.wait_for_function("() => document.getElementById('prompt').value === '' && !document.getElementById('send').disabled")
        assert context.request.get('http://127.0.0.1:18765/test/turns').json()[-1]['input']==[{'type':'text','text':'Text still works'}]
        page.locator('#file-input').set_input_files({'name':'too-big.txt','mimeType':'text/plain','buffer':b'x'*(10*1024*1024+1)})
        assert page.locator('.attachment').count()==0
        assert '10 MB' in page.locator('#error').inner_text()
        page.locator('#file-input').set_input_files({'name':'mobile-notes.txt','mimeType':'text/plain','buffer':b'mobile'})
        page.set_viewport_size({'width':390,'height':844})
        assert page.locator('#access-toggle').is_visible()
        assert page.locator('#attach').is_visible()
        assert page.locator('#send').is_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('#model-open').click()
        page.wait_for_function("() => !document.getElementById('model-apply').disabled")
        assert page.locator('#model-select').is_visible() and page.locator('#model-apply').is_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=os.environ.get('BROWSER_SCREENSHOT', '/tmp/codex-model-mobile.png'))
        page.locator('#terminal-tab').click()
        page.locator('#terminal-start').click()
        page.wait_for_function("() => document.getElementById('terminal-state').textContent==='Running'")
        page.wait_for_function("() => document.getElementById('access-toggle').disabled")
        page.wait_for_function("() => document.getElementById('terminal-screen').textContent.includes('Codex native terminal ready')")
        page.locator('.xterm-helper-textarea').type('/permissions')
        page.wait_for_function("() => document.getElementById('terminal-screen').textContent.includes('/permissions')")
        page.reload();page.locator('#terminal-tab').click()
        page.wait_for_function("() => document.getElementById('terminal-state').textContent==='Running'")
        page.wait_for_function("() => document.getElementById('access-toggle').disabled")
        page.wait_for_function("() => document.getElementById('terminal-screen').textContent.includes('/permissions')")
        page.on('dialog',lambda dialog:dialog.accept())
        page.locator('#terminal-end').click()
        page.wait_for_function("() => document.getElementById('terminal-state').textContent.startsWith('Exited')")
        page.locator('#chat-tab').click()
        page.wait_for_function("() => !document.getElementById('send').disabled")
        assert not errors,errors
        browser.close()
        print('Browser checks passed: terminal start/input/replay/stop, slash menu, model/effort picker, turn forwarding, reload persistence, help, mobile picker, file picker, preview, remove, image paste, attachment-only send, retry preserves draft, text paste/send, size limit, mobile layout.')
finally:
    server.terminate();server.wait(timeout=5)
