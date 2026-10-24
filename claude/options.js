'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
module.exports = function options() {
  const {values: a} = require('util').parseArgs({options: {
    claude: {type: 'string'}, folder: {type: 'string'}, host: {type: 'string'}, port: {type: 'string'},
    'data-dir': {type: 'string'}, username: {type: 'string'}, 'password-file': {type: 'string'},
    'tls-cert': {type: 'string'}, 'tls-key': {type: 'string'}, help: {type: 'boolean', short: 'h'}, version: {type: 'boolean'}
  }});
  if (a.help) {
    console.log(`Claude Web UI 1.0.0
Usage: node server.js --claude /path/to/claude --folder /path/to/project [options]
  --host ADDRESS       Default 127.0.0.1 (container: 0.0.0.0)
  --port NUMBER        Default 8766
  --data-dir PATH      Persistent chat/uploads/password directory
  --username NAME      Web login (default admin)
  --password-file PATH Read web password; otherwise generate one in data-dir
  --tls-cert PATH      HTTPS certificate; requires --tls-key PATH
  --tls-key PATH       HTTPS private key
  --version            Print version
UI: /claude/   Workspace downloads: /claude/files/   Health: /healthz
Environment: CLAUDE_BIN, WORKSPACE_DIR, DATA_DIR, HOST, PORT,
CLAUDE_WEB_USERNAME, CLAUDE_WEB_PASSWORD, CLAUDE_WEB_ACCESS_MODE.
Claude uses its existing login, or CLAUDE_CONFIG_DIR / ANTHROPIC_API_KEY.
Run as a non-root user to enable Claude's Full Access mode.`);
    process.exit(0);
  }
  if (a.version) { console.log('claude-web 1.0.0'); process.exit(0); }
  const bin = a.claude || process.env.CLAUDE_BIN || 'claude';
  const candidate = bin.includes('/') ? path.resolve(bin) : (process.env.PATH || '').split(path.delimiter).map(p => path.join(p, bin)).find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (!candidate) throw new Error('Claude Code was not found. Set --claude or CLAUDE_BIN.');
  const claude = fs.realpathSync(candidate); fs.accessSync(claude, fs.constants.X_OK);
  const workspace = fs.realpathSync(a.folder || process.env.WORKSPACE_DIR || process.cwd());
  if (!fs.statSync(workspace).isDirectory()) throw new Error('Workspace must be a directory.');
  const dataDir = path.resolve(a['data-dir'] || process.env.DATA_DIR || path.join(require('os').homedir(), '.local/state/claude-web', crypto.createHash('sha256').update(workspace).digest('hex').slice(0,16)));
  fs.mkdirSync(dataDir, {recursive:true, mode:0o700});
  const secretPaths = [fs.realpathSync(dataDir), claude];
  if (workspace === secretPaths[0] || workspace.startsWith(secretPaths[0] + path.sep)) throw new Error('Data directory must not contain the workspace.');
  for (const name of [process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude'), path.join(require('os').homedir(), '.claude.json')]) if (fs.existsSync(name)) secretPaths.push(fs.realpathSync(name));
  let password = process.env.CLAUDE_WEB_PASSWORD;
  if (a['password-file']) { const file = fs.realpathSync(a['password-file']); secretPaths.push(file); password = fs.readFileSync(file,'utf8').replace(/\r?\n$/, ''); }
  if (!password) {
    const file = path.join(dataDir, 'credentials.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({password:crypto.randomBytes(24).toString('hex')}), {mode:0o600, flag:'wx'});
    password = JSON.parse(fs.readFileSync(file)).password;
    console.log('Web password saved in ' + file);
  }
  const username = a.username || process.env.CLAUDE_WEB_USERNAME || 'admin';
  if (!password || /[\r\n]/.test(password) || password === 'replace-with-a-long-random-password' || /[:\r\n]/.test(username)) throw new Error('Set valid web credentials.');
  const port = Number(a.port || process.env.PORT || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535.');
  let tls;
  if (!!a['tls-cert'] !== !!a['tls-key']) throw new Error('Provide both --tls-cert and --tls-key.');
  if (a['tls-cert']) {
    const cert = fs.realpathSync(a['tls-cert']), key = fs.realpathSync(a['tls-key']); secretPaths.push(cert, key);
    tls = {cert:fs.readFileSync(cert), key:fs.readFileSync(key), minVersion:'TLSv1.2'};
    require('tls').createSecureContext(tls);
  }
  return {claude, workspace, dataDir, secretPaths, credentials:{username,password}, host:a.host || process.env.HOST || '127.0.0.1', port, tls, defaultAccessMode:process.env.CLAUDE_WEB_ACCESS_MODE || 'workspace'};
};
