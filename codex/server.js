'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawn} = require('child_process');
const readline = require('readline');
const dir = __dirname;
const dataDir = process.env.DATA_DIR || '/data';
const workspace = process.env.WORKSPACE_DIR || '/workspace';
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8765);
const defaultAccessMode = process.env.CODEX_WEB_ACCESS_MODE || 'workspace';
if (!['workspace', 'full-access'].includes(defaultAccessMode)) throw new Error('CODEX_WEB_ACCESS_MODE must be workspace or full-access.');
const credentials = {username: process.env.CODEX_WEB_USERNAME || 'admin', password: process.env.CODEX_WEB_PASSWORD};
if (!credentials.password || credentials.password === 'replace-with-a-long-random-password') throw new Error('Set CODEX_WEB_PASSWORD to a strong password before starting.');
fs.mkdirSync(dataDir, {recursive: true, mode: 0o700});
fs.mkdirSync(workspace, {recursive: true, mode: 0o700});
const expected = crypto.createHash('sha256').update('Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64')).digest();
const stateFile = path.join(dataDir, 'conversation.json');
let saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {threadId: null, items: []};
const accessMode = saved.accessMode ?? defaultAccessMode;
if (!['workspace', 'full-access'].includes(accessMode)) throw new Error('Invalid saved access mode.');
let state = {...saved, selectedModel: saved.selectedModel || null, selectedEffort: saved.selectedEffort || null, workspace, accessMode, accessChanging: false, terminalActive: false, busy: false, turnId: null, ready: false, error: '', approvals: []};
function executionPolicy() {
  return state.accessMode === 'full-access' ? {approvalPolicy: 'never', sandbox: 'danger-full-access'} : {approvalPolicy: 'on-request', sandbox: 'workspace-write'};
}
const terminalCodex = process.env.CODEX_BIN || 'codex', terminalWorkspace = workspace;
const listeners = new Set(), pending = new Map();
let sequence = 0, resumed = false, broadcastTimer;
const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--listen', 'stdio://'], {cwd: workspace, stdio: ['pipe', 'pipe', 'pipe']});
child.stderr.on('data', b => process.stderr.write(b));
function send(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 60000);
    pending.set(id, {resolve, reject, timer}); send({id, method, params});
  });
}
// The native CLI owns its terminal menus; this bridge only starts the configured Codex executable.
const terminalListeners = new Set();
let terminal = {id: null, running: false, output: [], bytes: 0, exitCode: null, error: ''};
function terminalStatus() { return {id: terminal.id, running: terminal.running, exitCode: terminal.exitCode, error: terminal.error}; }
function terminalEvent(event, data) {
  const message = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of terminalListeners) {
    if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); terminalListeners.delete(res); }
    else res.write(message);
  }
}
function terminalNotification(method, params) {
  if (!method?.startsWith('process/')) return false;
  if (params.processHandle !== terminal.id) return true;
  if (method === 'process/outputDelta') {
    const bytes = Buffer.from(params.deltaBase64, 'base64');
    terminal.output.push(bytes); terminal.bytes += bytes.length;
    while (terminal.bytes > 2 * 1024 * 1024 && terminal.output.length > 1) terminal.bytes -= terminal.output.shift().length;
    terminalEvent('output', {id: terminal.id, data: params.deltaBase64});
  }
  if (method === 'process/exited') {
    terminal.running = false; terminal.exitCode = params.exitCode;
    terminalEvent('status', terminalStatus());
    finishTerminal().catch(e => { state.error = e.message; broadcast(); });
  }
  return true;
}
async function finishTerminal() {
  // Release cached thread state before the CLI starts, then reload any changes made with /resume.
  try {
    if (state.threadId) {
      const result = await rpc('thread/read', {threadId: state.threadId, includeTurns: true});
      if (Array.isArray(result.thread.turns)) {
        state.items = result.thread.turns.flatMap(turn => (turn.items || []).map(displayItem).filter(Boolean)).slice(-250);
        persist();
      }
    }
  } catch(e) { state.error = 'Could not refresh the chat after the terminal session: ' + e.message; }
  finally { state.terminalActive = false; broadcast(); }
}
function terminalSize(data) {
  if (!Number.isInteger(data.cols) || data.cols < 20 || data.cols > 500 || !Number.isInteger(data.rows) || data.rows < 5 || data.rows > 200) throw Object.assign(new Error('Invalid terminal dimensions.'), {status: 400});
  return {cols: data.cols, rows: data.rows};
}
async function terminalAction(action, data, res) {
  if (action === 'start') {
    const size = terminalSize(data);
    if (state.busy || state.terminalActive) return reply(res, 409, {error: 'Finish the active chat or terminal session first.'});
    state.terminalActive = true; broadcast();
    terminal = {id: 'codex-ui-' + crypto.randomBytes(12).toString('hex'), running: true, output: [], bytes: 0, exitCode: null, error: ''};
    terminalEvent('reset', {...terminalStatus(), output: ''});
    try {
      if (resumed && state.threadId) await rpc('thread/unsubscribe', {threadId: state.threadId});
      resumed = false;
      const {sandbox, approvalPolicy} = executionPolicy();
      const command = [terminalCodex, '--no-daemon', '--sandbox', sandbox, '--ask-for-approval', approvalPolicy, '--cd', terminalWorkspace];
      if (state.selectedModel) command.push('--model', state.selectedModel);
      if (state.selectedEffort) command.push('-c', 'model_reasoning_effort=' + JSON.stringify(state.selectedEffort));
      await rpc('process/spawn', {processHandle: terminal.id, command, cwd: terminalWorkspace, tty: true, size, timeoutMs: null, outputBytesCap: null, env: {TERM: 'xterm-256color', COLORTERM: 'truecolor'}});
      terminalEvent('status', terminalStatus());
      return reply(res, 200, terminalStatus());
    } catch(e) {
      terminal.running = false; terminal.error = e.message; state.terminalActive = false;
      terminalEvent('status', terminalStatus()); broadcast(); throw e;
    }
  }
  if (!terminal.running || data.id !== terminal.id) return reply(res, 409, {error: 'This terminal session is no longer running.'});
  if (action === 'input') {
    if (typeof data.data !== 'string' || data.data.length > 24000 || !data.data || Buffer.from(data.data, 'base64').toString('base64') !== data.data) return reply(res, 400, {error: 'Invalid terminal input.'});
    await rpc('process/writeStdin', {processHandle: terminal.id, deltaBase64: data.data});
  } else if (action === 'resize') {
    await rpc('process/resizePty', {processHandle: terminal.id, size: terminalSize(data)});
  } else if (action === 'stop') {
    await rpc('process/kill', {processHandle: terminal.id});
  } else return reply(res, 404, {error: 'Unknown terminal action.'});
  return reply(res, 200, {ok: true});
}

async function listModels() {
  const models = [], cursors = new Set();
  let cursor;
  do {
    const page = await rpc('model/list', {limit: 100, includeHidden: false, ...(cursor ? {cursor} : {})});
    models.push(...page.data.filter(model => !model.hidden));
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Codex returned a repeated model-list cursor.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return models;
}
function persist() {
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify({threadId: state.threadId, selectedModel: state.selectedModel, selectedEffort: state.selectedEffort, accessMode: state.accessMode, items: state.items.slice(-250)}), {mode: 0o600});
  fs.renameSync(stateFile + '.tmp', stateFile);
}
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const data = 'data: ' + JSON.stringify(state) + '\n\n';
    for (const res of listeners) res.write(data);
  }, 80);
}
function displayItem(item) {
  if (item.type === 'userMessage') return {id: item.id, role: 'user', text: (item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')};
  if (item.type === 'agentMessage' || item.type === 'plan') return {id: item.id, role: 'assistant', text: item.text || ''};
  if (item.type === 'commandExecution') return {id: item.id, role: 'tool', text: item.command + '\n' + (item.aggregatedOutput || '').slice(-20000), status: item.status};
  if (item.type === 'fileChange') return {id: item.id, role: 'tool', text: 'File changes\n' + (item.changes || []).map(c => c.path + '\n' + (c.diff || '')).join('\n').slice(-20000), status: item.status};
  if (item.type === 'mcpToolCall' || item.type === 'webSearch') return {id: item.id, role: 'tool', text: item.tool || item.query || 'Searching', status: item.status};
  return null;
}
readline.createInterface({input: child.stdout}).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (!m.method && pending.has(m.id)) {
    const p = pending.get(m.id); clearTimeout(p.timer); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return;
  }
  const p = m.params || {};
  if (terminalNotification(m.method, p)) return;
  if (p.threadId && p.threadId !== state.threadId) return;
  if (m.id !== undefined && m.method) {
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (supported.includes(m.method)) state.approvals.push({id: m.id, method: m.method, params: p});
    else { send({id: m.id, error: {code: -32601, message: 'This web client does not support ' + m.method}}); state.error = 'Unsupported interaction: ' + m.method; }
    broadcast(); return;
  }
  if (m.method === 'turn/started') { state.turnId = p.turn.id; state.busy = true; }
  if (m.method === 'item/started' || m.method === 'item/completed') {
    const item = displayItem(p.item);
    if (item) { const old = state.items.findIndex(x => x.id === item.id); old < 0 ? state.items.push(item) : state.items.splice(old, 1, item); }
  }
  if (m.method === 'item/agentMessage/delta' || m.method === 'item/commandExecution/outputDelta') {
    const item = state.items.find(x => x.id === p.itemId); if (item) item.text += p.delta || '';
  }
  if (m.method === 'serverRequest/resolved') state.approvals = state.approvals.filter(x => x.id !== p.requestId);
  if (m.method === 'error') state.error = p.error?.message || 'Codex reported an error';
  if (m.method === 'turn/completed') {
    state.busy = false; state.turnId = null; state.approvals = [];
    if (p.turn.error) state.error = p.turn.error.message;
    persist();
  }
  state.items = state.items.slice(-250); broadcast();
});
child.on('error', e => { console.error(e.message); process.exit(1); });
child.on('exit', code => { console.error('Codex app-server exited:', code); process.exit(1); });
async function initialize() {
  await rpc('initialize', {clientInfo: {name: 'codex_lab_web', title: 'Codex Lab Web', version: '1.3.0'}, capabilities: {experimentalApi: true}});
  send({method: 'initialized', params: {}});
  const account = await rpc('account/read');
  if (!account.account) throw new Error('Codex needs a login. Run docker compose run --rm codex-web codex login --device-auth, then restart the service.');
  state.ready = true; broadcast();
}
initialize().catch(e => { state.error = e.message; broadcast(); });
function reply(res, code, data) {
  res.writeHead(code, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data));
}
async function body(req, limit = 100000) {
  let chunks = [], size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Request too large'), {status: 413}); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON'), {status: 400}); }
}
function attachmentsFrom(data) {
  const files = data.attachments === undefined ? [] : data.attachments;
  const invalid = message => { throw Object.assign(new Error(message), {status: 400}); };
  if (!Array.isArray(files) || files.length > 10) invalid('Attach up to 10 files.');
  let total = 0;
  return files.map(file => {
    if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 || typeof file.data !== 'string') invalid('Invalid attachment.');
    if (file.data.length > 4 * Math.ceil(10 * 1024 * 1024 / 3)) invalid('Each file must be 10 MB or smaller.');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data) invalid('Invalid attachment encoding.');
    total += bytes.length;
    if (bytes.length > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) invalid('Each file must be 10 MB or smaller; maximum 20 MB per message.');
    const name = path.basename(file.name.replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
    if (!name || /^\.+$/.test(name)) invalid('Invalid filename.');
    const image = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
      ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) ||
      (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
    return {name, bytes, image};
  });
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'GET' && req.url === '/healthz') return reply(res, 200, {status: 'ok'});
  const actual = crypto.createHash('sha256').update(req.headers.authorization || '').digest();
  if (!crypto.timingSafeEqual(actual, expected)) { res.setHeader('WWW-Authenticate', 'Basic realm="Codex", charset="UTF-8"'); return reply(res, 401, {error: 'Sign in to Codex'}); }
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    if (url.pathname === '/codex') { res.writeHead(302, {Location: '/codex/'}); return res.end(); }
    const files = {'/codex/terminal.js': ['terminal.js','text/javascript'], '/codex/xterm.js': ['xterm.js','text/javascript'], '/codex/xterm-fit.js': ['xterm-fit.js','text/javascript'], '/codex/xterm.css': ['xterm.css','text/css'], '/codex/': ['index.html','text/html'], '/codex/app.js': ['app.js','text/javascript'], '/codex/style.css': ['style.css','text/css']};
    if (files[url.pathname]) { const [file, type] = files[url.pathname]; res.writeHead(200, {'Content-Type': type + '; charset=utf-8'}); return res.end(fs.readFileSync(path.join(dir, file))); }
    if (url.pathname === '/codex/api/terminal/events') {
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no'});
      res.write('event: reset\ndata: ' + JSON.stringify({...terminalStatus(), output: Buffer.concat(terminal.output).toString('base64')}) + '\n\n');
      terminalListeners.add(res);
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
      res.on('close', () => { clearInterval(heartbeat); terminalListeners.delete(res); }); return;
    }
    if (url.pathname === '/codex/api/state') return reply(res, 200, state);
    if (url.pathname === '/codex/api/models') {
      if (!state.ready) return reply(res, 503, {error: 'Codex is not ready.'});
      try { return reply(res, 200, {models: await listModels()}); }
      catch(e) { return reply(res, 502, {error: e.message}); }
    }
    if (url.pathname === '/codex/api/events') {
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no'});
      res.write('data: ' + JSON.stringify(state) + '\n\n'); listeners.add(res);
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
      res.on('close', () => { clearInterval(heartbeat); listeners.delete(res); }); return;
    }
    return reply(res, 404, {error: 'Not found'});
  }
  if (req.method !== 'POST') return reply(res, 405, {error: 'Method not allowed'});
  let originOK = !req.headers.origin;
  try { if (req.headers.origin) originOK = new URL(req.headers.origin).host === req.headers.host; } catch {}
  if (req.headers['x-codex-web'] !== '1' || !originOK) return reply(res, 403, {error: 'Request origin rejected'});
  try {
    const data = await body(req, url.pathname === '/codex/api/message' ? 29 * 1024 * 1024 : 100000);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return reply(res, 400, {error: 'Invalid request.'});
    if (!state.ready) return reply(res, 503, {error: state.error || 'Codex is starting'});
    if (state.accessChanging) return reply(res, 409, {error: 'Wait for the access mode change to finish.'});
    if (url.pathname.startsWith('/codex/api/terminal/')) return await terminalAction(url.pathname.slice('/codex/api/terminal/'.length), data, res);
    if (state.terminalActive) return reply(res, 409, {error: 'End the Codex terminal session before using Chat.'});
    if (url.pathname === '/codex/api/access-mode') {
      if (state.busy) return reply(res, 409, {error: 'Finish or stop the current task before changing access.'});
      if (!['workspace', 'full-access'].includes(data.accessMode)) return reply(res, 400, {error: 'Choose workspace or full-access.'});
      if (data.accessMode === state.accessMode) return reply(res, 200, {accessMode: state.accessMode});
      const previous = state.accessMode;
      state.accessChanging = true; broadcast();
      try {
        if (resumed && state.threadId) await rpc('thread/unsubscribe', {threadId: state.threadId});
        resumed = false;
        state.accessMode = data.accessMode;
        persist();
      } catch(e) { state.accessMode = previous; throw e; }
      finally { state.accessChanging = false; broadcast(); }
      return reply(res, 200, {accessMode: state.accessMode});
    }
    if (url.pathname === '/codex/api/model') {
      if (state.busy) return reply(res, 409, {error: 'Wait for the current task or stop it before changing models.'});
      const models = await listModels();
      if (state.busy || state.terminalActive) return reply(res, 409, {error: 'A task or terminal started while loading models. Try again when it finishes.'});
      const model = models.find(model => model.model === data.model);
      if (!model) return reply(res, 400, {error: 'Choose a model from the available list.'});
      const efforts = model.supportedReasoningEfforts || [];
      const effort = data.effort === undefined ? (efforts.length ? model.defaultReasoningEffort : null) : data.effort;
      if (effort !== null && !efforts.some(option => option.reasoningEffort === effort)) return reply(res, 400, {error: 'Choose a supported reasoning effort for this model.'});
      state.selectedModel = model.model; state.selectedEffort = effort;
      persist(); broadcast();
      return reply(res, 200, {selectedModel: state.selectedModel, selectedEffort: state.selectedEffort});
    }
    if (url.pathname === '/codex/api/message') {
      if (state.busy) return reply(res, 409, {error: 'Wait for the current task or stop it first.'});
      const files = attachmentsFrom(data);
      if (typeof data.text !== 'string' || (!data.text.trim() && !files.length) || data.text.length > 50000) return reply(res, 400, {error: 'Enter a message or attach a file (maximum 50,000 characters).'});
      state.busy = true; state.error = ''; broadcast();
      try {
        if (!resumed) {
          const policy = {cwd: workspace, ...executionPolicy()};
          const t = state.threadId ? await rpc('thread/resume', {...policy, threadId: state.threadId}) : await rpc('thread/start', policy);
          state.threadId = t.thread.id; resumed = true; persist();
        }
        const input = [{type: 'text', text: data.text.trim() || 'Please inspect the attached files.'}];
        if (files.length) {
          const uploadDir = path.join(dataDir, 'uploads');
          fs.mkdirSync(uploadDir, {recursive: true, mode: 0o700});
          const batch = fs.mkdtempSync(path.join(uploadDir, 'message-'));
          const paths = files.map((file, index) => {
            const filename = path.join(batch, index + '-' + file.name);
            fs.writeFileSync(filename, file.bytes, {mode: 0o600, flag: 'wx'});
            if (file.image) input.push({type: 'localImage', path: filename});
            return JSON.stringify(filename);
          });
          input[0].text += '\n\nAttached files (saved locally):\n' + paths.join('\n');
        }
        await rpc('turn/start', {threadId: state.threadId, input, ...(state.selectedModel ? {model: state.selectedModel, effort: state.selectedEffort} : {})});
      } catch(e) { state.busy = false; throw e; }
      return reply(res, 200, {ok: true});
    }
    if (url.pathname === '/codex/api/stop') {
      if (state.turnId) await rpc('turn/interrupt', {threadId: state.threadId, turnId: state.turnId});
      return reply(res, 200, {ok: true});
    }
    if (url.pathname === '/codex/api/new') {
      if (state.busy) return reply(res, 409, {error: 'Stop the active task before starting a new chat.'});
      state = {...state, threadId: null, items: [], error: '', approvals: []}; resumed = false; persist(); broadcast(); return reply(res, 200, {ok: true});
    }
    if (url.pathname === '/codex/api/answer') {
      const a = state.approvals.find(x => x.id === data.id);
      if (!a) return reply(res, 409, {error: 'This request is no longer pending.'});
      let result;
      if (a.method === 'item/tool/requestUserInput') {
        result = {answers: {}};
        for (const q of a.params.questions || []) result.answers[q.id] = {answers: [String(data.answers?.[q.id] || '')]};
      } else if (a.method === 'item/permissions/requestApproval') result = {permissions: data.accept === true ? a.params.permissions : {}, scope: 'turn'};
      else result = {decision: data.accept === true ? 'accept' : 'decline'};
      send({id: a.id, result}); state.approvals = state.approvals.filter(x => x.id !== a.id); broadcast(); return reply(res, 200, {ok: true});
    }
    reply(res, 404, {error: 'Not found'});
  } catch(e) { state.error = e.message; broadcast(); reply(res, e.status || 500, {error: e.message}); }
});
server.listen(port, host, () => console.log('Codex web listening on ' + host + ':' + port));
process.on('SIGTERM', () => { child.kill('SIGTERM'); server.close(); process.exit(0); });
