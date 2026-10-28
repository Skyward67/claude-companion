'use strict';

// Finds Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl
// plus <session>/subagents/*.jsonl), tails them, and folds their entries into
// per-session state: tokens, cost, todos, the last thing Claude said, and a
// best-guess status for when hooks aren't installed.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { tokensOf, costOf } = require('./pricing');
const { describeTool, PLAN_TOOLS } = require('./describe');

const MAX_READ_PER_POLL = 8 * 1024 * 1024;

class TranscriptWatcher extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.files = new Map(); // path -> { sessionId, isSub, offset, rest }
  }

  // Starts tracking every transcript modified since `sinceMs`.
  scan(sinceMs) {
    let projects;
    try {
      projects = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return;
    }
    for (const project of projects) {
      const dir = path.join(this.root, project.name);
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          if (this.files.has(full) || !modifiedSince(full, sinceMs)) continue;
          this.track(full, e.name.slice(0, -'.jsonl'.length), false);
        } else if (e.isDirectory()) {
          const subDir = path.join(full, 'subagents');
          let subs;
          try {
            subs = fs.readdirSync(subDir);
          } catch {
            continue;
          }
          for (const s of subs) {
            const subPath = path.join(subDir, s);
            if (!s.endsWith('.jsonl') || this.files.has(subPath) || !modifiedSince(subPath, sinceMs)) continue;
            this.track(subPath, e.name, true);
          }
        }
      }
    }
  }

  track(file, sessionId, isSub = false) {
    if (!file) return;
    if (file.startsWith('~')) file = path.join(require('os').homedir(), file.slice(1));
    // Hooks and directory scans may spell the same path differently; tailing
    // it twice would double-count tokens.
    file = path.resolve(file);
    if (this.files.has(file) || [...this.files.keys()].some((k) => samePath(k, file))) return;
    this.files.set(file, { sessionId: sessionId || path.basename(file, '.jsonl'), isSub, offset: 0, rest: null });
  }

  poll() {
    for (const [file, f] of this.files) {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        this.files.delete(file);
        continue;
      }
      if (size < f.offset) {
        // Rewritten from scratch; skip what we can't line up with.
        f.offset = size;
        f.rest = null;
        continue;
      }
      if (size === f.offset) continue;
      const len = Math.min(size - f.offset, MAX_READ_PER_POLL);
      const chunk = Buffer.alloc(len);
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, chunk, 0, len, f.offset);
      } catch {
        continue;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      f.offset += len;
      const buf = f.rest ? Buffer.concat([f.rest, chunk]) : chunk;
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) {
        f.rest = buf;
        continue;
      }
      f.rest = lastNl + 1 < buf.length ? buf.subarray(lastNl + 1) : null;
      const entries = [];
      for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
        if (!line) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // Partial or corrupt line; ignore.
        }
      }
      if (entries.length) this.emit('entries', f.sessionId, entries, { file, isSub: f.isSub });
    }
  }
}

function samePath(a, b) {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function modifiedSince(file, sinceMs) {
  try {
    return fs.statSync(file).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

function newTranscriptState() {
  return {
    msgUsage: new Map(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    model: null,
    contextUsed: 0,
    todos: [],
    taskSeq: 0,
    taskByToolUse: new Map(),
    pendingTools: new Map(),
    status: 'idle',
    statusAt: 0,
    activity: null,
    question: null,
    recap: null,
    lastText: '',
    lastPrompt: '',
    title: '',
    aiTitle: '',
    cwd: '',
    projectDir: '', // first cwd: where the session was started (the VS Code workspace, etc.)
    entrypoint: '', // cli | claude-vscode | claude-desktop | sdk-*
    reportedCost: null, // Claude Code's own estimate from `cost-state` lines
    error: null,
    firstEntryAt: 0,
    lastEntryAt: 0,
    chat: [], // conversation for the buddy's chat panel, newest last
    chatSeq: 0,
  };
}

const CHAT_MAX = 120;
const QUIET_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up', 'AskUserQuestion', 'ExitPlanMode', 'ToolSearch']);

function pushChat(ts, item) {
  ts.chat.push({ id: ++ts.chatSeq, ...item });
  if (ts.chat.length > CHAT_MAX) ts.chat.splice(0, ts.chat.length - CHAT_MAX);
}

// What the user actually typed: unwraps messages sent through the buddy's
// channel and drops IDE context and reminders that ride along with prompts.
function cleanPrompt(text) {
  const channel = /^\s*<channel\b[^>]*>([\s\S]*?)<\/channel>\s*$/.exec(text);
  if (channel) return { text: channel[1].trim(), via: 'buddy' };
  const stripped = text
    .replace(/<(ide_[a-z_]+|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();
  return { text: stripped || text.trim(), via: '' };
}

function chatToolUse(ts, b, when) {
  const input = b.input || {};
  if (b.name === 'AskUserQuestion') {
    const questions = (input.questions || []).map((q) => ({ question: String(q.question || ''), options: (q.options || []).map((o) => String(o.label || '')) }));
    pushChat(ts, { kind: 'question', questions, toolUseId: b.id, t: when });
  } else if (b.name === 'ExitPlanMode') {
    pushChat(ts, { kind: 'plan', text: String(input.plan || '').slice(0, 4000), t: when });
  } else if (b.name === 'mcp__ccd_turn__wrap_up' && input.ask) {
    const options = Array.isArray(input.actions) ? input.actions.map((a) => String(a.label || a.message || '')).filter(Boolean) : [];
    pushChat(ts, { kind: 'ask', text: String(input.ask), options, t: when });
  } else if (/__reply$/.test(b.name) && typeof input.text === 'string') {
    pushChat(ts, { kind: 'assistant', text: input.text.slice(0, 4000), t: when });
  } else if (!QUIET_TOOLS.has(b.name)) {
    const label = describeTool(b.name, input).label;
    const last = ts.chat[ts.chat.length - 1];
    if (last && last.kind === 'tools') {
      last.items = [...last.items, label].slice(-4);
      last.count++;
      last.t = when;
    } else {
      pushChat(ts, { kind: 'tools', items: [label], count: 1, t: when });
    }
  }
}

// Where a session runs, from the transcript's `entrypoint`.
function sourceOf(entrypoint) {
  const e = String(entrypoint || '');
  if (/vscode|cursor|windsurf|ide/i.test(e)) return 'vscode';
  if (/desktop/i.test(e)) return 'desktop';
  if (/sdk/i.test(e)) return 'sdk';
  if (e) return 'terminal';
  return '';
}

// State for one subagent, folded from its own transcript
// (<session>/subagents/agent-<id>.jsonl).
function newHelperState(id) {
  return { id, label: '', type: '', activity: null, status: 'working', lastAt: 0 };
}

function reduceHelperEntry(h, entry) {
  const t = Date.parse(entry.timestamp) || 0;
  if (t) h.lastAt = Math.max(h.lastAt, t);
  if (entry.agentType && !h.type) h.type = entry.agentType;
  const msg = entry.message;
  if (!msg) return;
  if (entry.type === 'user' && !h.label) {
    const text = textOfUserContent(msg.content);
    if (text) h.label = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  } else if (entry.type === 'assistant' && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b && b.type === 'tool_use') {
        h.activity = describeTool(b.name, b.input);
        h.status = 'working';
      } else if (b && (b.type === 'thinking' || b.type === 'text')) {
        h.status = 'thinking';
      }
    }
    if (msg.stop_reason === 'end_turn') h.status = 'done';
  }
}

function textOfUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function isSyntheticPrompt(entry, text) {
  if (entry.isMeta || entry.isCompactSummary) return true;
  return /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|task-notification)/.test(text);
}

// Applies a todo/plan tool call to the session's task list.
function applyPlanTool(ts, name, input, toolUseId) {
  input = input || {};
  switch (name) {
    case 'TodoWrite':
      if (Array.isArray(input.todos)) {
        ts.todos = input.todos.map((t, i) => ({
          id: String(t.id ?? i + 1),
          content: t.content || t.subject || '',
          activeForm: t.activeForm || '',
          status: t.status || 'pending',
        }));
      }
      break;
    case 'TaskCreate': {
      const id = String(++ts.taskSeq);
      ts.todos.push({ id, content: input.subject || input.content || '', activeForm: input.activeForm || '', status: 'pending' });
      if (toolUseId) ts.taskByToolUse.set(toolUseId, id);
      break;
    }
    case 'TaskUpdate': {
      const i = ts.todos.findIndex((t) => t.id === String(input.taskId));
      if (i === -1) break;
      if (input.status === 'deleted') {
        ts.todos.splice(i, 1);
        break;
      }
      const t = ts.todos[i];
      if (input.status) t.status = input.status;
      if (input.subject) t.content = input.subject;
      if (input.activeForm) t.activeForm = input.activeForm;
      break;
    }
    case 'mcp__ccd_turn__update_plan':
      if (Array.isArray(input.items)) {
        ts.todos = input.items.map((it, i) => ({
          id: String(i + 1),
          content: it.content || '',
          activeForm: '',
          status: it.status || 'pending',
        }));
      }
      if (input.advance) {
        const cur = ts.todos.find((t) => t.status === 'in_progress');
        if (cur) cur.status = 'completed';
        const next = ts.todos.find((t) => t.status === 'pending');
        if (next) next.status = 'in_progress';
      }
      if (Array.isArray(input.done)) {
        for (const n of input.done) if (ts.todos[n - 1]) ts.todos[n - 1].status = 'completed';
      }
      if (input.start && ts.todos[input.start - 1]) ts.todos[input.start - 1].status = 'in_progress';
      break;
    case 'mcp__ccd_turn__wrap_up':
      for (const t of ts.todos) t.status = 'completed';
      break;
  }
}

function setStatus(ts, status, t) {
  ts.status = status;
  ts.statusAt = t;
}

// Folds one transcript line into `ts`. Returns usage deltas (for the global
// today / 5h / budget windows) or null.
function reduceEntry(ts, entry, { isSub = false, now = Date.now() } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const t = Date.parse(entry.timestamp) || 0;
  const when = t || now;

  switch (entry.type) {
    case 'custom-title':
      if (entry.customTitle) ts.title = entry.customTitle;
      return null;
    case 'ai-title':
      if (entry.aiTitle && !isSub) ts.aiTitle = entry.aiTitle;
      return null;
    case 'summary':
      if (!ts.aiTitle && entry.summary && !isSub) ts.aiTitle = entry.summary;
      return null;
    case 'cost-state':
      if (typeof entry.totalCostUSD === 'number' && !isSub) ts.reportedCost = entry.totalCostUSD;
      return null;
    case 'system':
      if (entry.subtype === 'compact_boundary' && !isSub) setStatus(ts, 'thinking', when);
      return null;
  }

  if (entry.cwd && !isSub) {
    ts.cwd = entry.cwd;
    if (!ts.projectDir) ts.projectDir = entry.cwd;
  }
  if (entry.entrypoint && !isSub) ts.entrypoint = entry.entrypoint;
  const msg = entry.message;
  if (!msg) return null;
  const sidechain = isSub || entry.isSidechain;
  if (t && !sidechain) {
    ts.lastEntryAt = Math.max(ts.lastEntryAt, t);
    if (!ts.firstEntryAt || t < ts.firstEntryAt) ts.firstEntryAt = t;
  }

  if (entry.type === 'assistant') {
    const delta = accountUsage(ts, entry, msg, when);
    if (sidechain) return delta;

    if (msg.model && msg.model !== '<synthetic>') ts.model = msg.model;
    const u = msg.usage;
    if (u && msg.model !== '<synthetic>') {
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx > 0) ts.contextUsed = ctx;
    }

    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        setStatus(ts, 'thinking', when);
      } else if (b.type === 'text' && b.text && b.text.trim()) {
        if (msg.model === '<synthetic>' && /^API Error/i.test(b.text)) {
          ts.error = b.text;
          setStatus(ts, 'error', when);
          pushChat(ts, { kind: 'error', text: b.text.slice(0, 300), t: when });
        } else {
          ts.lastText = b.text;
          if (ts.status !== 'working') setStatus(ts, 'thinking', when);
          const last = ts.chat[ts.chat.length - 1];
          if (last && last.kind === 'assistant' && last.msgId && last.msgId === msg.id) last.text = `${last.text}\n\n${b.text}`.slice(0, 4000);
          else pushChat(ts, { kind: 'assistant', text: b.text.slice(0, 4000), msgId: msg.id || null, t: when });
        }
      } else if (b.type === 'tool_use') {
        chatToolUse(ts, b, when);
        ts.pendingTools.set(b.id, { name: b.name, input: b.input, t: when });
        if (PLAN_TOOLS.has(b.name) || b.name === 'mcp__ccd_turn__wrap_up') applyPlanTool(ts, b.name, b.input, b.id);
        ts.activity = describeTool(b.name, b.input);
        setStatus(ts, 'working', when);
        if (b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode') {
          ts.question = { kind: b.name === 'ExitPlanMode' ? 'plan' : 'question', text: ts.activity.label, toolUseId: b.id, t: when };
        } else if (b.name === 'mcp__ccd_turn__wrap_up') {
          const input = b.input || {};
          if (input.recap) ts.recap = input.recap;
          if (input.ask) ts.question = { kind: 'question', text: input.ask, t: when };
        }
      }
    }
    if (msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence') {
      ts.pendingTools.clear();
      setStatus(ts, 'done', when);
    }
    return delta;
  }

  if (entry.type === 'user' && !sidechain) {
    const content = msg.content;
    const results = Array.isArray(content) ? content.filter((b) => b && b.type === 'tool_result') : [];
    if (results.length) {
      for (const r of results) {
        const pending = ts.pendingTools.get(r.tool_use_id);
        ts.pendingTools.delete(r.tool_use_id);
        if (pending && pending.name === 'TaskCreate') {
          const text = typeof r.content === 'string' ? r.content : textOfUserContent(r.content);
          const m = /#(\d+)/.exec(text || '');
          const tempId = ts.taskByToolUse.get(r.tool_use_id);
          const task = ts.todos.find((x) => x.id === tempId);
          if (m && task) task.id = m[1];
        }
        if (ts.question && ts.question.toolUseId === r.tool_use_id) ts.question = null;
      }
      if (ts.pendingTools.size === 0) setStatus(ts, 'thinking', when);
      return null;
    }
    const text = textOfUserContent(content);
    if (!text || isSyntheticPrompt(entry, text)) return null;
    if (/^\[Request interrupted/.test(text)) {
      ts.pendingTools.clear();
      setStatus(ts, 'idle', when);
      pushChat(ts, { kind: 'system', text: 'Interrupted', t: when });
      return null;
    }
    const prompt = cleanPrompt(text);
    pushChat(ts, { kind: 'user', text: prompt.text.slice(0, 4000), via: prompt.via, t: when });
    ts.lastPrompt = prompt.text;
    ts.question = null;
    ts.recap = null;
    ts.error = null;
    ts.activity = null;
    ts.pendingTools.clear();
    setStatus(ts, 'thinking', when);
  }
  return null;
}

// Streaming writes one line per content block, each carrying the message's
// usage. Keep the max seen per message id so nothing is counted twice.
function accountUsage(ts, entry, msg, when) {
  if (!msg.usage || msg.model === '<synthetic>') return null;
  const key = msg.id || entry.requestId || entry.uuid;
  const cur = tokensOf(msg.usage);
  const now = {
    input: cur.input,
    output: cur.output,
    cacheRead: cur.cacheRead,
    cacheWrite: cur.cacheWrite5m + cur.cacheWrite1h,
    cost: costOf(msg.model, msg.usage),
  };
  const prev = ts.msgUsage.get(key);
  const merged = prev
    ? {
        input: Math.max(prev.input, now.input),
        output: Math.max(prev.output, now.output),
        cacheRead: Math.max(prev.cacheRead, now.cacheRead),
        cacheWrite: Math.max(prev.cacheWrite, now.cacheWrite),
        cost: Math.max(prev.cost, now.cost),
      }
    : now;
  ts.msgUsage.set(key, merged);
  const d = {
    input: merged.input - (prev ? prev.input : 0),
    output: merged.output - (prev ? prev.output : 0),
    cacheRead: merged.cacheRead - (prev ? prev.cacheRead : 0),
    cacheWrite: merged.cacheWrite - (prev ? prev.cacheWrite : 0),
    cost: merged.cost - (prev ? prev.cost : 0),
  };
  ts.tokens.input += d.input;
  ts.tokens.output += d.output;
  ts.tokens.cacheRead += d.cacheRead;
  ts.tokens.cacheWrite += d.cacheWrite;
  ts.cost += d.cost;
  const total = d.input + d.output + d.cacheRead + d.cacheWrite;
  if (total === 0 && d.cost === 0) return null;
  return { t: when, tokens: total, output: d.output, cost: d.cost };
}

module.exports = { TranscriptWatcher, newTranscriptState, reduceEntry, applyPlanTool, sourceOf, newHelperState, reduceHelperEntry };
