'use strict';
const $ = id => document.getElementById(id);
let lastItems = '', lastApprovals = '', connected = false;
let attachments = [], submitting = false, currentState;
const commands = {terminal: 'Open the complete native Codex command menu', model: 'Choose a model and reasoning effort', help: 'Show available commands', status: 'Show session status', stop: 'Stop the current task', new: 'Start a new conversation'};
let modelCatalog = [], modelsLoading = false, modelApplying = false, accessApplying = false;
function commandName(text) { return /^\/([a-z]+)(?:\s|$)/i.exec(text)?.[1].toLowerCase(); }
function showCommandOutput(text) { $('command-output').textContent = text; $('command-output').hidden = false; }
function commandMenu() {
  const text = $('prompt').value.trim();
  $('command-menu').replaceChildren();
  const matches = /^\/[a-z]*$/i.test(text) ? Object.keys(commands).filter(name => ('/' + name).startsWith(text.toLowerCase())) : [];
  $('command-menu').hidden = !matches.length;
  for (const name of matches) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
    button.textContent = '/' + name + ' — ' + commands[name];
    button.onclick = () => { $('prompt').value = '/' + name; $('command-menu').hidden = true; composerState(); $('composer').requestSubmit(); };
    $('command-menu').append(button);
  }
}
function modelDetails() {
  const model = modelCatalog.find(model => model.model === $('model-select').value);
  $('effort-select').replaceChildren();
  const efforts = model?.supportedReasoningEfforts || [];
  if (!efforts.length) $('effort-select').add(new Option('Model default', ''));
  for (const option of efforts) $('effort-select').add(new Option(option.reasoningEffort, option.reasoningEffort));
  const effort = model?.model === currentState?.selectedModel ? currentState.selectedEffort : model?.defaultReasoningEffort;
  if (efforts.some(option => option.reasoningEffort === effort)) $('effort-select').value = effort;
  $('model-description').textContent = model?.description || '';
}
async function openModelPicker() {
  $('model-panel').hidden = false; $('model-error').textContent = ''; modelsLoading = true; composerState();
  try {
    const response = await fetch('./api/models');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load models.');
    modelCatalog = result.models;
    $('model-select').replaceChildren();
    for (const model of modelCatalog) $('model-select').add(new Option(model.displayName || model.model, model.model));
    if (!modelCatalog.length) throw new Error('Codex returned no available models.');
    $('model-select').value = modelCatalog.some(model => model.model === currentState?.selectedModel) ? currentState.selectedModel : (modelCatalog.find(model => model.isDefault) || modelCatalog[0]).model;
    modelDetails(); $('model-select').focus();
  } catch(e) { modelCatalog = []; $('model-select').replaceChildren(); $('effort-select').replaceChildren(); $('model-error').textContent = e.message; }
  finally { modelsLoading = false; composerState(); }
}
async function runCommand(text) {
  const name = commandName(text);
  if (!name) return false;
  if (!Object.prototype.hasOwnProperty.call(commands, name)) throw new Error('Unknown command /' + name + '. Type /help to see available commands.');
  if (text.toLowerCase() !== '/' + name) throw new Error('Use /' + name + ' without arguments.');
  $('command-menu').hidden = true;
  if (name === 'terminal') window.openCodexTerminal();
  if (name === 'model') await openModelPicker();
  if (name === 'help') showCommandOutput(Object.entries(commands).map(([command, description]) => '/' + command + ' — ' + description).join('\n'));
  if (name === 'status') showCommandOutput('Status: ' + (currentState?.busy ? 'Working' : 'Ready') + '\nModel: ' + (currentState?.selectedModel || 'Codex default') + (currentState?.selectedEffort ? ' · ' + currentState.selectedEffort : '') + '\nConversation: ' + (currentState?.threadId || 'Not started'));
  if (name === 'stop') { await post('stop'); showCommandOutput('Stop requested.'); }
  if (name === 'new') { await post('new'); location.reload(); }
  return true;
}
function composerState() {
  const changingAccess = accessApplying || !!currentState?.accessChanging;
  const localCommand = ['terminal','model','help','status','stop'].includes(commandName($('prompt').value.trim()));
  $('send').disabled = submitting || changingAccess || !connected || !currentState?.ready || ((currentState.busy || currentState.terminalActive) && !localCommand);
  $('model-open').disabled = !connected || !currentState?.ready || modelsLoading || modelApplying;
  $('model-apply').disabled = changingAccess || !connected || !currentState?.ready || currentState.busy || currentState.terminalActive || modelsLoading || modelApplying || !modelCatalog.length;
  $('model-select').disabled = modelsLoading || modelApplying; $('effort-select').disabled = modelsLoading || modelApplying;
  $('model-apply').textContent = modelApplying ? 'Applying…' : 'Apply';
  $('model-open').textContent = 'Model: ' + (currentState?.selectedModel || 'Codex default') + (currentState?.selectedEffort ? ' · ' + currentState.selectedEffort : '');
  $('attach').disabled = submitting; $('file-input').disabled = submitting; $('prompt').readOnly = submitting;
  $('new').disabled = submitting || changingAccess || !!currentState?.busy || !!currentState?.terminalActive;
  const fullAccess = currentState?.accessMode === 'full-access';
  $('access-toggle').disabled = submitting || changingAccess || !connected || !currentState?.ready || !!currentState?.busy || !!currentState?.terminalActive;
  $('access-toggle').setAttribute('aria-checked', String(fullAccess));
  $('access-toggle').textContent = accessApplying ? 'Changing access…' : 'Full Access: ' + (fullAccess ? 'On' : 'Off');
  $('access-hint').textContent = currentState?.terminalActive ? 'End the terminal session to change access.' : currentState?.busy ? 'Finish or stop the current task to change access.' : fullAccess ? 'No approval prompts. Mounted host files are writable.' : 'Workspace restrictions and approval prompts.';
  window.codexChatBusy = !!currentState?.busy || changingAccess;
  window.updateTerminalControls?.();
  $('send').textContent = submitting ? 'Sending…' : 'Send ↑';
  document.querySelectorAll('#attachments button').forEach(button => button.disabled = submitting);
}
function renderAttachments() {
  $('attachments').replaceChildren(); $('attachments').hidden = !attachments.length;
  for (const attachment of attachments) {
    const card = document.createElement('div'); card.className = 'attachment';
    if (attachment.preview) { const img = document.createElement('img'); img.src = attachment.preview; img.alt = attachment.file.name; card.append(img); }
    const label = document.createElement('span'); label.textContent = attachment.file.name + ' (' + Math.max(1, Math.ceil(attachment.file.size / 1024)) + ' KB)'; card.append(label);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove ' + attachment.file.name);
    remove.onclick = () => { if (submitting) return; if (attachment.preview) URL.revokeObjectURL(attachment.preview); attachments = attachments.filter(a => a !== attachment); renderAttachments(); };
    card.append(remove); $('attachments').append(card);
  }
  composerState();
}
function addFiles(files) {
  if (submitting) return;
  const next = [...attachments.map(a => a.file), ...files];
  if (next.length > 10 || next.some(f => f.size > 10 * 1024 * 1024) || next.reduce((n, f) => n + f.size, 0) > 20 * 1024 * 1024) {
    report(new Error('Attach up to 10 files, 10 MB per file and 20 MB total.')); return;
  }
  for (const file of files) attachments.push({file, preview: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : null});
  renderAttachments();
}
function readAttachment(attachment) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({name: attachment.file.name, data: reader.result.split(',')[1]});
    reader.onerror = () => reject(new Error('Could not read ' + attachment.file.name));
    reader.readAsDataURL(attachment.file);
  });
}
async function post(action, data = {}) {
  const r = await fetch('./api/' + action, {method: 'POST', headers: {'Content-Type':'application/json','X-Codex-Web':'1'}, body: JSON.stringify(data)});
  const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
}
function report(e) { $('error').textContent = e.message; $('error').hidden = false; }
function render(s) {
  currentState = s;
  $('workspace-path').textContent = 'Working directory · ' + s.workspace;
  $('status').textContent = (!connected ? 'Reconnecting…' : !s.ready ? 'Starting…' : s.approvals.length ? 'Needs your input' : s.terminalActive ? 'Terminal active' : s.busy ? 'Working…' : 'Ready') + (s.accessMode === 'full-access' ? ' · Full Access' : '');
  composerState();
  $('stop').hidden = !s.busy;
  $('error').textContent = s.error; $('error').hidden = !s.error;
  const items = JSON.stringify(s.items);
  if (items !== lastItems && s.items.length) {
    const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 100;
    $('messages').replaceChildren();
    for (const item of s.items) {
      const el = document.createElement('article'); el.className = 'message ' + item.role;
      const label = document.createElement('div'); label.className = 'label'; label.textContent = item.role === 'user' ? 'You' : item.role === 'assistant' ? 'Codex' : 'Activity' + (item.status ? ' · ' + item.status : '');
      const content = document.createElement('div'); content.className = 'text'; content.textContent = item.text;
      el.append(label, content); $('messages').append(el);
    }
    if (nearBottom || !lastItems) $('messages').scrollTop = $('messages').scrollHeight;
  }
  lastItems = items;
  const approvals = JSON.stringify(s.approvals);
  if (approvals !== lastApprovals) {
    $('approvals').replaceChildren();
    for (const a of s.approvals) {
      const box = document.createElement('div'); box.className = 'approval';
      const title = document.createElement('strong'); title.textContent = a.method.endsWith('requestUserInput') ? 'Codex needs your input' : 'Permission requested'; box.append(title);
      if (a.method.endsWith('requestUserInput')) {
        const answers = {};
        for (const q of a.params.questions || []) {
          const label = document.createElement('label'); label.textContent = q.question;
          const input = document.createElement('input'); input.placeholder = (q.options || []).map(o => o.label).join(' / '); input.type = q.isSecret ? 'password' : 'text';
          input.oninput = () => { answers[q.id] = input.value; }; label.append(input); box.append(label);
        }
        const submit = document.createElement('button'); submit.textContent = 'Submit answer'; submit.onclick = () => post('answer',{id:a.id,answers}).catch(report); box.append(submit);
      } else {
        const details = document.createElement('pre');
        details.textContent = [a.params.reason, a.params.command, a.params.cwd && 'Directory: ' + a.params.cwd, a.params.permissions && JSON.stringify(a.params.permissions,null,2), a.params.networkApprovalContext && JSON.stringify(a.params.networkApprovalContext,null,2)].filter(Boolean).join('\n'); box.append(details);
        for (const accept of [true,false]) { const b = document.createElement('button'); b.textContent = accept ? 'Allow once' : 'Deny'; b.onclick = () => post('answer',{id:a.id,accept}).catch(report); box.append(b); }
      }
      $('approvals').append(box);
    }
    lastApprovals = approvals;
  }
}
const stream = new EventSource('./api/events');
stream.onopen = () => { connected = true; composerState(); };
stream.onmessage = e => render(JSON.parse(e.data));
stream.onerror = () => { connected = false; $('status').textContent = 'Reconnecting…'; composerState(); };
$('access-toggle').onclick = async () => {
  if ($('access-toggle').disabled) return;
  const accessMode = currentState.accessMode === 'full-access' ? 'workspace' : 'full-access';
  accessApplying = true; composerState();
  try {
    const result = await post('access-mode', {accessMode});
    render({...currentState, accessMode: result.accessMode, error: ''});
  } catch(e) { report(e); }
  finally { accessApplying = false; composerState(); }
};
$('composer').onsubmit = async e => {
  e.preventDefault(); const text = $('prompt').value.trim(); composerState();
  if ($('send').disabled || (!text && !attachments.length)) return;
  submitting = true; composerState();
  try {
    if (await runCommand(text)) { $('prompt').value = ''; return; }
    const files = await Promise.all(attachments.map(readAttachment));
    await post('message', {text, attachments: files});
    $('prompt').value = '';
    for (const attachment of attachments) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    attachments = []; renderAttachments();
  } catch(e) { report(e); }
  finally { submitting = false; composerState(); }
};
$('attach').onclick = () => $('file-input').click();
$('file-input').onchange = e => { addFiles(Array.from(e.target.files)); e.target.value = ''; };
$('prompt').onpaste = e => {
  const files = Array.from(e.clipboardData?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  if (files.length) {
    e.preventDefault(); addFiles(files);
    const text = e.clipboardData.getData('text/plain');
    if (text && !submitting) $('prompt').setRangeText(text, $('prompt').selectionStart, $('prompt').selectionEnd, 'end');
  }
};
$('prompt').oninput = () => { commandMenu(); composerState(); };
$('prompt').onkeydown = e => {
  if (e.key === 'Escape') { $('command-menu').hidden = true; $('model-panel').hidden = true; }
  if (e.key === 'ArrowDown' && !$('command-menu').hidden) { e.preventDefault(); $('command-menu').querySelector('button')?.focus(); }
  if(e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); composerState(); if (!$('send').disabled) $('composer').requestSubmit(); }
};
$('model-open').onclick = () => openModelPicker();
$('model-close').onclick = () => { $('model-panel').hidden = true; $('prompt').focus(); };
$('model-select').onchange = modelDetails;
$('model-apply').onclick = async () => {
  if ($('model-apply').disabled) return;
  modelApplying = true; composerState(); $('model-error').textContent = '';
  try {
    const result = await post('model', {model: $('model-select').value, effort: $('effort-select').value || null});
    currentState = {...currentState, ...result}; $('model-panel').hidden = true;
    showCommandOutput('Selected ' + result.selectedModel + (result.selectedEffort ? ' · ' + result.selectedEffort : '') + '. Applies to the next message.');
    $('prompt').focus();
  } catch(e) { $('model-error').textContent = e.message; }
  finally { modelApplying = false; composerState(); }
};
$('stop').onclick = () => post('stop').catch(report);
$('new').onclick = async () => { try { await post('new'); location.reload(); } catch(e) { report(e); } };
document.querySelectorAll('.suggestion').forEach(b => b.onclick = () => { $('prompt').value = b.textContent; $('prompt').focus(); });
