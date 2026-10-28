'use strict';

// Conversations the buddy runs itself: a headless Claude Code process per
// chat (`claude -p --input-format stream-json`), fed messages on stdin. Like
// any session it writes a normal transcript, so the rest of the app follows it
// the usual way. Permission prompts reach the buddy through the decision hook
// passed with --settings (headless sessions deny anything nobody answers).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const KEEP = 20; // remembered chats, so they stay "yours" after a restart
// Claude Code reports a missing/expired login as an ordinary reply.
const AUTH_ERROR = /Failed to authenticate|run \/login|Invalid API key|OAuth (session|token).*(expired|revoked)/i;
const SIGN_IN = 'Claude Code isn’t signed in on this computer. Open a terminal, run `claude` and use /login (or sign in to the Claude Code extension in VS Code), then send again.';

class BuddyChats extends EventEmitter {
  constructor({ settings, findClaude, settingsFile }) {
    super();
    this.settings = settings;
    this.findClaude = findClaude;
    this.settingsFile = settingsFile;
    this.chats = new Map(); // id -> { id, cwd, proc, busy, error, stderr }
    for (const c of settings.get('buddyChats') || []) this.chats.set(c.id, { id: c.id, cwd: c.cwd, proc: null, busy: false, error: null, stderr: '' });
  }

  owns(id) {
    return this.chats.has(id);
  }

  save() {
    const list = [...this.chats.values()].slice(-KEEP).map(({ id, cwd }) => ({ id, cwd }));
    this.settings.set({ buddyChats: list });
  }

  start({ cwd, text }) {
    if (!cwd || !fs.existsSync(cwd)) throw new Error('Pick a folder for Claude to work in.');
    const id = crypto.randomUUID();
    this.chats.set(id, { id, cwd, proc: null, busy: false, error: null, stderr: '' });
    this.save();
    this.spawn(id, false);
    this.write(id, text);
    return id;
  }

  send(id, text) {
    const c = this.chats.get(id);
    if (!c) throw new Error('Not a buddy chat.');
    // Picks the conversation back up after a restart or a crash.
    if (!c.proc) this.spawn(id, true);
    this.write(id, text);
  }

  spawn(id, resume) {
    const c = this.chats.get(id);
    const exe = this.findClaude();
    if (!exe) throw new Error('Claude Code wasn’t found. Set its location in Settings → Connect.');
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', this.settingsFile(), resume ? '--resume' : '--session-id', id];
    c.error = null;
    c.stderr = '';
    c.stopping = false;
    const proc = spawn(exe, args, { cwd: c.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    c.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(c, line));
    proc.stderr.on('data', (d) => (c.stderr = (c.stderr + d).slice(-2000)));
    proc.on('error', (err) => {
      c.error = err.message;
      c.proc = null;
      c.busy = false;
      this.emit('change', c);
    });
    proc.on('exit', (code) => {
      if (c.proc === proc) c.proc = null;
      c.busy = false;
      if (code && !c.stopping) c.error = lastLine(c.stderr) || `Claude Code stopped (exit code ${code}).`;
      this.emit('change', c);
    });
    this.emit('change', c);
  }

  onLine(c, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'result') {
      c.busy = false;
      const text = String(msg.result || '');
      if (AUTH_ERROR.test(text)) c.error = SIGN_IN;
      else if (msg.is_error) c.error = (text || msg.subtype || 'Something went wrong.').slice(0, 300);
      this.emit('change', c);
    } else if (msg.type === 'system' && msg.subtype === 'init') {
      this.emit('started', c, msg);
    }
  }

  write(id, text) {
    const c = this.chats.get(id);
    if (!c || !c.proc) throw new Error('This chat isn’t running.');
    c.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
    c.busy = true;
    c.error = null;
    this.emit('change', c);
  }

  stop(id) {
    const c = this.chats.get(id);
    if (!c || !c.proc) return;
    c.stopping = true;
    c.proc.stdin.end();
    c.proc.kill();
  }

  forget(id) {
    this.stop(id);
    this.chats.delete(id);
    this.save();
  }

  stopAll() {
    for (const c of this.chats.values()) if (c.proc) this.stop(c.id);
  }

  view(id) {
    const c = this.chats.get(id);
    return c ? { running: !!c.proc, busy: c.busy, error: c.error } : null;
  }
}

function lastLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

// Where Claude Code lives. A setting wins; then PATH; then the native
// installer's folder; then the copy bundled with the VS Code extension.
function findClaudeExecutable(override) {
  if (override && fs.existsSync(override)) return override;
  const win = process.platform === 'win32';
  const name = win ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  for (const p of [path.join(os.homedir(), '.local', 'bin', name), path.join(os.homedir(), '.claude', 'local', name)]) {
    if (fs.existsSync(p)) return p;
  }
  const found = [];
  for (const root of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].map((d) => path.join(os.homedir(), d, 'extensions'))) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const m = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(e);
      const exe = path.join(root, e, 'resources', 'native-binary', name);
      if (m && fs.existsSync(exe)) found.push({ exe, v: [+m[1], +m[2], +m[3]] });
    }
  }
  found.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return found.length ? found[0].exe : null;
}

module.exports = { BuddyChats, findClaudeExecutable };
