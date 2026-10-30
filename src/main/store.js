'use strict';

// Merges hook events, transcript entries and status-line data into one
// picture of what Claude is doing, and decides what the buddy should say.

const path = require('path');
const { EventEmitter } = require('events');
const { newTranscriptState, reduceEntry, sourceOf, newHelperState, reduceHelperEntry } = require('./transcripts');
const { describeTool, permissionLine, firstSentence, pick, errorLine, trunc, base } = require('./describe');
const { contextLimitFor, prettyModel } = require('./pricing');

const QUESTION_MS = 2 * 60 * 60 * 1000;
const HOOK_FRESH_MS = 10 * 60 * 1000;
const DONE_MS = 60 * 1000;
const ERROR_MS = 30 * 1000;
const STALE_WORK_MS = 20 * 60 * 1000;
const LIMITS_FRESH_MS = 6 * 60 * 60 * 1000;
const HELPER_STALE_MS = 10 * 60 * 1000;
const HELPER_DONE_SHOW_MS = 4000;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

// Hooks say "agent-abc123" in some places and "abc123" in others; transcript
// files are named agent-abc123.jsonl.
function helperId(id) {
  return String(id || '').replace(/^agent-/, '');
}

class Store extends EventEmitter {
  constructor({ settings, now = () => Date.now() }) {
    super();
    this.settings = settings;
    this.now = now;
    this.startedAt = now();
    this.sessions = new Map();
    this.usageEvents = [];
    this.limits = null;
    this.followId = null;
    this.bubbleSeq = 0;
    this.hooksSeenAt = 0;
    this.dirty = true;
    this.isOwned = () => false; // set by main: chats the buddy runs itself
  }

  session(id, { transcriptPath, cwd } = {}) {
    if (!id) return null;
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        transcriptPath: transcriptPath || '',
        cwd: cwd || '',
        ts: newTranscriptState(),
        status: 'idle',
        statusAt: 0,
        activity: null,
        waiting: null,
        helpers: new Map(), // subagents: id -> { id, label, type, activity, status, lastAt }
        bubble: null,
        lastHookAt: 0,
        ended: false,
        statusline: null,
      };
      this.sessions.set(id, s);
    }
    if (transcriptPath && !s.transcriptPath) s.transcriptPath = transcriptPath;
    if (cwd) s.cwd = cwd;
    return s;
  }

  lastActivity(s) {
    return Math.max(s.ts.lastEntryAt, s.lastHookAt);
  }

  hookedRecently(s) {
    return this.now() - s.lastHookAt < HOOK_FRESH_MS;
  }

  setStatus(s, status, t) {
    if (t < s.statusAt) return false;
    s.status = status;
    s.statusAt = t;
    if (status !== 'waiting') s.waiting = null;
    this.dirty = true;
    return true;
  }

  say(s, text, kind = 'info', { ttl = 6000, sticky = false } = {}) {
    if (!text) return;
    s.bubble = { id: ++this.bubbleSeq, text: trunc(text, 160), kind, ttl, sticky, at: this.now() };
    this.dirty = true;
  }

  // ---- transcripts -------------------------------------------------------

  onTranscriptEntries(sessionId, entries, { isSub = false, file = '' } = {}) {
    const s = this.session(sessionId);
    const ts = s.ts;
    const liveAfter = this.startedAt - 5000;
    let helper = null;
    if (isSub) {
      const id = helperId(path.basename(file, '.jsonl'));
      helper = s.helpers.get(id) || newHelperState(id);
      s.helpers.set(id, helper);
    }
    for (const entry of entries) {
      if (helper) {
        reduceHelperEntry(helper, entry);
        this.dirty = true;
      }
      const before = {
        status: ts.status,
        statusAt: ts.statusAt,
        todos: todoSig(ts.todos),
        todoStates: new Map(ts.todos.map((t) => [t.id, t.status])),
        question: ts.question,
        tools: ts.pendingTools.size,
      };
      const delta = reduceEntry(ts, entry, { isSub, now: this.now() });
      if (delta) this.addUsage(delta);
      if (ts.cwd && !s.cwd) s.cwd = ts.cwd;
      if (isSub) continue;

      const t = Date.parse(entry.timestamp) || 0;
      const live = t > liveAfter;
      const hooked = this.hookedRecently(s);

      if (todoSig(ts.todos) !== before.todos) {
        this.dirty = true;
        if (live) this.announceTodos(s, before.todoStates);
      }
      if (ts.question && ts.question !== before.question && live) {
        const kind = ts.question.kind;
        this.say(s, kind === 'plan' ? ts.question.text : `Quick question: ${ts.question.text}`, 'waiting', { sticky: true });
      }
      if (ts.statusAt !== before.statusAt && !hooked) {
        if (this.setStatus(s, ts.status, ts.statusAt)) {
          if (ts.status === 'working') s.activity = ts.activity;
          if (live) this.announceTranscriptStatus(s, before.status);
        }
      }
    }
  }

  announceTodos(s, beforeStates) {
    const started = s.ts.todos.find((t) => t.status === 'in_progress' && beforeStates.get(t.id) !== 'in_progress');
    const finished = s.ts.todos.filter((t) => t.status === 'completed' && beforeStates.has(t.id) && beforeStates.get(t.id) !== 'completed');
    if (started) this.say(s, `Next up: ${started.activeForm || started.content}`, 'task', { ttl: 5000 });
    else if (finished.length) this.say(s, `✓ ${finished[finished.length - 1].content}`, 'task', { ttl: 4000 });
  }

  announceTranscriptStatus(s, prev) {
    const ts = s.ts;
    switch (ts.status) {
      case 'thinking':
        if (prev === 'idle' || prev === 'done' || prev === 'sleeping') this.say(s, pick('prompt'));
        break;
      case 'working':
        if (ts.activity && !(s.bubble && s.bubble.kind === 'waiting' && s.bubble.sticky)) this.say(s, ts.activity.label, 'tool', { ttl: 4000 });
        break;
      case 'done':
        if (!ts.question) this.say(s, ts.recap || firstSentence(ts.lastText) || pick('done'), 'done', { ttl: 12000 });
        break;
      case 'error':
        this.say(s, errorLine(ts.error), 'error', { ttl: 10000 });
        break;
    }
  }

  addUsage(delta) {
    this.usageEvents.push(delta);
    this.dirty = true;
  }

  // ---- hooks -------------------------------------------------------------

  onHook(ev) {
    const s = this.session(ev.session_id, { transcriptPath: ev.transcript_path, cwd: ev.cwd });
    if (!s) return;
    const t = this.now();
    s.lastHookAt = t;
    this.hooksSeenAt = t;
    this.dirty = true;

    // Tool events from inside a subagent describe that helper, not the main
    // agent, which is still waiting on its Agent/Task call.
    if (ev.agent_id && TOOL_EVENTS.has(ev.hook_event_name)) {
      const h = this.helper(s, ev.agent_id, ev.agent_type, t);
      if (ev.hook_event_name === 'PreToolUse') {
        h.activity = describeTool(ev.tool_name, ev.tool_input);
        h.status = 'working';
      } else {
        h.status = 'thinking';
      }
      return;
    }

    switch (ev.hook_event_name) {
      case 'SessionStart':
        s.ended = false;
        this.setStatus(s, 'idle', t);
        if (ev.source !== 'compact') this.say(s, pick('hello'));
        break;
      case 'UserPromptSubmit':
        s.ts.question = null;
        s.ts.recap = null;
        s.activity = null;
        this.setStatus(s, 'thinking', t);
        this.say(s, pick('prompt'));
        break;
      case 'PreToolUse': {
        const d = describeTool(ev.tool_name, ev.tool_input);
        s.activity = d;
        if (d.kind === 'ask') {
          this.wait(s, ev.tool_name === 'ExitPlanMode' ? 'plan' : 'question', ev.tool_name === 'ExitPlanMode' ? d.label : `Quick question: ${d.label}`, t);
          break;
        }
        this.setStatus(s, 'working', t);
        if (d.kind !== 'plan') this.say(s, d.label, 'tool', { ttl: 4000 });
        break;
      }
      case 'PermissionRequest':
        this.wait(s, 'permission', `${ev.agent_id ? 'My helper asks: ' : ''}${permissionLine(ev.tool_name, ev.tool_input)}`, t);
        break;
      case 'Notification':
        this.onNotification(s, ev, t);
        break;
      case 'PostToolUse':
      case 'PermissionDenied':
        if (this.setStatus(s, 'thinking', t) && ev.hook_event_name === 'PermissionDenied') this.say(s, pick('denied'));
        break;
      case 'PostToolUseFailure':
        this.setStatus(s, 'thinking', t);
        if (!ev.is_interrupt) this.say(s, 'Hmm, that didn’t work. Adjusting…', 'oops', { ttl: 3500 });
        break;
      case 'Stop':
        for (const h of s.helpers.values()) h.status = 'done';
        this.setStatus(s, 'done', t);
        if (s.ts.question) this.say(s, `Quick question: ${s.ts.question.text}`, 'waiting', { sticky: true });
        else this.say(s, s.ts.recap || firstSentence(ev.last_assistant_message) || pick('done'), 'done', { ttl: 12000 });
        this.emit('done', s);
        break;
      case 'StopFailure':
        this.setStatus(s, 'error', t);
        this.say(s, errorLine(ev.error), 'error', { ttl: 10000 });
        break;
      case 'SubagentStart':
        this.helper(s, ev.agent_id, ev.agent_type, t).status = 'working';
        this.say(s, pick('helper'), 'tool', { ttl: 3000 });
        break;
      case 'SubagentStop': {
        const h = this.helper(s, ev.agent_id, ev.agent_type, t);
        h.status = 'done';
        this.say(s, `${pick('helperDone')}${ev.last_assistant_message ? ` ${firstSentence(ev.last_assistant_message, 100)}` : ''}`, 'tool', { ttl: 4000 });
        break;
      }
      case 'PreCompact':
        this.setStatus(s, 'compacting', t);
        this.say(s, pick('compact'), 'info', { ttl: 8000 });
        break;
      case 'PostCompact':
        this.setStatus(s, 'thinking', t);
        break;
      case 'TaskCompleted':
        if (ev.task_subject) this.say(s, `✓ ${ev.task_subject}`, 'task', { ttl: 4000 });
        break;
      case 'SessionEnd':
        s.ended = true;
        this.setStatus(s, 'idle', t);
        break;
    }
  }

  onNotification(s, ev, t) {
    const type = ev.notification_type || '';
    const message = ev.message || '';
    if (type === 'permission_prompt' || (!type && /permission/i.test(message))) {
      // PermissionRequest usually got here first with a better description.
      if (s.status !== 'waiting') this.wait(s, 'permission', message || 'I need your permission', t);
    } else if (type === 'elicitation_dialog' || type === 'elicitation_url_dialog' || type === 'agent_needs_input') {
      this.wait(s, 'input', message || 'I need some input from you', t);
    } else if (type === 'idle_prompt') {
      if (!s.ts.question && s.status !== 'waiting') this.say(s, pick('yourTurn'), 'info', { ttl: 8000 });
    }
  }

  helper(s, rawId, type, t) {
    const id = helperId(rawId) || `anon-${s.helpers.size}`;
    let h = s.helpers.get(id);
    if (!h) {
      h = newHelperState(id);
      s.helpers.set(id, h);
    }
    if (type && !h.type) h.type = type;
    h.lastAt = Math.max(h.lastAt, t);
    return h;
  }

  // Helpers worth showing: running ones, plus ones that just finished.
  activeHelpers(s) {
    const now = this.now();
    if (!['working', 'thinking', 'waiting', 'compacting'].includes(s.status)) return [];
    return [...s.helpers.values()]
      .filter((h) => (h.status === 'done' ? now - h.lastAt < HELPER_DONE_SHOW_MS : now - h.lastAt < HELPER_STALE_MS))
      .map((h) => ({ id: h.id, label: h.label, type: h.type, activity: h.activity, status: h.status }));
  }

  wait(s, kind, text, t) {
    this.setStatus(s, 'waiting', t);
    s.waiting = { kind, text, since: t };
    this.say(s, text, 'waiting', { sticky: true });
    this.emit('attention', s);
  }

  // ---- status line bridge -----------------------------------------------

  onStatusLine(data) {
    const t = this.now();
    const rl = data.rate_limits;
    if (rl) {
      const win = (w) => (w && typeof w.used_percentage === 'number' ? { pct: w.used_percentage, resetsAt: (w.resets_at || 0) * 1000 } : null);
      const spend = rl.spend_limit
        ? { ...win(rl.spend_limit), usedUsd: rl.spend_limit.used_usd, limitUsd: rl.spend_limit.limit_usd, period: rl.spend_limit.period }
        : null;
      this.limits = { fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day), spend, at: t };
    }
    const s = this.session(data.session_id, { transcriptPath: data.transcript_path, cwd: data.cwd || (data.workspace && data.workspace.current_dir) });
    if (s) {
      const cw = data.context_window || {};
      s.statusline = {
        contextSize: cw.context_window_size || null,
        contextPct: typeof cw.used_percentage === 'number' ? cw.used_percentage : null,
        cost: data.cost ? data.cost.total_cost_usd : null,
        name: data.session_name || '',
        at: t,
      };
    }
    this.dirty = true;
  }

  // ---- time --------------------------------------------------------------

  tick() {
    const now = this.now();
    for (const s of this.sessions.values()) {
      const idleFor = now - this.lastActivity(s);
      if (s.status === 'done' && now - s.statusAt > DONE_MS) this.setStatus(s, 'idle', now);
      else if (s.status === 'error' && now - s.statusAt > ERROR_MS) this.setStatus(s, 'idle', now);
      else if (['thinking', 'working', 'compacting'].includes(s.status) && idleFor > STALE_WORK_MS) this.setStatus(s, 'idle', now);
    }
    this.pruneUsage();
  }

  windowStart() {
    const now = new Date(this.now());
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    let start = Math.min(midnight, now.getTime() - 5 * 3600 * 1000);
    const b = this.budgetStart();
    if (b !== null) start = Math.min(start, b);
    return start;
  }

  budgetStart() {
    const budget = this.settings.get('budget');
    if (!budget || !budget.amount || budget.period === 'none') return null;
    const now = new Date(this.now());
    switch (budget.period) {
      case '5h':
        return now.getTime() - 5 * 3600 * 1000;
      case 'day':
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      case 'week':
        return now.getTime() - 7 * 24 * 3600 * 1000;
      case 'month':
        return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      default:
        return null;
    }
  }

  pruneUsage() {
    const start = this.windowStart();
    if (this.usageEvents.length && this.usageEvents[0].t < start) {
      this.usageEvents = this.usageEvents.filter((e) => e.t >= start);
    }
  }

  sumUsage(since) {
    const r = { tokens: 0, output: 0, cost: 0 };
    for (const e of this.usageEvents) {
      if (e.t < since) continue;
      r.tokens += e.tokens;
      r.output += e.output;
      r.cost += e.cost;
    }
    return r;
  }

  // ---- snapshot ----------------------------------------------------------

  decisionOf(s) {
    if (s.status === 'waiting' && s.waiting) return s.waiting;
    const q = s.ts.question;
    if (q && this.now() - (q.t || 0) < QUESTION_MS) return { kind: q.kind, text: q.text, since: q.t };
    return null;
  }

  effectiveStatus(s) {
    if (s.status === 'idle' && this.now() - this.lastActivity(s) > this.settings.get('sleepAfterMin') * 60000) return 'sleeping';
    return s.status;
  }

  display() {
    return this.settings.get('display') || {};
  }

  // Projects the user chose not to see (Settings → Sessions).
  isHidden(s) {
    const hidden = this.display().hiddenProjects || [];
    if (!hidden.length) return false;
    const name = this.projectOf(s).toLowerCase();
    return hidden.some((h) => h.toLowerCase() === name);
  }

  activeSessions() {
    const now = this.now();
    const activeMs = (this.display().activeMinutes || 45) * 60000;
    return [...this.sessions.values()]
      .filter((s) => !s.ended && !this.isHidden(s) && (now - this.lastActivity(s) < activeMs || (s.status === 'waiting' && s.waiting)))
      .sort((a, b) => this.lastActivity(b) - this.lastActivity(a));
  }

  focusSession(active) {
    if (this.followId && this.sessions.has(this.followId)) return this.sessions.get(this.followId);
    const waiting = active.filter((s) => s.status === 'waiting' && s.waiting);
    if (waiting.length) return waiting.sort((a, b) => b.waiting.since - a.waiting.since)[0];
    if (active.length) return active[0];
    let latest = null;
    for (const s of this.sessions.values()) if (!this.isHidden(s) && (!latest || this.lastActivity(s) > this.lastActivity(latest))) latest = s;
    return latest;
  }

  // The folder the session was started in (a VS Code workspace, say), even
  // after Claude has cd'd into a subfolder.
  projectDirOf(s) {
    return s.ts.projectDir || s.cwd || s.ts.cwd || '';
  }

  // Split on either separator: path.basename on macOS/Linux leaves a
  // Windows-style cwd (D:\Dev\app) whole.
  projectOf(s) {
    const dir = this.projectDirOf(s).replace(/[\\/]+$/, '');
    return (dir && base(dir)) || s.id.slice(0, 8);
  }

  sourceOf(s) {
    if (this.isOwned(s.id)) return 'buddy';
    return sourceOf(s.ts.entrypoint);
  }

  chatOf(id) {
    const s = this.sessions.get(id);
    return s ? s.ts.chat : [];
  }

  titleOf(s) {
    const sl = s.statusline;
    return (sl && sl.name) || s.ts.title || s.ts.aiTitle || '';
  }

  // Compact view of a session for the crew of mini buddies.
  sessionView(s, focus) {
    const ts = s.ts;
    const d = this.decisionOf(s);
    const current = ts.todos.find((t) => t.status === 'in_progress');
    return {
      id: s.id,
      project: this.projectOf(s),
      title: this.titleOf(s),
      source: this.sourceOf(s),
      status: this.effectiveStatus(s),
      activity: s.status === 'working' ? s.activity || ts.activity : null,
      waiting: !!d,
      decision: d ? { kind: d.kind, text: d.text } : null,
      todos: { done: ts.todos.filter((t) => t.status === 'completed').length, total: ts.todos.length, current: current ? current.activeForm || current.content : '' },
      helpers: this.activeHelpers(s).length,
      canJump: this.sourceOf(s) === 'vscode' && !!this.projectDirOf(s),
      focused: s === focus,
    };
  }

  snapshot() {
    const now = this.now();
    const active = this.activeSessions();
    const focus = this.focusSession(active);
    const midnight = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();

    let focusView = null;
    if (focus) {
      const ts = focus.ts;
      const sl = focus.statusline && now - focus.statusline.at < LIMITS_FRESH_MS ? focus.statusline : null;
      const limit = (sl && sl.contextSize) || contextLimitFor(ts.model);
      const pct = sl && sl.contextPct !== null ? sl.contextPct : limit ? (ts.contextUsed / limit) * 100 : 0;
      focusView = {
        id: focus.id,
        project: this.projectOf(focus),
        title: this.titleOf(focus),
        source: this.sourceOf(focus),
        canJump: this.sourceOf(focus) === 'vscode' && !!this.projectDirOf(focus),
        status: this.effectiveStatus(focus),
        activity: focus.status === 'working' ? focus.activity : null,
        decision: this.decisionOf(focus),
        bubble: focus.bubble,
        model: prettyModel(ts.model),
        helpers: this.activeHelpers(focus),
        todos: ts.todos.map(({ content, activeForm, status }) => ({ content, activeForm, status })),
        tokens: { ...ts.tokens, total: ts.tokens.input + ts.tokens.output + ts.tokens.cacheRead + ts.tokens.cacheWrite },
        // Prefer Claude Code's own figure; our estimate only knows list prices.
        cost: sl && typeof sl.cost === 'number' ? sl.cost : Math.max(ts.reportedCost || 0, ts.cost),
        context: { used: ts.contextUsed, limit, pct: Math.max(0, Math.min(100, pct)) },
        hooked: this.hookedRecently(focus),
        lastActivity: this.lastActivity(focus),
      };
    }

    const attention = active
      .filter((s) => s !== focus)
      .map((s) => ({ s, d: this.decisionOf(s) }))
      .filter((x) => x.d)
      .map(({ s, d }) => ({ id: s.id, project: this.projectOf(s), kind: d.kind, text: d.text }));

    return {
      now,
      focus: focusView,
      following: this.followId,
      sessions: active.map((s) => this.sessionView(s, focus)),
      attention,
      usage: { today: this.sumUsage(midnight), last5h: this.sumUsage(now - 5 * 3600 * 1000) },
      credits: this.credits(now),
      hooks: { seen: now - this.hooksSeenAt < HOOK_FRESH_MS },
    };
  }

  credits(now) {
    const out = { plan: null, budget: null };
    const l = this.limits;
    if (l && now - l.at < LIMITS_FRESH_MS) {
      const ok = (w) => (w && (!w.resetsAt || w.resetsAt > now) ? w : null);
      const plan = { fiveHour: ok(l.fiveHour), sevenDay: ok(l.sevenDay), spend: ok(l.spend) };
      if (plan.fiveHour || plan.sevenDay || plan.spend) out.plan = plan;
    }
    const budget = this.settings.get('budget');
    const start = this.budgetStart();
    if (start !== null) {
      const spent = this.sumUsage(start).cost;
      out.budget = { period: budget.period, amount: budget.amount, spent, left: Math.max(0, budget.amount - spent), pct: Math.min(100, (spent / budget.amount) * 100) };
    }
    return out;
  }

  follow(id) {
    this.followId = id && this.sessions.has(id) ? id : null;
    this.dirty = true;
  }
}

function todoSig(todos) {
  return todos.map((t) => `${t.id}:${t.status}:${t.content}`).join('|');
}

module.exports = { Store };
