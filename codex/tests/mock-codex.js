#!/usr/bin/env node
'use strict';
const readline = require('readline');
const send = data => process.stdout.write(JSON.stringify(data) + '\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  const result = m.method === 'model/list' ? {data: [{model: 'test-deep', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{reasoningEffort: 'high'}]}], nextCursor: null} : m.method === 'account/read' ? {account: {}} : m.method.startsWith('thread/') ? {thread: {id: 'container-test-thread'}} : {};
  send({id: m.id, result});
  if (m.method === 'process/spawn') send({method: 'process/outputDelta', params: {processHandle: m.params.processHandle, deltaBase64: Buffer.from('Native terminal ready').toString('base64')}});
  if (m.method === 'process/kill') send({method: 'process/exited', params: {processHandle: m.params.processHandle, exitCode: 0}});
  if (m.method === 'turn/start') {
    send({method: 'item/completed', params: {threadId: 'container-test-thread', item: {id: 'user-1', type: 'userMessage', content: m.params.input}}});
    send({method: 'item/completed', params: {threadId: 'container-test-thread', item: {id: 'reply-1', type: 'agentMessage', text: JSON.stringify({input: m.params.input, model: m.params.model, effort: m.params.effort})}}});
    send({method: 'turn/completed', params: {threadId: 'container-test-thread', turn: {error: null}}});
  }
});
