'use strict';

// Terminal sessions started with the buddy's channel (bridge/channel.js)
// connect here. Each channel process belongs to one Claude Code session; we
// work out which one from its working folder and start time.

const path = require('path');

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
const SESSION_ENV = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID'];

function normDir(dir) {
  if (!dir) return '';
  const p = path.resolve(dir);
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

class Channels {
  constructor({ store, decisions }) {
    this.store = store;
    this.decisions = decisions;
    this.conns = new Map(); // id -> { id, cwd, pid, sessionId, registeredAt, res }
  }

  register({ id, cwd, pid, env }) {
    if (!id || typeof id !== 'string') return { ok: false };
    const prev = this.conns.get(id);
    const sessionId = SESSION_ENV.map((k) => env && env[k]).find(Boolean) || (prev && prev.sessionId) || null;
    this.conns.set(id, { id, cwd: normDir(cwd), pid, sessionId, registeredAt: prev ? prev.registeredAt : Date.now(), res: prev ? prev.res : null });
    this.store.dirty = true;
    return { ok: true };
  }

  events(id, res) {
    const c = this.conns.get(id);
    if (!c) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, SSE_HEADERS);
    res.write(': connected\n\n');
    c.res = res;
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    ping.unref();
    res.on('close', () => {
      clearInterval(ping);
      if (c.res === res) c.res = null;
      // The channel reconnects within seconds; forget it if it doesn't.
      setTimeout(() => {
        if (!c.res && this.conns.get(id) === c) {
          this.conns.delete(id);
          this.store.dirty = true;
        }
      }, 15000);
    });
    this.store.dirty = true;
  }

  // A terminal permission prompt relayed by the channel.
  permission({ id, request_id, tool_name, description, input_preview }) {
    const c = this.conns.get(id);
    if (!c || !/^[a-km-z]{5}$/.test(request_id || '')) return;
    const s = this.sessionFor(c);
    if (!s) return;
    this.decisions.fromRelay({ sessionId: s.id, channelId: c.id, requestId: request_id, toolName: tool_name || 'a tool', description, inputPreview: input_preview });
  }

  live() {
    return [...this.conns.values()].filter((c) => c.res);
  }

  // The session a channel belongs to: named in its environment, or the
  // terminal session in the same folder whose first activity came right after
  // the channel started (Claude Code starts channels at session start).
  sessionFor(c) {
    if (c.sessionId && this.store.sessions.has(c.sessionId)) return this.store.sessions.get(c.sessionId);
    const candidates = [...this.store.sessions.values()].filter((s) => this.store.sourceOf(s) === 'terminal' && normDir(this.store.projectDirOf(s)) === c.cwd);
    if (!candidates.length) return null;
    const after = candidates.filter((s) => (s.ts.firstEntryAt || s.lastHookAt) >= c.registeredAt - 5000);
    const pool = after.length ? after : candidates;
    return pool.sort((a, b) => (a.ts.firstEntryAt || a.lastHookAt) - (b.ts.firstEntryAt || b.lastHookAt))[0];
  }

  forSession(s) {
    return this.live().find((c) => {
      const owner = this.sessionFor(c);
      return owner && owner.id === s.id;
    });
  }

  send(c, event) {
    if (!c || !c.res) return false;
    c.res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  }

  sendMessage(s, text) {
    return this.send(this.forSession(s), { type: 'message', text });
  }

  sendVerdict(channelId, requestId, behavior) {
    return this.send(this.conns.get(channelId), { type: 'verdict', request_id: requestId, behavior });
  }

  closeAll() {
    for (const c of this.conns.values()) if (c.res) c.res.end();
  }
}

module.exports = { Channels, normDir };
