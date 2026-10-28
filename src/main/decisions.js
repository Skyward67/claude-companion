'use strict';

// Decisions the buddy can answer: permission prompts, AskUserQuestion,
// ExitPlanMode. Two ways in:
//  - hook: a synchronous PermissionRequest hook POSTs to /decide and we hold
//    its HTTP response until the user clicks (or Claude's own UI answers first);
//  - relay: a terminal session's channel forwards a permission prompt with a
//    request id, and we send the verdict back through the channel.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { describeTool, trunc } = require('./describe');

const DEDUPE_MS = 5000;

class Decisions extends EventEmitter {
  constructor() {
    super();
    this.open = new Map(); // id -> decision
  }

  // A held PermissionRequest hook. `res` is the pending HTTP response.
  fromHook(ev, res, { holdMs }) {
    const key = `${ev.session_id}|${ev.tool_name}|${stableJson(ev.tool_input)}`;
    // The same prompt can arrive twice (global hooks + a buddy chat's own).
    for (const d of this.open.values()) {
      if (d.key === key && Date.now() - d.createdAt < DEDUPE_MS) {
        this.addWaiter(d, res, holdMs);
        return d;
      }
    }
    const d = this.create({
      via: 'hook',
      key,
      sessionId: ev.session_id,
      agentId: ev.agent_id || null,
      toolName: ev.tool_name,
      toolInput: ev.tool_input || {},
      suggestions: Array.isArray(ev.permission_suggestions) ? ev.permission_suggestions : [],
    });
    this.addWaiter(d, res, holdMs);
    return d;
  }

  // A permission prompt relayed by a terminal session's channel.
  fromRelay({ sessionId, channelId, requestId, toolName, description, inputPreview }) {
    return this.create({ via: 'relay', key: `relay|${channelId}|${requestId}`, sessionId, channelId, requestId, toolName, description, inputPreview, toolInput: null, suggestions: [] });
  }

  create(fields) {
    const d = { id: crypto.randomUUID(), createdAt: Date.now(), waiters: [], ...fields };
    d.kind = d.toolName === 'AskUserQuestion' ? 'question' : d.toolName === 'ExitPlanMode' ? 'plan' : 'permission';
    this.open.set(d.id, d);
    this.emit('change');
    return d;
  }

  addWaiter(d, res, holdMs) {
    const w = { res, timer: setTimeout(() => this.dropWaiter(d, w, null), holdMs) };
    w.timer.unref();
    d.waiters.push(w);
    res.on('close', () => this.dropWaiter(d, w, undefined));
  }

  dropWaiter(d, w, body) {
    clearTimeout(w.timer);
    d.waiters = d.waiters.filter((x) => x !== w);
    if (body !== undefined) respond(w.res, body);
    if (d.via === 'hook' && !d.waiters.length && this.open.get(d.id) === d) {
      this.open.delete(d.id);
      this.emit('change');
    }
  }

  // The user clicked something. Returns what to do for relayed decisions.
  answer(id, { behavior, answers, always, message }) {
    const d = this.open.get(id);
    if (!d) return null;
    this.open.delete(id);
    this.emit('change');
    if (d.via === 'relay') {
      return { relay: { channelId: d.channelId, requestId: d.requestId, behavior: behavior === 'allow' ? 'allow' : 'deny' } };
    }
    const body = hookResponse(d, { behavior, answers, always, message });
    for (const w of d.waiters.splice(0)) {
      clearTimeout(w.timer);
      respond(w.res, body);
    }
    return { hook: true };
  }

  // Something happened in the session that means the prompt was answered
  // elsewhere (Claude's own dialog, the terminal): let the hook go silently.
  releaseSession(sessionId, toolName) {
    let changed = false;
    for (const d of [...this.open.values()]) {
      if (d.sessionId !== sessionId || (toolName && d.toolName !== toolName)) continue;
      this.open.delete(d.id);
      for (const w of d.waiters.splice(0)) {
        clearTimeout(w.timer);
        respond(w.res, null);
      }
      changed = true;
    }
    if (changed) this.emit('change');
  }

  forSession(sessionId) {
    return [...this.open.values()].filter((d) => d.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
  }

  // What the renderer needs to draw buttons for one decision.
  view(d) {
    const input = d.toolInput || {};
    const v = { id: d.id, kind: d.kind, tool: d.toolName, title: '', detail: '', canAlways: d.suggestions.length > 0, helper: !!d.agentId };
    if (d.kind === 'question') {
      v.title = 'Claude has a question';
      v.questions = (input.questions || []).map((q) => ({
        question: String(q.question || ''),
        header: String(q.header || ''),
        multiSelect: !!q.multiSelect,
        options: (q.options || []).map((o) => ({ label: String(o.label || ''), description: String(o.description || '') })),
      }));
    } else if (d.kind === 'plan') {
      v.title = 'Plan ready for review';
      v.detail = trunc(String(input.plan || ''), 1500);
    } else if (d.via === 'relay') {
      v.title = `Allow ${d.toolName}?`;
      v.detail = trunc(d.description || '', 200);
      v.preview = trunc(d.inputPreview || '', 400);
    } else {
      const desc = describeTool(d.toolName, input);
      v.title = `Allow ${d.toolName}?`;
      v.detail = desc.label;
      v.preview = trunc(previewOf(d.toolName, input), 400);
    }
    return v;
  }

  viewsFor(sessionId) {
    return this.forSession(sessionId).map((d) => this.view(d));
  }

  closeAll() {
    for (const d of this.open.values()) for (const w of d.waiters) respond(w.res, null);
    this.open.clear();
  }
}

function previewOf(tool, input) {
  if (input.command) return input.command;
  if (input.file_path && typeof input.new_string === 'string') return `${input.file_path}\n- ${input.old_string || ''}\n+ ${input.new_string}`;
  if (input.file_path) return input.file_path;
  if (input.url) return input.url;
  if (input.pattern) return input.pattern;
  return stableJson(input);
}

function hookResponse(d, { behavior, answers, always, message }) {
  const input = d.toolInput || {};
  let decision;
  if (behavior !== 'allow') {
    decision = { behavior: 'deny', message: message || (d.kind === 'plan' ? 'The user wants to keep planning. Ask what to change.' : 'The user denied this from Claude Companion.') };
  } else if (d.kind === 'question') {
    // AskUserQuestion takes the answers through updatedInput.
    decision = { behavior: 'allow', updatedInput: { ...input, answers: answers || {} } };
  } else {
    decision = { behavior: 'allow', updatedInput: input };
    if (always && d.suggestions.length) decision.updatedPermissions = d.suggestions;
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

function respond(res, body) {
  if (res.writableEnded || res.destroyed) return;
  if (body) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  else res.writeHead(204).end();
}

function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
    .join(',')}}`;
}

module.exports = { Decisions, hookResponse };
