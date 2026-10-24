'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const {EventEmitter} = require('events');
const {PassThrough, Writable} = require('stream');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-upload-test-'));
for (const name of ['index.html', 'app.js', 'style.css', 'terminal.js', 'xterm.js', 'xterm-fit.js', 'xterm.css']) fs.copyFileSync(path.join(__dirname, '..', name), path.join(dir, name));
fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({username: 'test', password: 'test'}));
const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
const processCalls = [], threadCalls = [];
const envFullAccess = process.argv.includes('--full-access'), resume = process.argv.includes('--resume');
const savedOpposite = process.argv.includes('--saved-opposite');
const fullAccess = savedOpposite ? !envFullAccess : envFullAccess;
const expectedSandbox = fullAccess ? 'danger-full-access' : 'workspace-write';
const expectedApproval = fullAccess ? 'never' : 'on-request';
if (resume || savedOpposite) fs.writeFileSync(path.join(dir, 'conversation.json'), JSON.stringify({threadId: resume ? 'test-thread' : null, items: [], ...(savedOpposite ? {accessMode: fullAccess ? 'full-access' : 'workspace'} : {})}));
let holdUnsubscribe = false, releaseUnsubscribe, rejectUnsubscribe = false;
let terminalHandle;
let turns = [], rejectTurn = false, raceModel = false;
const models = [
  {model: 'test-fast', displayName: 'Fast', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{reasoningEffort: 'low'}]},
  {model: 'test-deep', displayName: 'Deep', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{reasoningEffort: 'medium'}, {reasoningEffort: 'high'}]}
];
const emit = data => child.stdout.write(JSON.stringify(data) + '\n');
child.stdin = new Writable({write(chunk, encoding, callback) {
  const m = JSON.parse(chunk);
  if (m.id) setImmediate(() => {
    if (m.method === 'thread/unsubscribe' && rejectUnsubscribe) { rejectUnsubscribe = false; emit({id: m.id, error: {message: 'Simulated policy update failure'}}); return; }
    if (m.method === 'thread/unsubscribe' && holdUnsubscribe) { holdUnsubscribe = false; releaseUnsubscribe = () => emit({id: m.id, result: {}}); return; }
    if (m.method === 'turn/start' && rejectTurn) { rejectTurn = false; emit({id: m.id, error: {message: 'Simulated send failure'}}); return; }
    if (m.method === 'model/list' && raceModel) { raceModel = false; emit({method: 'turn/started', params: {turn: {id: 'race-turn'}}}); }
    const result = m.method === 'model/list' ? {data: m.params.cursor ? [models[1]] : [models[0], {model: 'hidden', hidden: true}], nextCursor: m.params.cursor ? null : 'page2'} : m.method === 'account/read' ? {account: {}} : m.method.startsWith('thread/') ? {thread: {id: 'test-thread'}} : {};
    emit({id: m.id, result});
    if (m.method.startsWith('process/')) processCalls.push(m);
    if (m.method === 'thread/start' || m.method === 'thread/resume') threadCalls.push(m);
    if (m.method === 'process/spawn') {
      terminalHandle = m.params.processHandle;
      emit({method: 'process/outputDelta', params: {processHandle: terminalHandle, deltaBase64: Buffer.from('Codex native terminal ready\r\n').toString('base64')}});
    }
    if (m.method === 'process/writeStdin') emit({method: 'process/outputDelta', params: {processHandle: terminalHandle, deltaBase64: m.params.deltaBase64}});
    if (m.method === 'process/kill') emit({method: 'process/exited', params: {processHandle: terminalHandle, exitCode: 0}});
    if (m.method === 'turn/start') {
      turns.push(m.params);
      emit({method: 'item/completed', params: {threadId: 'test-thread', item: {id: 'user-' + turns.length, type: 'userMessage', content: m.params.input}}});
      emit({method: 'turn/completed', params: {threadId: 'test-thread', turn: {error: null}}});
    }
  });
  callback();
}});
let server;
const fakeHttp = {...http, createServer(handler) {
  server = http.createServer((req, res) => {
    if (req.url === '/test/turns') { res.end(JSON.stringify(turns)); return; }
    if (req.url === '/test/reject') { rejectTurn = true; res.end('{}'); return; }
    return handler(req, res);
  });
  const listen = server.listen.bind(server); server.listen = () => listen(18765, '127.0.0.1'); return server;
}};
let source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.throws(() => vm.runInNewContext(source, {require, __dirname: dir, process: {env: {CODEX_WEB_ACCESS_MODE: 'typo'}}}), /CODEX_WEB_ACCESS_MODE/);
vm.runInNewContext(source, {require: name => name === 'http' ? fakeHttp : name === 'child_process' ? {spawn: () => child} : require(name), __dirname: dir, Buffer, URL, process: {env: {DATA_DIR: dir, WORKSPACE_DIR: path.join(dir, 'workspace'), CODEX_WEB_USERNAME: 'test', CODEX_WEB_PASSWORD: 'test', ...(envFullAccess ? {CODEX_WEB_ACCESS_MODE: 'full-access'} : {})}, stderr: process.stderr, on() {}, exit() {}}, console, setTimeout, clearTimeout, setInterval, clearInterval});
function request(data, headers = {}, endpoint = '/codex/api/message') {
  return new Promise((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port: 18765, path: endpoint, method: data === undefined ? 'GET' : 'POST', headers: {Authorization: 'Basic dGVzdDp0ZXN0', 'X-Codex-Web': '1', 'Content-Type': 'application/json', ...headers}}, res => {
      let text = ''; res.on('data', b => text += b); res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(text)}));
    }); req.on('error', reject); req.end(JSON.stringify(data));
  });
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXi0AAAAASUVORK5CYII=';
async function main() {
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await request({text: 'hello'})).status, 200);
  assert.equal(threadCalls[0].method, resume ? 'thread/resume' : 'thread/start');
  assert.equal(threadCalls[0].params.sandbox, expectedSandbox);
  assert.equal(threadCalls[0].params.approvalPolicy, expectedApproval);
  assert.equal((await request(undefined, {}, '/codex/api/state')).data.accessMode, fullAccess ? 'full-access' : 'workspace');
  assert.deepEqual(turns[0].input, [{type: 'text', text: 'hello'}]);
  assert.equal((await request({text: '', attachments: [{name: '../../screen.png', data: png}, {name: 'notes.txt', data: Buffer.from('example text').toString('base64')}]})).status, 200);
  const input = turns[1].input; assert.equal(input[1].type, 'localImage');
  assert(input[1].path.startsWith(path.join(dir, 'uploads'))); assert(input[1].path.endsWith('0-screen.png'));
  assert(fs.readFileSync(input[1].path).equals(Buffer.from(png, 'base64')));
  assert.equal(fs.statSync(input[1].path).mode & 0o777, 0o600);
  const notes = JSON.parse(input[0].text.split('\n').at(-1)); assert.equal(fs.readFileSync(notes, 'utf8'), 'example text');
  assert.equal((await request({text: '', attachments: [{name: 'empty.txt', data: ''}]})).status, 200);
  for (const data of [null, {text: ''}, {text: 'x', attachments: {}}, {text: 'x', attachments: Array(11).fill({name: 'x', data: ''})}, {text: 'x', attachments: [{name: '../..', data: ''}]}, {text: 'x', attachments: [{name: 'x', data: '!!!'}]}, {text: 'x', attachments: [{name: 'x', data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}]}, {text: 'x', attachments: [0,1,2].map(i => ({name: String(i), data: Buffer.alloc(7 * 1024 * 1024).toString('base64')}))}]) assert.equal((await request(data)).status, 400);
  assert.equal((await request({text: 'x'}, {Authorization: ''})).status, 401);
  assert.equal((await request({text: 'x'}, {Origin: 'http://untrusted.invalid'})).status, 403);
  assert.equal((await request({text: 'x'}, {'X-Codex-Web': ''})).status, 403);
  rejectTurn = true; assert.equal((await request({text: 'retry'})).status, 500);
  assert.equal((await request({text: 'retry'})).status, 200);
  assert.equal((await request(undefined, {Authorization: ''}, '/codex/api/models')).status, 401);
  assert.deepEqual((await request(undefined, {}, '/codex/api/models')).data.models, models);
  assert.equal((await request({model: 'hidden'}, {}, '/codex/api/model')).status, 400);
  assert.equal((await request({model: 'test-deep', effort: 'low'}, {}, '/codex/api/model')).status, 400);
  assert.equal((await request({model: 'test-fast'}, {Origin: 'http://untrusted.invalid'}, '/codex/api/model')).status, 403);
  assert.equal((await request({model: 'test-deep'}, {}, '/codex/api/model')).data.selectedEffort, 'high');
  assert.equal((await request({model: 'test-deep', effort: 'medium'}, {}, '/codex/api/model')).status, 200);
  await request({text: 'selected model'});
  assert.equal(turns.at(-1).model, 'test-deep'); assert.equal(turns.at(-1).effort, 'medium');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'conversation.json')));
  assert.equal(saved.selectedModel, 'test-deep'); assert.equal(saved.selectedEffort, 'medium');
  raceModel = true;
  assert.equal((await request({model: 'test-fast'}, {}, '/codex/api/model')).status, 409);
  assert.equal((await request({model: 'test-fast'}, {}, '/codex/api/model')).status, 409);
  emit({method: 'turn/completed', params: {turn: {error: null}}});
  await request({}, {}, '/codex/api/new');
  assert.equal((await request(undefined, {}, '/codex/api/state')).data.selectedModel, 'test-deep');
  const terminalEndpoint = '/codex/api/terminal/';
  assert.equal((await request({cols: 80, rows: 24}, {Authorization: ''}, terminalEndpoint + 'start')).status, 401);
  assert.equal((await request({cols: 80, rows: 24}, {Origin: 'http://untrusted.invalid'}, terminalEndpoint + 'start')).status, 403);
  assert.equal((await request({cols: 0, rows: 24}, {}, terminalEndpoint + 'start')).status, 400);
  const started = await request({cols: 80, rows: 24, command: ['sh']}, {}, terminalEndpoint + 'start');
  assert.equal(started.status, 200); const id = started.data.id;
  const launch = processCalls.find(c => c.method === 'process/spawn').params;
  assert.equal(launch.command[0], 'codex'); assert.equal(launch.command[launch.command.indexOf('--sandbox') + 1], expectedSandbox); assert.equal(launch.command[launch.command.indexOf('--ask-for-approval') + 1], expectedApproval);
  assert.equal(launch.tty, true); assert.equal(launch.cwd, path.join(dir, 'workspace'));
  assert.equal((await request({text: 'blocked while terminal active'})).status, 409);
  assert.equal((await request({accessMode: 'full-access'}, {}, '/codex/api/access-mode')).status, 409);
  assert.equal((await request({model: 'test-fast'}, {}, '/codex/api/model')).status, 409);
  assert.equal((await request({}, {}, '/codex/api/new')).status, 409);
  assert.equal((await request({cols: 80, rows: 24}, {}, terminalEndpoint + 'start')).status, 409);
  assert.equal((await request({id: 'wrong', data: 'Lw=='}, {}, terminalEndpoint + 'input')).status, 409);
  assert.equal((await request({id, data: '!'}, {}, terminalEndpoint + 'input')).status, 400);
  assert.equal((await request({id, data: Buffer.from('/model\r').toString('base64')}, {}, terminalEndpoint + 'input')).status, 200);
  assert.equal((await request({id, cols: 100, rows: 30}, {}, terminalEndpoint + 'resize')).status, 200);
  assert.equal((await request({id, cols: 99999, rows: 30}, {}, terminalEndpoint + 'resize')).status, 400);
  assert.equal((await request({id}, {}, terminalEndpoint + 'stop')).status, 200);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await request(undefined, {}, '/codex/api/state')).data.terminalActive, false);
  assert.equal((await request({id, data: 'Lw=='}, {}, terminalEndpoint + 'input')).status, 409);
  const accessEndpoint = '/codex/api/access-mode';
  const initialMode = fullAccess ? 'full-access' : 'workspace', oppositeMode = fullAccess ? 'workspace' : 'full-access';
  assert.equal((await request({accessMode: oppositeMode}, {Authorization: ''}, accessEndpoint)).status, 401);
  assert.equal((await request({accessMode: oppositeMode}, {Origin: 'http://untrusted.invalid'}, accessEndpoint)).status, 403);
  assert.equal((await request({accessMode: oppositeMode}, {'X-Codex-Web': ''}, accessEndpoint)).status, 403);
  assert.equal((await request({accessMode: 'invalid'}, {}, accessEndpoint)).status, 400);
  emit({method: 'turn/started', params: {turn: {id: 'busy-access-test'}}});
  assert.equal((await request({accessMode: oppositeMode}, {}, accessEndpoint)).status, 409);
  emit({method: 'turn/completed', params: {turn: {error: null}}});
  await request({text: 'before access change'});
  holdUnsubscribe = true;
  const changing = request({accessMode: oppositeMode}, {}, accessEndpoint);
  while (!releaseUnsubscribe) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await request({text: 'blocked during access change'})).status, 409);
  assert.equal((await request({cols: 80, rows: 24}, {}, terminalEndpoint + 'start')).status, 409);
  assert.equal((await request({accessMode: initialMode}, {}, accessEndpoint)).status, 409);
  releaseUnsubscribe();
  assert.equal((await changing).data.accessMode, oppositeMode);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'conversation.json'))).accessMode, oppositeMode);
  await request({text: 'after access change'});
  assert.equal(threadCalls.at(-1).method, 'thread/resume');
  assert.equal(threadCalls.at(-1).params.approvalPolicy, fullAccess ? 'on-request' : 'never');
  assert.equal(threadCalls.at(-1).params.sandbox, fullAccess ? 'workspace-write' : 'danger-full-access');
  rejectUnsubscribe = true;
  assert.equal((await request({accessMode: initialMode}, {}, accessEndpoint)).status, 500);
  assert.equal((await request(undefined, {}, '/codex/api/state')).data.accessMode, oppositeMode);
  assert.equal((await request(undefined, {}, '/codex/api/state')).data.accessChanging, false);
  const changedTerminal = await request({cols: 80, rows: 24}, {}, terminalEndpoint + 'start');
  const changedLaunch = processCalls.filter(c => c.method === 'process/spawn').at(-1).params.command;
  assert.equal(changedLaunch[changedLaunch.indexOf('--sandbox') + 1], fullAccess ? 'workspace-write' : 'danger-full-access');
  await request({id: changedTerminal.data.id}, {}, terminalEndpoint + 'stop');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await request({accessMode: initialMode}, {}, accessEndpoint)).status, 200);
  await request({text: 'restrictions switched back'});
  assert.equal(threadCalls.at(-1).params.approvalPolicy, expectedApproval);
  assert.equal(threadCalls.at(-1).params.sandbox, expectedSandbox);
  await request({}, {}, '/codex/api/new');
  assert.equal((await request(undefined, {}, '/codex/api/state')).data.accessMode, initialMode);
  console.log('Access switch checks passed: auth, CSRF, validation, busy/terminal locks, concurrent requests, persistence, resume policy, CLI flags, failures, switching back.');
  console.log('Terminal checks passed: auth, origin, fixed executable, sandbox flags, exclusive access, input, resize, stale session rejection, exit.');
  console.log('Model checks passed: paginated catalog, hidden models, auth, validation, defaults, forwarding, persistence, busy race, new conversation.');
  console.log('Backend checks passed: image/file forwarding, private storage, path safety, empty files, validation, authentication, origin checks, retry, text regression.');
  if (!process.argv.includes('--serve')) { server.close(); fs.rmSync(dir, {recursive: true}); }
  else console.log('READY');
}
main().catch(e => { console.error(e); process.exit(1); });
