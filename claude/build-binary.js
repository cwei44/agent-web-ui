'use strict';
// Build a self-contained Linux launcher. Claude Code is supplied with --claude.
const fs=require('fs'),path=require('path'),zlib=require('zlib'),{execFileSync}=require('child_process');
process.chdir(__dirname);
if(process.platform!=='linux'||process.arch!=='x64'||!process.versions.node.startsWith('22.')) throw Error('Build using Node.js 22 on Linux x64.');
const build=path.resolve('build'),runtime=path.join(build,'runtime');fs.mkdirSync(runtime,{recursive:true});fs.mkdirSync('dist',{recursive:true});
const assets=['server.js','options.js','files.js','app.js','index.html','style.css','terminal.js','xterm.js','xterm-fit.js','xterm.css','XTERM-LICENSE','package.json'];
for(const name of assets) fs.copyFileSync(name,path.join(runtime,name));
fs.copyFileSync(process.execPath,path.join(runtime,'node'));fs.chmodSync(path.join(runtime,'node'),0o755);
const lock=JSON.parse(fs.readFileSync('package-lock.json'));
for(const [name,pkg] of Object.entries(lock.packages)) {
  if(!name||pkg.dev||pkg.optional) continue;
  fs.cpSync(name,path.join(runtime,name),{recursive:true,filter:p=>!path.relative(name,p).split(path.sep).includes('node_modules')});
}
const entries=[];
function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
 const p=path.join(dir,item.name);if(item.isDirectory()) walk(p);else if(item.isFile()) entries.push({path:path.relative(runtime,p),mode:fs.statSync(p).mode&0o777,data:fs.readFileSync(p).toString('base64')});
}}
walk(runtime);
fs.writeFileSync(path.join(build,'runtime.gz'),zlib.gzipSync(JSON.stringify(entries),{level:6}));
const main=`'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),zlib=require('zlib'),{spawn}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-ui-'));fs.chmodSync(dir,0o700);
try {
 const entries=JSON.parse(zlib.gunzipSync(Buffer.from(require('node:sea').getAsset('runtime'))));
 for(const entry of entries){const file=path.join(dir,entry.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(entry.data,'base64'),{mode:entry.mode});}
 const child=spawn(path.join(dir,'node'),[path.join(dir,'server.js'),...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,PATH:dir+path.delimiter+process.env.PATH}});
 for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
 child.on('error',e=>{console.error(e.message);fs.rmSync(dir,{recursive:true,force:true});process.exitCode=1;});
 child.on('exit',(code)=>{fs.rmSync(dir,{recursive:true,force:true});process.exitCode=code??1;});
} catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
`;
fs.writeFileSync(path.join(build,'main.js'),main);
fs.writeFileSync(path.join(build,'sea.json'),JSON.stringify({main:path.join(build,'main.js'),output:path.join(build,'sea.blob'),disableExperimentalSEAWarning:true,useCodeCache:false,useSnapshot:false,execArgvExtension:'none',assets:{runtime:path.join(build,'runtime.gz')}}));
execFileSync(process.execPath,['--experimental-sea-config',path.join(build,'sea.json')],{stdio:'inherit'});
const target=path.resolve('dist/claude-ui-linux-x64');fs.copyFileSync(process.execPath,target);
execFileSync(process.execPath,[require.resolve('postject/dist/cli.js'),target,'NODE_SEA_BLOB',path.join(build,'sea.blob'),'--sentinel-fuse','NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],{stdio:'inherit'});
fs.chmodSync(target,0o755);console.log(target);
