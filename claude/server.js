'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const {execFile} = require('child_process');
const {promisify} = require('util');
function reply(res, code, data) { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); }
const invalid = (message, status=400) => Object.assign(new Error(message), {status});
async function body(req, limit) {
  let size=0, chunks=[];
  for await (const chunk of req) { size+=chunk.length; if (size>limit) throw invalid('Request too large.',413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw invalid('Invalid JSON.'); }
}
function attachmentsFrom(data) {
  const files=data.attachments ?? []; let total=0;
  if (!Array.isArray(files) || files.length>10) throw invalid('Attach up to 10 files.');
  return files.map(file => {
    if (!file || typeof file.name!=='string' || !file.name.trim() || file.name.length>255 || typeof file.data!=='string') throw invalid('Invalid attachment.');
    if (file.data.length>4*Math.ceil(10*1024*1024/3)) throw invalid('Each file must be 10 MB or smaller.');
    const bytes=Buffer.from(file.data,'base64'); total+=bytes.length;
    if (bytes.toString('base64')!==file.data) throw invalid('Invalid attachment encoding.');
    if (bytes.length>10*1024*1024 || total>20*1024*1024) throw invalid('Each file must be 10 MB or smaller; maximum 20 MB per message.');
    const name=path.basename(file.name.replace(/\\/g,'/')).replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,180);
    if (!name || /^\.+$/.test(name)) throw invalid('Invalid filename.');
    const mediaType=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes[0]===255 && bytes[1]===216 && bytes[2]===255 ? 'image/jpeg' : ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)) ? 'image/gif' : bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP' ? 'image/webp' : null;
    if (mediaType && bytes.length>5*1024*1024) throw invalid('Images must be 5 MB or smaller for Claude.');
    return {name,bytes,mediaType};
  });
}
function createApp(config, sdk, pty) {
  const {dataDir,workspace,claude,credentials}=config;
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  const stateFile=path.join(dataDir,'conversation.json');
  const saved=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):{threadId:null,items:[]};
  const accessMode=saved.accessMode ?? config.defaultAccessMode ?? 'workspace';
  if (!['workspace','full-access'].includes(accessMode)) throw new Error('Invalid access mode. Use workspace or full-access.');
  const state={...saved,workspace,accessMode,selectedModel:saved.selectedModel || null,selectedEffort:saved.selectedEffort || null,ready:false,busy:false,terminalActive:false,accessChanging:false,approvals:[],error:''};
  const expected=crypto.createHash('sha256').update('Basic '+Buffer.from(credentials.username+':'+credentials.password).toString('base64')).digest();
  const listeners=new Set(), terminalListeners=new Set(), pending=new Map();
  let activeQuery, stopRequested=false, terminalProcess, timer, modelLoad;
  let terminal={id:null,running:false,output:[],bytes:0,exitCode:null,error:''};
  const terminalStatus=()=>({id:terminal.id,running:terminal.running,exitCode:terminal.exitCode,error:terminal.error});
  function persist() {
    fs.writeFileSync(stateFile+'.tmp',JSON.stringify({threadId:state.threadId,items:state.items.slice(-250),selectedModel:state.selectedModel,selectedEffort:state.selectedEffort,accessMode:state.accessMode}),{mode:0o600});
    fs.renameSync(stateFile+'.tmp',stateFile);
  }
  function broadcast() {
    clearTimeout(timer); timer=setTimeout(()=>{
      const message='data: '+JSON.stringify(state)+'\n\n';
      for (const res of listeners) { if (res.writableLength>2*1024*1024) res.destroy(); else res.write(message); }
    },25);
  }
  function terminalEvent(event,data) {
    for (const res of terminalListeners) { if (res.writableLength>2*1024*1024) res.destroy(); else res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n'); }
  }
  function options() {
    return {pathToClaudeCodeExecutable:claude,cwd:workspace,settingSources:['user','project','local'],systemPrompt:{type:'preset',preset:'claude_code'},permissionMode:state.accessMode==='full-access'?'bypassPermissions':'default',allowDangerouslySkipPermissions:state.accessMode==='full-access',includePartialMessages:true,canUseTool, ...(state.selectedModel?{model:state.selectedModel}:{}),...(state.selectedEffort?{effort:state.selectedEffort}:{})};
  }
  function checkFullAccess() {
    if (process.getuid?.()===0) throw invalid('Claude Code refuses Full Access as root. Run this UI as a non-root user; the portable container already does.',409);
  }
  async function listModels() {
    if (modelLoad) return modelLoad;
    modelLoad=(async()=>{
      let release; const wait=new Promise(r=>release=r);
      // Discovery starts the CLI without submitting a prompt or using model tokens.
      const q=sdk.query({prompt:(async function*(){await wait;})(),options:{...options(),permissionMode:'default',allowDangerouslySkipPermissions:false}});
      try { return (await q.supportedModels()).map(m=>({model:m.value,displayName:m.displayName,description:m.description,isDefault:m.value==='default',defaultReasoningEffort:null,supportedReasoningEfforts:(m.supportedEffortLevels || []).map(e=>({reasoningEffort:e}))})); }
      finally { release(); q.close(); }
    })();
    try { return await modelLoad; } finally { modelLoad=null; }
  }
  function canUseTool(tool,input,context) {
    if (context.signal.aborted) return Promise.resolve({behavior:'deny',message:'Task stopped.'});
    return new Promise(resolve=>{
      const id=crypto.randomUUID();
      const question=tool==='AskUserQuestion';
      const approval={id,method:question?'tool/requestUserInput':'tool/requestApproval',params:question?{questions:(input.questions || []).map((q,index)=>({...q,id:String(index)}))}:{reason:context.decisionReason || tool,command:JSON.stringify(input,null,2),cwd:workspace}};
      const finish=result=>{context.signal.removeEventListener('abort',abort);pending.delete(id);state.approvals=state.approvals.filter(a=>a.id!==id);broadcast();resolve(result);};
      const abort=()=>finish({behavior:'deny',message:'Task stopped.',interrupt:true});
      pending.set(id,{approval,input,finish});state.approvals.push(approval);context.signal.addEventListener('abort',abort,{once:true});broadcast();
    });
  }
  function put(item) {
    const index=state.items.findIndex(x=>x.id===item.id);
    if(index<0) state.items.push(item); else state.items[index]=item;
    state.items=state.items.slice(-250);broadcast();
  }
  function contentItems(message, prefix) {
    const content=message.message?.content;
    if(typeof content==='string') return [{id:message.uuid,role:message.type==='user'?'user':'assistant',text:content}];
    return (content || []).flatMap((block,index)=>{
      const id=prefix+':'+index;
      if(block.type==='text') return [{id,role:message.type==='user'?'user':'assistant',text:block.text}];
      if(block.type==='tool_use') return [{id:block.id,role:'activity',status:'running',text:block.name+'\n'+JSON.stringify(block.input,null,2)}];
      if(block.type==='tool_result') return [{id:block.tool_use_id+':result',role:'activity',status:block.is_error?'failed':'completed',text:typeof block.content==='string'?block.content:JSON.stringify(block.content)}];
      return [];
    });
  }
  async function runTurn(content) {
    let release; const wait=new Promise(r=>release=r);
    let messageId, resultSeen=false;
    try {
      activeQuery=sdk.query({prompt:(async function*(){yield {type:'user',session_id:state.threadId || '',parent_tool_use_id:null,message:{role:'user',content}};await wait;})(),options:{...options(),...(state.threadId?{resume:state.threadId}:{})}});
      for await (const m of activeQuery) {
        if(m.session_id && m.session_id!==state.threadId) {state.threadId=m.session_id;persist();}
        if(m.type==='stream_event' && !m.parent_tool_use_id) {
          const e=m.event;
          if(e.type==='message_start') messageId=e.message.id;
          if(e.type==='content_block_start' && e.content_block.type==='text') put({id:messageId+':'+e.index,role:'assistant',text:e.content_block.text || ''});
          if(e.type==='content_block_delta' && e.delta.type==='text_delta') {
            const item=state.items.find(x=>x.id===messageId+':'+e.index); if(item) {item.text+=e.delta.text;broadcast();}
          }
        }
        if(m.type==='assistant' && !m.parent_tool_use_id) for(const item of contentItems(m,m.message.id)) put(item);
        if(m.type==='user' && !m.parent_tool_use_id) for(const item of contentItems(m,m.uuid).filter(x=>x.role==='activity')) put(item);
        if(m.type==='result') {
          resultSeen=true;
          if(m.is_error) state.error=(m.errors || [m.result || 'Claude could not complete this task.']).join('\n');
          release(); break;
        }
      }
      if(!resultSeen && !stopRequested) state.error='Claude exited before completing the task. Check its login and configuration.';
    } catch(e) { if(!stopRequested) state.error=e.message; }
    finally {
      release(); activeQuery?.close(); activeQuery=null;
      for(const p of [...pending.values()]) p.finish({behavior:'deny',message:'Task ended.'});
      state.busy=false;state.approvals=[];persist();broadcast();
    }
  }
  async function terminalFinished(exitCode) {
    terminal.running=false;terminal.exitCode=exitCode;terminalProcess=null;
    try {
      if(state.threadId && sdk.getSessionMessages) {
        const messages=await sdk.getSessionMessages(state.threadId,{dir:workspace});
        if(messages.length) { state.items=messages.flatMap(m=>contentItems(m,m.message?.id || m.uuid)).slice(-250); persist(); }
      }
    } catch(e) {state.error='Could not refresh chat history: '+e.message;}
    finally {state.terminalActive=false;terminalEvent('status',terminalStatus());broadcast();}
  }
  function size(data) { if(!Number.isInteger(data.cols)||data.cols<20||data.cols>500||!Number.isInteger(data.rows)||data.rows<5||data.rows>200) throw invalid('Invalid terminal dimensions.'); }
  async function terminalAction(action,data,res) {
    if(action==='start') {
      size(data);if(state.busy||state.terminalActive) throw invalid('Finish the active chat or terminal session first.',409);
      if(state.accessMode==='full-access') checkFullAccess();
      const args=['--permission-mode',state.accessMode==='full-access'?'bypassPermissions':'default'];
      if(state.accessMode==='full-access') args.push('--allow-dangerously-skip-permissions');
      if(state.selectedModel) args.push('--model',state.selectedModel);
      if(state.selectedEffort) args.push('--effort',state.selectedEffort);
      state.terminalActive=true;terminal={id:crypto.randomUUID(),running:true,output:[],bytes:0,exitCode:null,error:''};
      try {
        terminalProcess=pty.spawn(claude,args,{name:'xterm-256color',cols:data.cols,rows:data.rows,cwd:workspace,env:{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor'}});
        terminalProcess.onData(text=>{const bytes=Buffer.from(text);terminal.output.push(bytes);terminal.bytes+=bytes.length;while(terminal.bytes>2*1024*1024&&terminal.output.length>1) terminal.bytes-=terminal.output.shift().length;terminalEvent('output',{id:terminal.id,data:bytes.toString('base64')});});
        terminalProcess.onExit(({exitCode})=>{terminalFinished(exitCode).catch(e=>{state.error=e.message;broadcast();});});
      } catch(e) {state.terminalActive=false;terminal.running=false;terminal.error=e.message;broadcast();throw e;}
      terminalEvent('reset',{...terminalStatus(),output:''});broadcast();return reply(res,200,terminalStatus());
    }
    if(!terminal.running||data.id!==terminal.id) throw invalid('This terminal session is no longer active.',409);
    if(action==='input') {
      if(typeof data.data!=='string'||data.data.length>90000) throw invalid('Invalid terminal input.');
      const bytes=Buffer.from(data.data,'base64');if(bytes.toString('base64')!==data.data) throw invalid('Invalid terminal encoding.');
      terminalProcess.write(bytes.toString('utf8'));
    } else if(action==='resize') {size(data);terminalProcess.resize(data.cols,data.rows);}
    else if(action==='stop') terminalProcess.kill();
    else throw invalid('Unknown terminal action.',404);
    return reply(res,200,{ok:true});
  }
  function events(res,set,initial) {
    res.writeHead(200,{'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});res.write(initial);set.add(res);
    const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);res.on('close',()=>{clearInterval(heartbeat);set.delete(res);});
  }
  const serveFolder=require('./files.js')(config,reply);
  const handler=async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(req.method==='GET'&&req.url==='/healthz') return reply(res,200,{status:'ok'});
    const actual=crypto.createHash('sha256').update(req.headers.authorization || '').digest();
    if(!crypto.timingSafeEqual(actual,expected)) {res.setHeader('WWW-Authenticate','Basic realm="Claude", charset="UTF-8"');return reply(res,401,{error:'Sign in to Claude Web'});}
    try {
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET') {
        if(url.pathname==='/claude') {res.writeHead(302,{Location:'/claude/'});return res.end();}
        if(url.pathname==='/claude/files'||url.pathname.startsWith('/claude/files/')) return serveFolder(req,res,req.url.split('?')[0]);
        const assets={'':'index.html','app.js':'app.js','style.css':'style.css','terminal.js':'terminal.js','xterm.js':'xterm.js','xterm-fit.js':'xterm-fit.js','xterm.css':'xterm.css'};
        const name=url.pathname.startsWith('/claude/')?assets[url.pathname.slice(8)]:null;
        if(name) {res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,name)));}
        if(url.pathname==='/claude/api/state') return reply(res,200,state);
        if(url.pathname==='/claude/api/events') return events(res,listeners,'data: '+JSON.stringify(state)+'\n\n');
        if(url.pathname==='/claude/api/terminal/events') return events(res,terminalListeners,'event: reset\ndata: '+JSON.stringify({...terminalStatus(),output:Buffer.concat(terminal.output).toString('base64')})+'\n\n');
        if(url.pathname==='/claude/api/models') return reply(res,200,{models:await listModels()});
        return reply(res,404,{error:'Not found'});
      }
      if(req.method!=='POST') return reply(res,405,{error:'Method not allowed'});
      let originOK=!req.headers.origin;try {if(req.headers.origin) originOK=new URL(req.headers.origin).host===req.headers.host;}catch{}
      if(req.headers['x-claude-web']!=='1'||!originOK) return reply(res,403,{error:'Request origin rejected'});
      const data=await body(req,url.pathname==='/claude/api/message'?29*1024*1024:100000);
      if(!data||typeof data!=='object'||Array.isArray(data)) throw invalid('Invalid request.');
      if(!state.ready) throw invalid(state.error || 'Claude is starting.',503);
      if(url.pathname.startsWith('/claude/api/terminal/')) return await terminalAction(url.pathname.slice('/claude/api/terminal/'.length),data,res);
      if(state.terminalActive) throw invalid('End the Claude terminal session before using Chat.',409);
      if(url.pathname==='/claude/api/answer') {
        const p=pending.get(data.id);if(!p) throw invalid('This request is no longer pending.',409);
        if(p.approval.method.endsWith('requestUserInput')) {
          const answers={};
          for(const q of p.approval.params.questions) {const answer=data.answers?.[q.id];if(typeof answer!=='string'||!answer.trim()) throw invalid('Answer each question.');answers[q.question]=answer;}
          p.finish({behavior:'allow',updatedInput:{...p.input,answers}});
        } else {if(typeof data.accept!=='boolean') throw invalid('Choose Allow once or Deny.');p.finish(data.accept?{behavior:'allow',updatedInput:p.input}:{behavior:'deny',message:'User denied this request.'});}
        return reply(res,200,{ok:true});
      }
      if(url.pathname==='/claude/api/stop') {
        if(activeQuery) {stopRequested=true;await activeQuery.interrupt();}
        return reply(res,200,{ok:true});
      }
      if(state.busy) throw invalid('Finish or stop the current task first.',409);
      if(url.pathname==='/claude/api/access-mode') {
        if(!['workspace','full-access'].includes(data.accessMode)) throw invalid('Choose workspace or full-access.');
        if(data.accessMode==='full-access') checkFullAccess();
        const previous=state.accessMode;state.accessMode=data.accessMode;
        try {persist();}catch(e){state.accessMode=previous;throw e;}broadcast();return reply(res,200,{accessMode:state.accessMode});
      }
      if(url.pathname==='/claude/api/model') {
        const models=await listModels();if(state.busy||state.terminalActive) throw invalid('A task or terminal started while loading models. Try again when idle.',409);
        const model=models.find(m=>m.model===data.model);if(!model) throw invalid('Choose a model from the available list.');
        const effort=data.effort ?? null;if(effort!==null&&!model.supportedReasoningEfforts.some(e=>e.reasoningEffort===effort)) throw invalid('Choose a supported reasoning effort.');
        const previous=[state.selectedModel,state.selectedEffort];state.selectedModel=model.model;state.selectedEffort=effort;
        try {persist();}catch(e){[state.selectedModel,state.selectedEffort]=previous;throw e;}broadcast();return reply(res,200,{selectedModel:state.selectedModel,selectedEffort:state.selectedEffort});
      }
      if(url.pathname==='/claude/api/new') {state.threadId=null;state.items=[];state.error='';persist();broadcast();return reply(res,200,{ok:true});}
      if(url.pathname==='/claude/api/message') {
        const files=attachmentsFrom(data);
        if(typeof data.text!=='string'||(!data.text.trim()&&!files.length)||data.text.length>50000) throw invalid('Enter a message or attach a file (maximum 50,000 characters).');
        if(state.accessMode==='full-access') checkFullAccess();
        const content=[{type:'text',text:data.text.trim()||'Please inspect the attached files.'}];
        if(files.length) {
          const uploads=path.join(dataDir,'uploads');fs.mkdirSync(uploads,{recursive:true,mode:0o700});const batch=fs.mkdtempSync(path.join(uploads,'message-'));
          const names=files.map((file,i)=>{const filename=path.join(batch,i+'-'+file.name);fs.writeFileSync(filename,file.bytes,{mode:0o600,flag:'wx'});if(file.mediaType) content.push({type:'image',source:{type:'base64',media_type:file.mediaType,data:file.bytes.toString('base64')}});return JSON.stringify(filename);});
          content[0].text+='\n\nAttached files (saved locally):\n'+names.join('\n');
        }
        state.items.push({id:crypto.randomUUID(),role:'user',text:content[0].text});state.busy=true;state.error='';stopRequested=false;persist();broadcast();
        runTurn(content).catch(e=>{state.busy=false;state.error=e.message;broadcast();});return reply(res,200,{ok:true});
      }
      return reply(res,404,{error:'Not found'});
    }catch(e){return reply(res,e.status||500,{error:e.message});}
  };
  const server=config.tls?https.createServer(config.tls,handler):http.createServer(handler);
  async function initialize() {
    try {const result=await promisify(execFile)(claude,['auth','status'],{cwd:workspace,timeout:30000,maxBuffer:1024*1024});if(!JSON.parse(result.stdout).loggedIn) throw new Error('Not logged in');state.ready=true;state.error='';}
    catch {state.error='Claude needs a login. Run ./claude-web.sh login, or claude auth login as the service user, then restart this UI.';}
    broadcast();
  }
  async function close() {activeQuery?.close();terminalProcess?.kill();clearTimeout(timer);for(const res of [...listeners,...terminalListeners]) res.end();await new Promise(r=>server.close(r));}
  return {server,state,initialize,close,listModels};
}
module.exports={createApp,attachmentsFrom};
if(require.main===module) (async()=>{
  const config=require('./options.js')();
  const sdk=await import('@anthropic-ai/claude-agent-sdk');
  const app=createApp(config,sdk,require('node-pty'));
  app.server.listen(config.port,config.host,()=>console.log('Claude web listening on '+config.host+':'+config.port+'/claude/'));
  app.server.on('error',e=>{console.error(e.message);process.exit(1);});
  app.initialize();
  process.on('SIGTERM',()=>app.close().finally(()=>process.exit(0)));
  process.on('SIGINT',()=>app.close().finally(()=>process.exit(0)));
})().catch(e=>{console.error(e.message);process.exit(1);});
