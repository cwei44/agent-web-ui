"""Exercise the shipped proxy snippets with isolated Apache/Nginx HTTP+HTTPS listeners."""
import base64,http.client,json,os,secrets,shutil,signal,socket,ssl,subprocess,tempfile,time
from pathlib import Path
root=Path(__file__).resolve().parent.parent

def port():
    s=socket.socket();s.bind(('127.0.0.1',0));value=s.getsockname()[1];s.close();return value

def request(number,path,data=None,tls=False,auth=True,headers=None,stream=False):
    conn=http.client.HTTPSConnection('127.0.0.1',number,context=ssl._create_unverified_context(),timeout=5) if tls else http.client.HTTPConnection('127.0.0.1',number,timeout=5)
    h={'Authorization':authorization} if auth else {}
    if data is not None:h.update({'Content-Type':'application/json','X-Codex-Web':'1'})
    h.update(headers or {})
    conn.request('GET' if data is None else 'POST',path,None if data is None else json.dumps(data),h)
    response=conn.getresponse()
    if stream:return conn,response
    result=(response.status,response.read(),dict(response.getheaders()));conn.close();return result

def ready(number):
    for _ in range(100):
        try:
            if request(number,'/codex/api/state')[0]==200:return
        except OSError:pass
        time.sleep(.1)
    raise AssertionError('Listener did not start on '+str(number))

with tempfile.TemporaryDirectory(prefix='codex-proxy-test-') as temporary:
    temp=Path(temporary);temp.chmod(0o755)
    backend=port();http_port=port();https_port=port();name='codex-proxy-test-'+secrets.token_hex(4)
    password=secrets.token_hex(24);authorization='Basic '+base64.b64encode(('admin:'+password).encode()).decode()
    (temp/'existing.txt').write_text('EXISTING SITE CONTENT');(temp/'existing.txt').chmod(0o644)
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(temp/'key.pem'),'-out',str(temp/'cert.pem'),'-days','1','-subj','/CN=localhost'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['docker','run','-d','--name',name,'-p','127.0.0.1:%s:8765'%backend,'-e','CODEX_WEB_PASSWORD='+password,'-e','CODEX_BIN=/mock-codex.js','-v',str(root/'tests/mock-codex.js')+':/mock-codex.js:ro','codex-web:1.4.0'],check=True,stdout=subprocess.DEVNULL)
    try:
        ready(backend)
        for kind in ['apache','nginx']:
            snippet=temp/(kind+'-codex.conf')
            snippet.write_bytes(subprocess.check_output([str(root/'proxy/render.sh'),kind,str(backend)]))
            if kind=='apache':
                modules=['mpm_event','unixd','authz_core','alias','env','proxy','proxy_http','ssl']
                config='ServerRoot /etc/httpd\nServerName localhost\nPidFile "%s"\nErrorLog "%s"\nUser apache\nGroup apache\n'%(temp/'apache.pid',temp/'apache.log')
                config+=''.join('LoadModule %s_module /usr/lib/httpd/modules/mod_%s.so\n'%(m,m) for m in modules)
                config+='Listen 127.0.0.1:%s\nListen 127.0.0.1:%s\n'%(http_port,https_port)
                config+='<Directory "%s">\nRequire all granted\n</Directory>\n'%temp
                for number,tls in [(http_port,False),(https_port,True)]:
                    config+='<VirtualHost 127.0.0.1:%s>\nDocumentRoot "%s"\nInclude "%s"\n'%(number,temp,snippet)
                    if tls:config+='SSLEngine on\nSSLCertificateFile "%s"\nSSLCertificateKeyFile "%s"\n'%(temp/'cert.pem',temp/'key.pem')
                    config+='</VirtualHost>\n'
                configuration=temp/'apache-full.conf';configuration.write_text(config)
                args=['httpd','-f',str(configuration)]
                subprocess.run(args+['-t'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                command=args+['-DFOREGROUND']
            else:
                config='user root;\nworker_processes 1;\npid %s;\nerror_log %s;\nevents { worker_connections 128; }\nhttp {\naccess_log off;\n'%(temp/'nginx.pid',temp/'nginx.log')
                for name_part in ['client_body','proxy','fastcgi','uwsgi','scgi']:
                    config+='%s_temp_path %s;\n'%(name_part,temp/name_part)
                for number,tls in [(http_port,False),(https_port,True)]:
                    config+='server {\nlisten 127.0.0.1:%s%s;\nserver_name localhost;\nroot %s;\ninclude %s;\n'%(number,' ssl' if tls else '',temp,snippet)
                    if tls:config+='ssl_certificate %s;\nssl_certificate_key %s;\n'%(temp/'cert.pem',temp/'key.pem')
                    config+='}\n'
                config+='}\n';configuration=temp/'nginx-full.conf';configuration.write_text(config)
                args=['nginx','-p',str(temp)+'/', '-c',str(configuration),'-e',str(temp/'nginx.log')]
                subprocess.run(args+['-t'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                command=args+['-g','daemon off;']
            with (temp/(kind+'-process.log')).open('w') as log:
                proxy=subprocess.Popen(command,stdout=log,stderr=log,start_new_session=True)
            try:
                ready(http_port)
                for number,tls in [(http_port,False),(https_port,True)]:
                    origin=('https' if tls else 'http')+'://127.0.0.1:'+str(number)
                    def call(path,data=None,**kwargs):return request(number,path,data,tls=tls,**kwargs)
                    assert call('/existing.txt')[1]==b'EXISTING SITE CONTENT'
                    assert call('/codex/',auth=False)[0]==401
                    redirect=call('/codex');assert redirect[0]==302 and redirect[2]['Location'].endswith('/codex/')
                    assert b'all / commands' in call('/codex/')[1]
                    assert b'Terminal' in call('/codex/xterm.js')[1]
                    for endpoint,event in [('/codex/api/events',b'data: '),('/codex/api/terminal/events',b'event: reset')]:
                        connection,response=call(endpoint,stream=True)
                        assert response.status==200 and response.readline().startswith(event)
                        response.close();connection.close()
                    assert call('/codex/api/model',{'model':'test-deep','effort':'high'},headers={'Origin':origin})[0]==200
                    assert call('/codex/api/message',{'text':'bad'},headers={'Origin':'https://untrusted.invalid'})[0]==403
                    payload={'text':'proxy upload','attachments':[{'name':'large.txt','data':base64.b64encode(b'x'*(2*1024*1024)).decode()}]}
                    assert call('/codex/api/message',payload,headers={'Origin':origin})[0]==200
                    for _ in range(100):
                        if not json.loads(call('/codex/api/state')[1])['busy']:break
                        time.sleep(.02)
                    started=call('/codex/api/terminal/start',{'cols':80,'rows':24},headers={'Origin':origin})
                    assert started[0]==200,started
                    terminal_id=json.loads(started[1])['id']
                    assert call('/codex/api/terminal/input',{'id':terminal_id,'data':'Lw=='},headers={'Origin':origin})[0]==200
                    connection,response=call('/codex/api/terminal/events',stream=True)
                    assert response.readline().strip()==b'event: reset'
                    snapshot=json.loads(response.readline().decode()[6:]);response.close();connection.close()
                    assert snapshot['running'] and base64.b64decode(snapshot['output'])==b'Native terminal ready'
                    assert call('/codex/api/terminal/stop',{'id':terminal_id},headers={'Origin':origin})[0]==200
                    for _ in range(100):
                        if not json.loads(call('/codex/api/state')[1])['terminalActive']:break
                        time.sleep(.02)
                    print('PASS: %s %s — existing site, auth, redirects, assets, 2 MiB upload, origin/Host preservation, chat SSE, terminal input/output/stop.'%(kind,'HTTPS' if tls else 'HTTP'),flush=True)
            except Exception:
                for name_log in [kind+'-process.log',kind+'.log']:
                    print((temp/name_log).read_text()[-8000:])
                raise
            finally:
                proxy.terminate()
                try:proxy.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(proxy.pid,signal.SIGKILL);proxy.wait(timeout=5)
    finally:
        subprocess.run(['docker','rm','-f','-v',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
