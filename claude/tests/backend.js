'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createApp}=require('../server.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-web-test-'));
const workspace=path.join(root,'workspace'),dataDir=path.join(root,'data');fs.mkdirSync(workspace);fs.mkdirSync(dataDir);
const cli=path.join(root,'claude');
fs.writeFileSync(cli,'#!'+process.execPath+'\n'+`if(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true}));process.exit(0);} console.log('Claude native terminal ready '+JSON.stringify(process.argv.slice(2)));process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',b=>process.stdout.write(b));`,{mode:0o755});
const calls=[];let lastInput;const models=[{value:'sonnet',displayName:'Sonnet',description:'Test',supportedEffortLevels:['low','medium','high']},{value:'haiku',displayName:'Haiku',description:'Fast'}];
const sdk={query({prompt,options}){
  const controller=new AbortController();let release;const interrupted=new Promise(r=>release=r);
  return {supportedModels:async()=>models,close(){controller.abort();release();},interrupt:async()=>{controller.abort();release();},async *[Symbol.asyncIterator](){
    calls.push(options);const input=(await prompt[Symbol.asyncIterator]().next()).value;lastInput=input;
    const text=input.message.content[0].text, session_id=options.resume || crypto.randomUUID();
    yield {type:'system',subtype:'init',session_id};
    if(text==='permission'||text==='question') {
      const question=text==='question';const tool=question?'AskUserQuestion':'Bash';const toolInput=question?{questions:[{question:'Which color?',options:[{label:'Blue'},{label:'Red'}]}]}:{command:'echo permission-test'};
      const answer=await options.canUseTool(tool,toolInput,{signal:controller.signal,toolUseID:'test-tool'});
      yield {type:'assistant',session_id,message:{id:'answer-'+calls.length,content:[{type:'text',text:JSON.stringify(answer)}]}};
    } else if(text==='wait') {await interrupted;return;}
    else if(text==='fail') throw new Error('Simulated Claude failure');
    else {
      const id='assistant-'+calls.length;
      yield {type:'stream_event',session_id,event:{type:'message_start',message:{id}}};
      yield {type:'stream_event',session_id,event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}};
      yield {type:'stream_event',session_id,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello from Claude'}}};
      yield {type:'assistant',session_id,message:{id,content:[{type:'text',text:'Hello from Claude'}]}};
    }
    yield {type:'result',subtype:'success',session_id,is_error:false};
  }};
}};
const config={claude:cli,workspace,dataDir,secretPaths:[dataDir,cli],credentials:{username:'test',password:'test'},defaultAccessMode:'workspace'};
let app,url;
const auth='Basic '+Buffer.from('test:test').toString('base64');
async function start(){app=createApp(config,sdk,require('node-pty'));await new Promise(r=>app.server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+app.server.address().port;await app.initialize();assert.equal(app.state.ready,true);}
async function request(route,body,headers={}) {const res=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:auth,'X-Claude-Web':'1','Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:res.status,data,headers:res.headers};}
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Condition timed out');await new Promise(r=>setTimeout(r,10));}}
const post=(action,data={})=>request('/claude/api/'+action,data);
const send=async text=>{assert.equal((await post('message',{text})).status,200);await until(()=>!app.state.busy);};
test('Claude adapter, approvals, uploads, history, model and permission changes, terminal and file isolation',async()=>{
 const realUid=process.getuid;
 try{
  await start();
  assert.equal((await request('/claude/',undefined,{Authorization:''})).status,401);
  assert.equal((await request('/healthz',undefined,{Authorization:''})).status,200);
  assert.match((await request('/claude/')).data,/Full Access: Off/);
  assert.equal((await request('/claude/api/new',{}, {Origin:'http://evil.invalid'})).status,403);
  assert.equal((await request('/claude/api/new',{}, {'X-Claude-Web':'0'})).status,403);
  assert.equal((await post('access-mode',{accessMode:'invalid'})).status,400);
  if(realUid()===0) assert.equal((await post('access-mode',{accessMode:'full-access'})).status,409);
  process.getuid=()=>1000;
  const catalog=(await request('/claude/api/models')).data.models;assert.equal(catalog[0].model,'sonnet');
  assert.equal((await post('model',{model:'unknown'})).status,400);
  assert.equal((await post('model',{model:'sonnet',effort:'max'})).status,400);
  assert.equal((await post('model',{model:'sonnet',effort:'high'})).status,200);
  await send('hello');const session=app.state.threadId;assert.ok(session);
  assert.equal(calls[0].permissionMode,'default');assert.equal(calls[0].model,'sonnet');assert.equal(calls[0].effort,'high');
  assert.equal(app.state.items.filter(x=>x.text==='Hello from Claude').length,1,'stream and final do not duplicate');
  assert.equal((await post('access-mode',{accessMode:'full-access'})).status,200);await send('again');
  assert.equal(calls.at(-1).resume,session);assert.equal(calls.at(-1).permissionMode,'bypassPermissions');assert.equal(calls.at(-1).allowDangerouslySkipPermissions,true);
  await app.close();await start();assert.equal(app.state.accessMode,'full-access');assert.equal(app.state.threadId,session);assert.equal(app.state.selectedModel,'sonnet');
  await post('access-mode',{accessMode:'workspace'});await send('normal again');assert.equal(calls.at(-1).permissionMode,'default');assert.equal(calls.at(-1).allowDangerouslySkipPermissions,false);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXi0AAAAASUVORK5CYII=';
  assert.equal((await post('message',{text:'',attachments:[{name:'../../image.png',data:png},{name:'empty.txt',data:''}]})).status,200);await until(()=>!app.state.busy);
  const content=lastInput.message.content;assert.equal(content[1].source.media_type,'image/png');assert.equal(content[1].source.data,png);
  const filename=JSON.parse(content[0].text.split('\n').at(-2));assert.ok(filename.startsWith(dataDir+'/uploads/'));assert.equal(fs.statSync(filename).mode&0o777,0o600);
  assert.equal((await post('message',{text:'',attachments:[{name:'bad.txt',data:'!!!'}]})).status,400);
  assert.equal((await post('message',{text:''})).status,400);
  assert.equal((await post('message',{text:'x',attachments:Array(11).fill({name:'x',data:''})})).status,400);
  await post('message',{text:'permission'});await until(()=>app.state.approvals.length);
  assert.equal((await post('access-mode',{accessMode:'full-access'})).status,409);assert.equal((await post('new')).status,409);
  assert.equal((await post('terminal/start',{cols:80,rows:24})).status,409);
  const id=app.state.approvals[0].id;assert.equal((await post('answer',{id,accept:true})).status,200);await until(()=>!app.state.busy);
  assert.ok(app.state.items.some(x=>x.text.includes('"behavior":"allow"')));
  assert.equal((await post('answer',{id,accept:true})).status,409);
  await post('message',{text:'permission'});await until(()=>app.state.approvals.length);await post('answer',{id:app.state.approvals[0].id,accept:false});await until(()=>!app.state.busy);
  assert.ok(app.state.items.some(x=>x.text.includes('"behavior":"deny"')));
  await post('message',{text:'question'});await until(()=>app.state.approvals.length);
  assert.equal((await post('answer',{id:app.state.approvals[0].id,answers:{}})).status,400);
  await post('answer',{id:app.state.approvals[0].id,answers:{0:'Blue'}});await until(()=>!app.state.busy);
  assert.ok(app.state.items.some(x=>x.text.includes('"Which color?":"Blue"')));
  await post('message',{text:'wait'});assert.equal((await post('message',{text:'blocked'})).status,409);await post('stop');await until(()=>!app.state.busy);assert.equal(app.state.error,'');
  await send('fail');assert.match(app.state.error,/Simulated/);await send('recovered');assert.equal(app.state.error,'');
  const terminal=await post('terminal/start',{cols:80,rows:24,command:['sh']});assert.equal(terminal.status,200);
  assert.equal((await post('access-mode',{accessMode:'full-access'})).status,409);
  assert.equal((await post('message',{text:'blocked'})).status,409);
  assert.equal((await post('terminal/input',{id:'stale',data:'eA=='})).status,409);
  assert.equal((await post('terminal/resize',{id:terminal.data.id,cols:0,rows:24})).status,400);
  assert.equal((await post('terminal/input',{id:terminal.data.id,data:Buffer.from('/help').toString('base64')})).status,200);
  await post('terminal/stop',{id:terminal.data.id});await until(()=>!app.state.terminalActive);
  fs.writeFileSync(path.join(workspace,'hello.txt'),'download me');fs.writeFileSync(path.join(workspace,'.secret'),'secret');fs.symlinkSync('/etc/passwd',path.join(workspace,'escape'));fs.symlinkSync(dataDir,path.join(workspace,'private'));
  assert.equal((await request('/claude/files/hello.txt')).data,'download me');assert.equal((await request('/claude/files/.secret')).status,403);
  assert.equal((await request('/claude/files/escape')).status,403);assert.equal((await request('/claude/files/private/conversation.json')).status,403);
  const listing=(await request('/claude/files/')).data;assert.ok(!listing.includes('escape')&&!listing.includes('.secret')&&!listing.includes('private'));
  await post('access-mode',{accessMode:'full-access'});await post('new');assert.equal(app.state.accessMode,'full-access');assert.equal(app.state.selectedModel,'sonnet');assert.equal(app.state.threadId,null);
  await app.close();config.defaultAccessMode='workspace';await start();assert.equal(app.state.accessMode,'full-access');
 }finally{process.getuid=realUid;await app?.close();fs.rmSync(root,{recursive:true,force:true});}
});
