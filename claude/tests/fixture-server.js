'use strict';
const fs=require('fs'),crypto=require('crypto');
const {createApp}=require('../server.js');
const config=require('../options.js')();
// Model calls are mocked in this isolated test server; it never uses an account.
const sdk={query({prompt,options}) {
 let end;const wait=new Promise(r=>end=r);const abort=new AbortController();
 return {supportedModels:async()=>[{value:'sonnet',displayName:'Sonnet',supportedEffortLevels:['low','high']},{value:'haiku',displayName:'Haiku'}],close(){abort.abort();end();},interrupt:async()=>{abort.abort();end();},async *[Symbol.asyncIterator](){
 const input=(await prompt[Symbol.asyncIterator]().next()).value,session_id=options.resume||crypto.randomUUID();
 fs.writeFileSync(config.dataDir+'/last-turn.json',JSON.stringify({input,model:options.model,effort:options.effort,permissionMode:options.permissionMode,resume:options.resume}));
 yield {type:'system',subtype:'init',session_id};
 if(input.message.content[0].text==='wait'){await wait;return;}
 if(input.message.content[0].text==='ask permission') await options.canUseTool('Bash',{command:'echo test'},{signal:abort.signal});
 yield {type:'assistant',session_id,message:{id:crypto.randomUUID(),content:[{type:'text',text:'Claude test response'}]}};
 yield {type:'result',session_id,is_error:false};
 }};
}};
// The production guard is separately tested; local browser fixtures may run as root.
if(process.env.CLAUDE_TEST_FAKE_UID==='1') process.getuid=()=>1000;
const app=createApp(config,sdk,require('node-pty'));
app.server.listen(config.port,config.host,()=>console.log('READY'));
app.initialize();process.on('SIGTERM',()=>app.close().finally(()=>process.exit(0)));
