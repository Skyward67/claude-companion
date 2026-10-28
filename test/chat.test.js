'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');

const { Decisions } = require('../src/main/decisions');
const { Channels } = require('../src/main/channels');
const { Store } = require('../src/main/store');
const { newTranscriptState, reduceEntry } = require('../src/main/transcripts');
const claudeConfig = require('../src/main/claudeConfig');

// A stand-in for an HTTP response the server is holding open.
function fakeRes() {
  const res = new EventEmitter();
  res.status = null;
  res.body = null;
  res.writableEnded = false;
  res.writeHead = (status) => {
    res.status = status;
    return res;
  };
  res.end = (body) => {
    res.body = body ? JSON.parse(body) : null;
    res.writableEnded = true;
    return res;
  };
  return res;
}

const settings = { get: (k) => ({ sleepAfterMin: 10, budget: { period: 'none' }, display: {} })[k] };

test('decisions: a held permission prompt is answered with the hook’s JSON', () => {
  const d = new Decisions();
  const res = fakeRes();
  const ev = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }] };
  const dec = d.fromHook(ev, res, { holdMs: 60000 });
  const view = d.viewsFor('s')[0];
  assert.equal(view.kind, 'permission');
  assert.equal(view.preview, 'npm test');
  assert.equal(view.canAlways, true);
  assert.equal(res.writableEnded, false, 'held until the user decides');

  assert.ok(d.answer(dec.id, { behavior: 'allow', always: true }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hookSpecificOutput.decision.behavior, 'allow');
  assert.deepEqual(res.body.hookSpecificOutput.decision.updatedInput, { command: 'npm test' });
  assert.equal(res.body.hookSpecificOutput.decision.updatedPermissions.length, 1);
  assert.equal(d.forSession('s').length, 0);
  assert.equal(d.answer(dec.id, { behavior: 'deny' }), null, 'a second answer is ignored');
});

test('decisions: questions, plans, dedupe, release and timeout', async () => {
  const d = new Decisions();
  const q = { session_id: 's', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } };
  const r1 = fakeRes();
  const r2 = fakeRes();
  const dq = d.fromHook(q, r1, { holdMs: 60000 });
  assert.equal(d.fromHook(q, r2, { holdMs: 60000 }), dq, 'same prompt from two hooks shares one decision');
  d.answer(dq.id, { behavior: 'allow', answers: { 'Which?': 'B' } });
  for (const r of [r1, r2]) assert.deepEqual(r.body.hookSpecificOutput.decision.updatedInput.answers, { 'Which?': 'B' });

  const rp = fakeRes();
  const dp = d.fromHook({ session_id: 's', tool_name: 'ExitPlanMode', tool_input: { plan: '1. do it' } }, rp, { holdMs: 60000 });
  assert.equal(d.view(dp).kind, 'plan');
  d.answer(dp.id, { behavior: 'deny', message: 'Use smaller steps' });
  assert.deepEqual(rp.body.hookSpecificOutput.decision, { behavior: 'deny', message: 'Use smaller steps' });

  // Answered in Claude's own dialog: the hook is let go without an opinion.
  const rr = fakeRes();
  d.fromHook({ session_id: 's', tool_name: 'Edit', tool_input: { file_path: 'a.js' } }, rr, { holdMs: 60000 });
  d.releaseSession('s', 'Edit');
  assert.equal(rr.status, 204);

  const rt = fakeRes();
  d.fromHook({ session_id: 't', tool_name: 'Write', tool_input: {} }, rt, { holdMs: 20 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rt.status, 204, 'times out to "no opinion"');
  assert.equal(d.forSession('t').length, 0);
});

test('decisions: relayed terminal prompts return a channel verdict', () => {
  const d = new Decisions();
  const dec = d.fromRelay({ sessionId: 's', channelId: 'c1', requestId: 'abcde', toolName: 'Bash', description: 'List files', inputPreview: '{"command":"ls"}' });
  assert.equal(d.view(dec).detail, 'List files');
  assert.deepEqual(d.answer(dec.id, { behavior: 'allow' }), { relay: { channelId: 'c1', requestId: 'abcde', behavior: 'allow' } });
});

test('channels: a channel belongs to the terminal session started in its folder', () => {
  const store = new Store({ settings });
  const decisions = new Decisions();
  const channels = new Channels({ store, decisions });
  const now = Date.now();
  // An older terminal session and a newer one in the same folder.
  store.onTranscriptEntries('old', [{ type: 'user', timestamp: new Date(now - 3600e3).toISOString(), cwd: process.cwd(), entrypoint: 'cli', message: { content: 'old' } }]);
  channels.register({ id: 'ch', cwd: process.cwd(), pid: 1, env: {} });
  store.onTranscriptEntries('new', [{ type: 'user', timestamp: new Date(now + 1000).toISOString(), cwd: process.cwd(), entrypoint: 'cli', message: { content: 'hi' } }]);
  const res = fakeRes();
  res.write = (chunk) => (res.written = (res.written || '') + chunk);
  channels.events('ch', res);
  assert.equal(channels.forSession(store.sessions.get('new')).id, 'ch');
  assert.equal(channels.forSession(store.sessions.get('old')), undefined);

  assert.ok(channels.sendMessage(store.sessions.get('new'), 'run the tests'));
  assert.match(res.written, /data: \{"type":"message","text":"run the tests"\}/);

  channels.permission({ id: 'ch', request_id: 'qwert', tool_name: 'Bash', description: 'Run tests', input_preview: 'npm test' });
  assert.equal(decisions.forSession('new')[0].requestId, 'qwert');
  channels.permission({ id: 'ch', request_id: 'BAD!!', tool_name: 'Bash' });
  assert.equal(decisions.forSession('new').length, 1, 'malformed request ids are ignored');
});

test('channel bridge speaks MCP and relays both ways', async (t) => {
  // A fake buddy: records registration and permission prompts, streams events.
  const seen = { register: null, permission: null };
  let stream = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/channel/register') {
        seen.register = JSON.parse(body);
        res.writeHead(200).end('{"ok":true}');
      } else if (req.url.startsWith('/channel/events')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': connected\n\n');
        stream = res;
      } else if (req.url === '/channel/permission') {
        seen.permission = JSON.parse(body);
        res.writeHead(204).end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'channel.js'), '--port', String(port)], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => {
    child.kill();
    if (stream) stream.end();
    server.close();
  });
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
  const waitFor = async (pred, what) => {
    for (let i = 0; i < 100; i++) {
      const hit = typeof pred === 'function' ? pred() : null;
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const sendLine = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

  sendLine({ id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'claude-code' } } });
  const init = await waitFor(() => lines.find((l) => l.id === 1), 'initialize');
  assert.equal(init.result.protocolVersion, '2025-06-18', 'answers with a revision Claude Code registers channels for');
  assert.deepEqual(init.result.capabilities.experimental, { 'claude/channel': {}, 'claude/channel/permission': {} });

  sendLine({ method: 'notifications/initialized' });
  await waitFor(() => stream, 'event stream');
  assert.equal(seen.register.cwd, process.cwd());

  stream.write(`data: ${JSON.stringify({ type: 'message', text: 'hello from the buddy' })}\n\n`);
  const msg = await waitFor(() => lines.find((l) => l.method === 'notifications/claude/channel'), 'channel message');
  assert.deepEqual(msg.params, { content: 'hello from the buddy', meta: { sender: 'buddy' } });

  sendLine({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'List files', input_preview: 'ls' } });
  await waitFor(() => seen.permission, 'permission relay');
  assert.equal(seen.permission.request_id, 'abcde');

  stream.write(`data: ${JSON.stringify({ type: 'verdict', request_id: 'abcde', behavior: 'allow' })}\n\n`);
  const verdict = await waitFor(() => lines.find((l) => l.method === 'notifications/claude/channel/permission'), 'verdict');
  assert.deepEqual(verdict.params, { request_id: 'abcde', behavior: 'allow' });
});

test('chat log: prompts, buddy messages, replies and grouped tool steps', () => {
  const ts = newTranscriptState();
  const at = (s) => new Date(Date.UTC(2026, 9, 28, 10, 0, s)).toISOString();
  reduceEntry(ts, { type: 'user', timestamp: at(0), message: { content: [{ type: 'text', text: '<ide_opened_file>The user opened a.js</ide_opened_file>' }, { type: 'text', text: 'Fix the bug' }] } });
  reduceEntry(ts, { type: 'user', timestamp: at(1), message: { content: '<channel source="claude-companion" sender="buddy">and add a test</channel>' } });
  reduceEntry(ts, { type: 'assistant', timestamp: at(2), message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'On it.' }] } });
  for (let i = 0; i < 6; i++) reduceEntry(ts, { type: 'assistant', timestamp: at(3 + i), message: { id: `t${i}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `u${i}`, name: 'Read', input: { file_path: `f${i}.js` } }] } });
  reduceEntry(ts, { type: 'assistant', timestamp: at(10), message: { id: 'q', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } }] } });

  const kinds = ts.chat.map((c) => c.kind);
  assert.deepEqual(kinds, ['user', 'user', 'assistant', 'tools', 'question']);
  assert.equal(ts.chat[0].text, 'Fix the bug', 'IDE context is stripped');
  assert.deepEqual([ts.chat[1].text, ts.chat[1].via], ['and add a test', 'buddy']);
  assert.equal(ts.chat[3].count, 6);
  assert.equal(ts.chat[3].items.length, 4, 'only the last few steps are kept');
  assert.deepEqual(ts.chat[4].questions, [{ question: 'Which?', options: ['A'] }]);
});

test('hook installer: PermissionRequest is synchronous and points at /decide', () => {
  const s = claudeConfig.withHooks({}, 47821, 'win32');
  const pr = s.hooks.PermissionRequest[0].hooks[0];
  assert.equal(pr.async, undefined);
  assert.match(pr.command, /\/decide\?src=claude-companion" ; exit 0$/);
  assert.ok(pr.timeout >= 600);
  const buddy = claudeConfig.buddyChatSettings(47821, { globalHooks: true });
  assert.deepEqual(Object.keys(buddy.hooks), ['PermissionRequest'], 'buddy chats only add the decision hook when global hooks exist');
  assert.equal(Object.keys(claudeConfig.buddyChatSettings(47821, { globalHooks: false }).hooks).length, claudeConfig.HOOK_EVENTS.length);
});
