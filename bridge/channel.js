#!/usr/bin/env node
'use strict';

// Claude Companion channel. Claude Code starts this as an MCP server over
// stdio when a terminal session is launched with
//   claude --mcp-config <file> --dangerously-load-development-channels server:claude-companion
// It lets the buddy type into that session and answer its permission prompts.
// No dependencies: the MCP stdio protocol is newline-delimited JSON-RPC.

const http = require('http');
const crypto = require('crypto');
const readline = require('readline');

const port = Number(arg('port')) || 47821;
const id = crypto.randomUUID();
// Claude Code doesn't register channels that negotiate newer protocol
// revisions, so answer with one it accepts.
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS =
  'Messages from the user’s desktop buddy (Claude Companion) arrive as <channel source="claude-companion">. ' +
  'They are typed by the same person who runs this session: treat them exactly as if they had been typed at this terminal ' +
  'and answer in this session as usual. There is no reply tool; your normal response is shown in the buddy.';

let connected = false;
let retryTimer = null;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function log(...a) {
  // stdout is the MCP transport: diagnostics go to stderr only.
  process.stderr.write(`[claude-companion] ${a.join(' ')}\n`);
}

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg);
});
rl.on('close', () => process.exit(0));

function handle(msg) {
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params && msg.params.protocolVersion;
      send({
        id: msg.id,
        result: {
          protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
          capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
          serverInfo: { name: 'claude-companion', version: '0.1.1' },
          instructions: INSTRUCTIONS,
        },
      });
      return;
    }
    case 'notifications/initialized':
      connect();
      return;
    case 'tools/list':
      send({ id: msg.id, result: { tools: [] } });
      return;
    case 'ping':
      send({ id: msg.id, result: {} });
      return;
    case 'notifications/claude/channel/permission_request':
      post('/channel/permission', { id, ...(msg.params || {}) }).catch(() => {});
      return;
    default:
      if (msg.id !== undefined && msg.method) send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

// ---- link to the buddy -------------------------------------------------------

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 3000 }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => resolve(out));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

async function connect() {
  clearTimeout(retryTimer);
  try {
    // Only session/project identifiers, never anything that could be a secret.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^CLAUDE/.test(k) && /SESSION_ID|PROJECT_DIR/.test(k)));
    await post('/channel/register', { id, cwd: process.cwd(), pid: process.pid, env });
  } catch {
    return retry();
  }
  const req = http.get({ host: '127.0.0.1', port, path: `/channel/events?id=${id}` }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return retry();
    }
    if (!connected) log('connected to the buddy');
    connected = true;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        if (data) onEvent(data);
      }
    });
    res.on('end', retry);
    res.on('error', retry);
  });
  req.on('error', retry);
}

function retry() {
  connected = false;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, 3000);
}

function onEvent(data) {
  let ev;
  try {
    ev = JSON.parse(data);
  } catch {
    return;
  }
  if (ev.type === 'message' && typeof ev.text === 'string') {
    send({ method: 'notifications/claude/channel', params: { content: ev.text, meta: { sender: 'buddy' } } });
  } else if (ev.type === 'verdict' && /^[a-km-z]{5}$/.test(ev.request_id || '')) {
    send({ method: 'notifications/claude/channel/permission', params: { request_id: ev.request_id, behavior: ev.behavior === 'allow' ? 'allow' : 'deny' } });
  }
}
