'use strict';
(() => {
  const el = id => document.getElementById(id);
  let term, fit, stream, session = {}, online = false, starting = false, inputQueue = Promise.resolve(), resizeTimer;
  function error(e) { el('terminal-error').textContent = e.message; el('terminal-error').hidden = false; }
  async function request(action, data = {}) {
    const response = await fetch('./api/terminal/' + action, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Codex-Web': '1'}, body: JSON.stringify(data)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Terminal request failed.');
    return result;
  }
  function controls() {
    const active = session.running;
    el('terminal-start').disabled = starting || !online || active || !!window.codexChatBusy;
    el('terminal-end').disabled = !online || !active;
    el('terminal-state').textContent = !online ? 'Connecting…' : starting ? 'Starting…' : active ? 'Running' : session.error || (session.id ? 'Exited' + (session.exitCode === null ? '' : ' (' + session.exitCode + ')') : 'Not started');
    if (term) term.options.disableStdin = !active || !online;
  }
  function input(bytes) {
    if (!session.running || !online) return;
    const id = session.id;
    for (let i = 0; i < bytes.length; i += 16384) {
      const data = btoa(String.fromCharCode(...bytes.subarray(i, i + 16384)));
      inputQueue = inputQueue.then(() => {
        if (session.id === id && session.running && online) return request('input', {id, data});
      }).catch(error);
    }
  }
  function resize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!term || el('terminal-panel').hidden) return;
      fit.fit();
      if (online && session.running) request('resize', {id: session.id, cols: Math.max(20, Math.min(500, term.cols)), rows: Math.max(5, Math.min(200, term.rows))}).catch(error);
    }, 100);
  }
  function initialize() {
    term = new Terminal({cursorBlink: true, fontSize: 14, fontFamily: 'monospace', scrollback: 3000, theme: {background: '#121614', foreground: '#eaf0eb'}, allowProposedApi: false});
    fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(el('terminal-screen')); fit.fit();
    term.onData(data => input(new TextEncoder().encode(data)));
    term.onBinary(data => input(Uint8Array.from(data, char => char.charCodeAt(0))));
    stream = new EventSource('./api/terminal/events');
    stream.onopen = () => { online = true; controls(); };
    stream.onerror = () => { online = false; controls(); };
    stream.addEventListener('reset', event => {
      const data = JSON.parse(event.data); session = data; term.reset();
      if (data.output) term.write(Uint8Array.from(atob(data.output), char => char.charCodeAt(0)));
      controls(); resize();
    });
    stream.addEventListener('output', event => {
      const data = JSON.parse(event.data);
      if (data.id === session.id) term.write(Uint8Array.from(atob(data.data), char => char.charCodeAt(0)));
    });
    stream.addEventListener('status', event => { session = JSON.parse(event.data); controls(); });
    new ResizeObserver(resize).observe(el('terminal-screen'));
  }
  window.openCodexTerminal = () => {
    document.querySelector('main').classList.add('terminal-view'); el('terminal-panel').hidden = false;
    el('chat-tab').setAttribute('aria-pressed', 'false'); el('terminal-tab').setAttribute('aria-pressed', 'true');
    if (!term) initialize();
    resize(); term.focus();
  };
  window.updateTerminalControls = controls;
  el('terminal-tab').onclick = window.openCodexTerminal;
  el('chat-tab').onclick = () => {
    document.querySelector('main').classList.remove('terminal-view'); el('terminal-panel').hidden = true;
    el('chat-tab').setAttribute('aria-pressed', 'true'); el('terminal-tab').setAttribute('aria-pressed', 'false');
  };
  el('terminal-start').onclick = async () => {
    if (el('terminal-start').disabled) return;
    starting = true; controls(); el('terminal-error').hidden = true; fit.fit();
    try {
      const result = await request('start', {cols: Math.max(20, Math.min(500, term.cols)), rows: Math.max(5, Math.min(200, term.rows))});
      if (!session.id || session.id === result.id) session = {...session, ...result};
      term.focus();
    } catch(e) { error(e); }
    finally { starting = false; controls(); }
  };
  el('terminal-end').onclick = async () => {
    if (!session.running || !window.confirm('End this Codex terminal session? Any running task will be stopped.')) return;
    try { await request('stop', {id: session.id}); } catch(e) { error(e); }
  };
  document.querySelectorAll('[data-terminal-key]').forEach(button => button.onclick = () => {
    input(new TextEncoder().encode(button.dataset.terminalKey === 'escape' ? '\x1b' : button.dataset.terminalKey === 'up' ? '\x1b[A' : button.dataset.terminalKey === 'down' ? '\x1b[B' : button.dataset.terminalKey === 'enter' ? '\r' : '/')); term?.focus();
  });
})();
