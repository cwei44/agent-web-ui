'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const {spawn} = require('child_process');
const providers = process.env.AI_WEB_PROVIDERS || 'both';
if (!['both','codex','claude'].includes(providers)) throw new Error('AI_WEB_PROVIDERS must be both, codex or claude.');
const username = process.env.AI_WEB_USERNAME || 'admin', password = process.env.AI_WEB_PASSWORD;
if (!password || password === 'replace-with-a-long-random-password') throw new Error('Set AI_WEB_PASSWORD.');
const expected = crypto.createHash('sha256').update('Basic ' + Buffer.from(username + ':' + password).toString('base64')).digest();
const dataRoot = process.env.DATA_DIR || '/data', workspace = process.env.WORKSPACE_DIR || '/workspace';
const enabled = ['codex','claude'].filter(name => providers === 'both' || providers === name);
const ports = {codex:8765, claude:8766}, children = [];
let stopping = false;
for (const name of enabled) {
  const data = path.join(dataRoot, name), home = path.join(data, 'home');
  fs.mkdirSync(home, {recursive:true, mode:0o700});
  fs.mkdirSync(path.join(data, name), {recursive:true, mode:0o700});
  const env = {...process.env, HOST:'127.0.0.1', PORT:String(ports[name]), DATA_DIR:data, WORKSPACE_DIR:workspace, HOME:home,
    CODEX_HOME:path.join(dataRoot,'codex','codex'), CLAUDE_CONFIG_DIR:path.join(dataRoot,'claude','claude'),
    CODEX_WEB_USERNAME:username, CODEX_WEB_PASSWORD:password, CLAUDE_WEB_USERNAME:username, CLAUDE_WEB_PASSWORD:password};
  const child = spawn(process.execPath,[path.join(__dirname,name,'server.js')],{env,stdio:['ignore','inherit','inherit']});
  children.push(child);
  child.on('error',e => {console.error(name + ': ' + e.message); shutdown(1);});
  child.on('exit',code => {if (!stopping) {console.error(name + ' exited: ' + code); shutdown(1);}});
}
function reply(res, status, body) {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}
function backendHealthy(name) {
  return new Promise(resolve => {
    const req = http.get({hostname:'127.0.0.1',port:ports[name],path:'/healthz',timeout:1500},res => {res.resume();resolve(res.statusCode===200);});
    req.on('timeout',()=>req.destroy());req.on('error',()=>resolve(false));
  });
}
const server = http.createServer(async(req,res) => {
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  if (req.method === 'GET' && req.url === '/healthz') {
    const healthy = (await Promise.all(enabled.map(backendHealthy))).every(Boolean);
    return reply(res,healthy?200:503,{status:healthy?'ok':'starting',providers:enabled});
  }
  const actual = crypto.createHash('sha256').update(req.headers.authorization || '').digest();
  if (!crypto.timingSafeEqual(actual,expected)) {res.setHeader('WWW-Authenticate','Basic realm="AI Web", charset="UTF-8"');return reply(res,401,{error:'Sign in to AI Web'});}
  const pathname = new URL(req.url,'http://localhost').pathname;
  if (pathname === '/' || pathname === '/ai') {res.writeHead(302,{Location:'/ai/'});return res.end();}
  if (req.method === 'GET' && pathname === '/ai/') {
    const cards = enabled.map(name => `<a href="/${name}/"><strong>${name==='codex'?'Codex':'Claude Code'}</strong><span>Chat, files, models, Full Access and native terminal</span></a>`).join('');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex & Claude · AI Web</title><style>body{margin:0;background:#101612;color:#eaf0eb;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{width:min(740px,calc(100% - 48px));padding:32px 0}small{letter-spacing:.2em;color:#b7dfa4}h1{font-size:36px}p{color:#a2afa6;line-height:1.6}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:32px 0}a{display:flex;flex-direction:column;gap:18px;padding:28px;border:1px solid #354439;border-radius:16px;background:#19221c;color:#eaf0eb;text-decoration:none}a:hover,a:focus{border-color:#b7dfa4}strong{font-size:26px}span{color:#a2afa6;line-height:1.5}</style><main><small>AI WEB · WORKSPACE</small><h1>Choose your coding assistant.</h1><p>One workspace. Independent conversations and access settings.</p><section>${cards}</section><p>Switch assistants using the link at the top of either conversation.</p></main></html>`);
  }
  const name = ['codex','claude'].find(n => pathname === '/'+n || pathname.startsWith('/'+n+'/'));
  if (!name) return reply(res,404,{error:'Not found'});
  if (!enabled.includes(name)) return reply(res,503,{error:name+' is not enabled in this instance.'});
  const upstream = http.request({hostname:'127.0.0.1',port:ports[name],method:req.method,path:req.url,headers:req.headers},response => {
    res.writeHead(response.statusCode,response.headers);response.pipe(res);
    response.on('error',()=>res.destroy());
  });
  upstream.on('error',()=>{if (!res.headersSent) reply(res,502,{error:name+' is starting or unavailable.'});else res.destroy();});
  req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());
  req.pipe(upstream);
});
function shutdown(code=0) {
  if (stopping) return;stopping=true;
  server.close();for (const child of children) child.kill('SIGTERM');
  const timeout=setTimeout(()=>{for(const child of children)child.kill('SIGKILL');process.exit(code);},5000);
  Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null || child.signalCode)resolve();else child.once('exit',resolve);}))).then(()=>{clearTimeout(timeout);process.exit(code);});
}
server.on('error',e=>{console.error(e.message);shutdown(1);});
server.listen(Number(process.env.PORT || 8760),process.env.HOST || '0.0.0.0',()=>console.log('AI Web: /ai/, enabled providers: '+enabled.join(', ')));
process.on('SIGTERM',()=>shutdown());process.on('SIGINT',()=>shutdown());
