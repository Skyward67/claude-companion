'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { costOf, prettyModel, contextLimitFor } = require('../src/main/pricing');
const { newTranscriptState, reduceEntry, applyPlanTool, TranscriptWatcher } = require('../src/main/transcripts');
const { Store } = require('../src/main/store');
const claudeConfig = require('../src/main/claudeConfig');

const T0 = Date.parse('2026-10-28T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

function fakeSettings(over = {}) {
  const data = { sleepAfterMin: 10, budget: { period: 'none', amount: 0 }, ...over };
  return { get: (k) => data[k] };
}

test('pricing uses per-model rates, cache TTLs and fast mode', () => {
  const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } };
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, 1h write = 2x input.
  const expected = (1000 * 4 + 1000 * 20 + 1_000_000 * 0.2 + 1000 * 8) / 1e6;
  assert.equal(costOf('claude-opus-5-5', usage).toFixed(6), expected.toFixed(6));
  assert.equal(costOf('claude-opus-5-5', { ...usage, speed: 'fast' }).toFixed(6), (expected * 2).toFixed(6));
  assert.equal(costOf('<synthetic>', usage), 0);
  assert.equal(prettyModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(prettyModel('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.equal(contextLimitFor('claude-haiku-4-5'), 200_000);
});

test('transcript reducer follows a turn and dedupes streamed usage', () => {
  const ts = newTranscriptState();
  const usage = { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
  reduceEntry(ts, { type: 'user', timestamp: at(0), message: { role: 'user', content: 'Fix the bug please' } });
  assert.equal(ts.status, 'thinking');
  assert.equal(ts.lastPrompt, 'Fix the bug please');

  const d1 = reduceEntry(ts, { type: 'assistant', timestamp: at(1), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '' }], usage: { ...usage, output_tokens: 5 } } });
  const d2 = reduceEntry(ts, {
    type: 'assistant',
    timestamp: at(2),
    message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'C:\\x\\app.js' } }], usage },
  });
  assert.equal(ts.tokens.output, 50, 'same message id counted once (max of lines)');
  assert.equal(d1.output + d2.output, 50);
  assert.equal(ts.status, 'working');
  assert.equal(ts.activity.label, 'Reading app.js');
  assert.equal(ts.contextUsed, 1010);

  reduceEntry(ts, { type: 'user', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } });
  assert.equal(ts.status, 'thinking');
  assert.equal(ts.pendingTools.size, 0);

  reduceEntry(ts, { type: 'assistant', timestamp: at(4), message: { id: 'm2', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixed it. The bug was an off-by-one.' }], usage } });
  assert.equal(ts.status, 'done');
  assert.equal(ts.lastText, 'Fixed it. The bug was an off-by-one.');

  // Command output and meta lines are not prompts.
  reduceEntry(ts, { type: 'user', timestamp: at(5), isMeta: true, message: { role: 'user', content: 'Caveat: …' } });
  reduceEntry(ts, { type: 'user', timestamp: at(6), message: { role: 'user', content: '<local-command-stdout>hi</local-command-stdout>' } });
  assert.equal(ts.status, 'done');
});

test('todo tools: TodoWrite, Task*, and the desktop plan tool', () => {
  const ts = newTranscriptState();
  applyPlanTool(ts, 'TodoWrite', { todos: [{ content: 'A', status: 'completed', activeForm: 'Doing A' }, { content: 'B', status: 'in_progress', activeForm: 'Doing B' }] });
  assert.deepEqual(ts.todos.map((t) => t.status), ['completed', 'in_progress']);

  const t2 = newTranscriptState();
  applyPlanTool(t2, 'TaskCreate', { subject: 'One' }, 'x1');
  applyPlanTool(t2, 'TaskCreate', { subject: 'Two' }, 'x2');
  applyPlanTool(t2, 'TaskUpdate', { taskId: '1', status: 'in_progress' });
  applyPlanTool(t2, 'TaskUpdate', { taskId: '2', status: 'deleted' });
  assert.deepEqual(t2.todos.map((t) => [t.content, t.status]), [['One', 'in_progress']]);

  const t3 = newTranscriptState();
  applyPlanTool(t3, 'mcp__ccd_turn__update_plan', { items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' }] });
  applyPlanTool(t3, 'mcp__ccd_turn__update_plan', { advance: true });
  assert.deepEqual(t3.todos.map((t) => t.status), ['completed', 'in_progress', 'pending']);
  applyPlanTool(t3, 'mcp__ccd_turn__update_plan', { done: [2], start: 3 });
  assert.deepEqual(t3.todos.map((t) => t.status), ['completed', 'completed', 'in_progress']);
  applyPlanTool(t3, 'mcp__ccd_turn__wrap_up', { recap: 'done' });
  assert.ok(t3.todos.every((t) => t.status === 'completed'));
});

test('store: permission request becomes a decision and clears after the tool runs', () => {
  let now = T0;
  const store = new Store({ settings: fakeSettings(), now: () => now });
  const base = { session_id: 's1', transcript_path: '/tmp/s1.jsonl', cwd: '/work/myproj' };
  const attention = [];
  store.on('attention', (s) => attention.push(s.id));

  store.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  now += 1000;
  store.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' } });
  let snap = store.snapshot();
  assert.equal(snap.focus.status, 'working');
  assert.equal(snap.focus.activity.label, 'Run tests');
  assert.equal(snap.focus.project, 'myproj');

  now += 1000;
  store.onHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  snap = store.snapshot();
  assert.equal(snap.focus.decision.kind, 'permission');
  assert.match(snap.focus.decision.text, /npm test/);
  assert.deepEqual(attention, ['s1']);

  now += 5000;
  store.onHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  snap = store.snapshot();
  assert.equal(snap.focus.decision, null);
  assert.equal(snap.focus.status, 'thinking');

  now += 1000;
  store.onHook({ ...base, hook_event_name: 'Stop', last_assistant_message: 'All tests pass now. Nice!' });
  snap = store.snapshot();
  assert.equal(snap.focus.status, 'done');
  assert.equal(snap.focus.bubble.text, 'All tests pass now.');

  now += 61_000;
  store.tick();
  assert.equal(store.snapshot().focus.status, 'idle');
  now += 11 * 60_000;
  assert.equal(store.snapshot().focus.status, 'sleeping');
});

test('store: what Claude did last this turn, for the buddy to act out', () => {
  let now = T0;
  const store = new Store({ settings: fakeSettings(), now: () => now });
  const base = { session_id: 's1', transcript_path: '/tmp/s1.jsonl', cwd: '/work/myproj' };
  const flow = () => store.snapshot().focus.flow;
  const entry = (s, content, extra = {}) => ({ type: 'assistant', timestamp: at(s), message: { id: `m${s}`, model: 'claude-opus-5-5', content, ...extra } });

  store.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  assert.deepEqual(flow(), { tool: null, toolAt: 0, writingAt: 0 });

  // Thinking lands in the transcript: Claude has moved on to writing.
  store.onTranscriptEntries('s1', [entry(2, [{ type: 'thinking', thinking: '' }])]);
  assert.equal(flow().writingAt, T0 + 2000);

  // The tool call stops the writing; its end is when it last ran.
  now = T0 + 3000;
  store.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/work/myproj/a.js' } });
  assert.deepEqual(flow(), { tool: 'edit', toolAt: T0 + 3000, writingAt: 0 });
  now = T0 + 4000;
  store.onHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit' });
  assert.deepEqual(flow(), { tool: 'edit', toolAt: T0 + 4000, writingAt: 0 });
  // A late transcript line from before the tool ended changes nothing.
  store.onTranscriptEntries('s1', [entry(3.5, [{ type: 'text', text: 'Fixing it.' }])]);
  assert.equal(flow().writingAt, 0);

  store.onTranscriptEntries('s1', [entry(6, [{ type: 'thinking', thinking: '' }])]);
  assert.deepEqual(flow(), { tool: 'edit', toolAt: T0 + 4000, writingAt: T0 + 6000 });
  // Crew views carry it too.
  assert.deepEqual(store.snapshot().sessions[0].flow, flow());

  now = T0 + 9000;
  store.onHook({ ...base, hook_event_name: 'Stop', last_assistant_message: 'Done.' });
  assert.equal(flow().writingAt, 0);
  store.onHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'again' });
  assert.deepEqual(flow(), { tool: null, toolAt: 0, writingAt: 0 });
});

test('transcript reducer keeps the flow without hooks', () => {
  const ts = newTranscriptState();
  reduceEntry(ts, { type: 'user', timestamp: at(0), message: { role: 'user', content: 'Look around' } });
  reduceEntry(ts, { type: 'assistant', timestamp: at(1), message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'x' } }] } });
  assert.deepEqual(ts.flow, { tool: 'search', toolAt: T0 + 1000, writingAt: 0 });
  reduceEntry(ts, { type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } });
  assert.deepEqual(ts.flow, { tool: 'search', toolAt: T0 + 2000, writingAt: 0 });
  reduceEntry(ts, { type: 'assistant', timestamp: at(5), message: { id: 'm2', content: [{ type: 'text', text: 'Found it.' }] } });
  assert.equal(ts.flow.writingAt, T0 + 5000);
  reduceEntry(ts, { type: 'assistant', timestamp: at(6), message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Bye.' }] } });
  assert.equal(ts.flow.writingAt, 0);
});

test('store: a waiting session takes focus over a busier one', () => {
  let now = T0;
  const store = new Store({ settings: fakeSettings(), now: () => now });
  store.onHook({ session_id: 'a', cwd: '/p/alpha', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  now += 2000;
  store.onHook({ session_id: 'b', cwd: '/p/beta', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x.js' } });
  const snap = store.snapshot();
  assert.equal(snap.focus.project, 'alpha');
  assert.equal(snap.sessions.length, 2);
  store.follow('b');
  const followed = store.snapshot();
  assert.equal(followed.focus.project, 'beta');
  assert.equal(followed.attention[0].project, 'alpha');
});

test('store: usage windows and budget', () => {
  let now = T0;
  const store = new Store({ settings: fakeSettings({ budget: { period: '5h', amount: 10 } }), now: () => now });
  store.addUsage({ t: now - 6 * 3600e3, tokens: 100, output: 10, cost: 5 });
  store.addUsage({ t: now - 3600e3, tokens: 200, output: 20, cost: 2.5 });
  const c = store.snapshot().credits;
  assert.equal(c.budget.spent, 2.5);
  assert.equal(c.budget.left, 7.5);
  store.onStatusLine({ session_id: 'z', rate_limits: { five_hour: { used_percentage: 42, resets_at: (now + 3600e3) / 1000 }, seven_day: { used_percentage: 10, resets_at: (now - 1000) / 1000 } } });
  const plan = store.snapshot().credits.plan;
  assert.equal(plan.fiveHour.pct, 42);
  assert.equal(plan.sevenDay, null, 'expired window is dropped');
});

test('VS Code sessions: source, workspace folder, AI title and reported cost', () => {
  let now = T0;
  const store = new Store({ settings: fakeSettings(), now: () => now });
  const line = (o) => ({ cwd: 'D:\\Dev\\web-shop', entrypoint: 'claude-vscode', sessionId: 'v1', ...o });
  store.onTranscriptEntries('v1', [
    line({ type: 'user', timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: '<ide_opened_file>The user opened db.ts</ide_opened_file>' }, { type: 'text', text: 'Add a tag field' }] } }),
    { type: 'ai-title', aiTitle: 'Add a tags field to products', sessionId: 'v1' },
    line({ type: 'assistant', timestamp: at(1), cwd: 'D:\\Dev\\web-shop\\apps\\server', message: { id: 'a', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: 'db.ts' } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    { type: 'cost-state', totalCostUSD: 3.5, sessionId: 'v1' },
  ]);
  const snap = store.snapshot();
  assert.equal(snap.focus.source, 'vscode');
  assert.equal(snap.focus.project, 'web-shop', 'workspace folder, not the subfolder Claude cd-ed into');
  assert.equal(snap.focus.title, 'Add a tags field to products');
  assert.equal(snap.focus.canJump, true);
  assert.equal(snap.focus.cost, 3.5);
  assert.equal(snap.focus.status, 'working');
  assert.equal(store.projectDirOf(store.sessions.get('v1')), 'D:\\Dev\\web-shop');
});

test('subagents: hook tool events update the helper, not the main agent', () => {
  let now = T0;
  const store = new Store({ settings: fakeSettings(), now: () => now });
  const base = { session_id: 'm', cwd: '/p/main' };
  store.onHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'explore the repo', subagent_type: 'Explore' } });
  now += 100;
  store.onHook({ ...base, hook_event_name: 'SubagentStart', agent_id: 'agent-abc', agent_type: 'Explore' });
  now += 100;
  store.onHook({ ...base, hook_event_name: 'PreToolUse', agent_id: 'agent-abc', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'hooks' } });
  now += 100;
  store.onHook({ ...base, hook_event_name: 'PostToolUse', agent_id: 'agent-abc', tool_name: 'Grep' });
  let f = store.snapshot().focus;
  assert.equal(f.status, 'working', 'main agent still waiting on its Agent call');
  assert.equal(f.activity.kind, 'agent');
  assert.equal(f.helpers.length, 1);
  assert.equal(f.helpers[0].type, 'Explore');
  assert.equal(f.helpers[0].activity.label, 'Searching for “hooks”');

  // A helper's permission prompt is still a decision for the user.
  now += 100;
  store.onHook({ ...base, hook_event_name: 'PermissionRequest', agent_id: 'abc', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  f = store.snapshot().focus;
  assert.match(f.decision.text, /^My helper asks: .*rm -rf dist/);

  now += 100;
  store.onHook({ ...base, hook_event_name: 'SubagentStop', agent_id: 'abc', last_assistant_message: 'Found it in main.js.' });
  now += 5000;
  store.onHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent' });
  assert.equal(store.snapshot().focus.helpers.length, 0, 'finished helpers fade out');
});

test('subagents: helpers are read from subagent transcripts without hooks', () => {
  let now = T0 + 10_000;
  const store = new Store({ settings: fakeSettings(), now: () => now });
  store.onTranscriptEntries('m', [{ type: 'assistant', timestamp: at(0), cwd: '/p/main', message: { id: 'x', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu', name: 'Agent', input: { description: 'look around' } }] } }]);
  store.onTranscriptEntries(
    'm',
    [
      { type: 'user', timestamp: at(1), isSidechain: true, message: { role: 'user', content: 'Find where hooks are registered' } },
      { type: 'assistant', timestamp: at(2), isSidechain: true, message: { id: 'y', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'g', name: 'Read', input: { file_path: '/p/main/hooks.js' } }], usage: { input_tokens: 10, output_tokens: 5 } } },
    ],
    { isSub: true, file: '/x/m/subagents/agent-q1.jsonl' },
  );
  const f = store.snapshot().focus;
  assert.equal(f.helpers.length, 1);
  assert.equal(f.helpers[0].id, 'q1');
  assert.equal(f.helpers[0].label, 'Find where hooks are registered');
  assert.equal(f.helpers[0].activity.label, 'Reading hooks.js');
  assert.equal(f.tokens.output, 5, 'helper tokens count toward the session');
});

test('several sessions: each gets a crew view with source and progress', () => {
  let now = T0;
  const store = new Store({ settings: fakeSettings(), now: () => now });
  store.onTranscriptEntries('a', [{ type: 'user', timestamp: at(0), cwd: '/w/alpha', entrypoint: 'cli', message: { content: 'hi' } }]);
  store.onTranscriptEntries('b', [
    { type: 'assistant', timestamp: at(1), cwd: '/w/beta', entrypoint: 'claude-vscode', message: { id: 'z', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'p', name: 'TodoWrite', input: { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress', activeForm: 'Doing two' }] } }] } },
  ]);
  now = T0 + 2000;
  const snap = store.snapshot();
  const byProject = Object.fromEntries(snap.sessions.map((v) => [v.project, v]));
  assert.equal(byProject.alpha.source, 'terminal');
  assert.equal(byProject.beta.source, 'vscode');
  assert.deepEqual(byProject.beta.todos, { done: 1, total: 2, current: 'Doing two' });
  assert.equal(snap.sessions.filter((v) => v.focused).length, 1);
});

test('display preferences: presets, custom edits and validation', () => {
  const { normalizeDisplay, updateDisplay, DISPLAY_DEFAULTS } = require('../src/main/display');
  let d = normalizeDisplay({});
  assert.equal(d.preset, 'standard');

  d = updateDisplay({ ...d, bodyColor: '#4f8fe0' }, { preset: 'minimal' });
  assert.equal(d.preset, 'minimal');
  assert.equal(d.showTokens, false);
  assert.equal(d.bodyColor, '#4f8fe0', 'presets leave the look alone');

  d = updateDisplay(d, { showTokens: true });
  assert.equal(d.preset, 'custom');
  d = updateDisplay(d, { showTokens: false });
  assert.equal(d.preset, 'minimal', 'undoing the edit lands back on the preset');

  d = updateDisplay(d, { crewSize: 42, bodyColor: 'javascript:alert(1)', theme: 'neon', bubbleLevel: 'shout', hiddenProjects: ' scratch, demo ,scratch,,', evil: 1 });
  assert.equal(d.crewSize, 8);
  assert.equal(d.bodyColor, '#4f8fe0');
  assert.equal(d.theme, DISPLAY_DEFAULTS.theme);
  assert.equal(d.bubbleLevel, 'important');
  assert.deepEqual(d.hiddenProjects, ['scratch', 'demo']);
  assert.equal('evil' in d, false);
});

test('display preferences: token ring, agents, arrangement, colours and fading', () => {
  const { normalizeDisplay, updateDisplay, extraWidth, PANELS } = require('../src/main/display');
  let d = normalizeDisplay({});
  assert.deepEqual(
    d.panels.map((p) => `${p.id}:${p.place}`),
    ['tokens:left', 'credits:right', 'tasks:below', 'crew:below', 'footer:below'],
  );

  // Every panel exactly once, whatever comes in.
  d = updateDisplay(d, { panels: [{ id: 'crew', place: 'left' }, { id: 'evil', place: 'left' }, { id: 'crew', place: 'right' }, { id: 'tasks', place: 'nowhere' }, null] });
  assert.deepEqual(
    d.panels.map((p) => `${p.id}:${p.place}`),
    ['crew:left', 'tasks:below', 'tokens:left', 'credits:right', 'footer:below'],
  );
  assert.deepEqual(updateDisplay(d, { panels: 'top' }).panels, d.panels, 'not a list: unchanged');
  assert.equal(new Set(normalizeDisplay({ panels: [] }).panels.map((p) => p.id)).size, PANELS.length);

  d = updateDisplay(d, { tokenStyle: 'ring', ringMetric: 'fiveHour', ringSize: 'large', helpersSide: 'right' });
  assert.equal(d.preset, 'standard', 'how cards look and where they sit is not part of a preset');
  assert.equal(updateDisplay(d, { preset: 'minimal' }).tokenStyle, 'ring');
  assert.equal(updateDisplay(d, { preset: 'minimal' }).panels[0].id, 'crew');
  d = updateDisplay(d, { tokenStyle: 'donut', ringMetric: 'forever', ringSize: 'huge', helpersSide: 'up' });
  assert.equal(d.tokenStyle, 'ring');
  assert.equal(d.ringMetric, 'fiveHour');
  assert.equal(d.ringSize, 'large');
  assert.equal(d.helpersSide, 'right');

  d = updateDisplay(d, { crewSize: 99, helpersMax: 0 });
  assert.equal(d.crewSize, 8);
  assert.equal(d.helpersMax, 1);
  assert.equal(updateDisplay(d, { helpersMax: 5 }).preset, 'custom', 'how many helpers is part of the layout, like the crew');

  d = updateDisplay(d, { cardColor: '#1B2233', accentColor: 'buddy', cardOpacity: 0.01, idleOpacity: 0.456 });
  assert.equal(d.cardColor, '#1b2233');
  assert.equal(d.accentColor, 'buddy');
  assert.equal(d.cardOpacity, 0.1);
  assert.equal(d.idleOpacity, 0.46);
  d = updateDisplay(d, { cardColor: 'buddy', accentColor: 'red; background: url(x)' });
  assert.equal(d.cardColor, '#1b2233', 'only the accent can follow the buddy');
  assert.equal(d.accentColor, 'buddy');
  d = updateDisplay(d, { cardColor: '', accentColor: '' });
  assert.equal(d.cardColor, '');
  assert.equal(d.accentColor, '');

  // Only a large ring beside the buddy needs a wider window.
  const ring = { tokenStyle: 'ring', ringSize: 'large', panels: [{ id: 'tokens', place: 'right' }] };
  assert.ok(extraWidth(ring) > 0);
  assert.equal(extraWidth({ ...ring, ringSize: 'medium' }), 0);
  assert.equal(extraWidth({ ...ring, showTokens: false }), 0);
  assert.equal(extraWidth({ ...ring, panels: [{ id: 'tokens', place: 'below' }] }), 0);
  assert.equal(extraWidth({}), 0);
});

test('store: ignored projects and the active window come from display settings', () => {
  let now = T0;
  const data = { sleepAfterMin: 10, budget: { period: 'none' }, display: { activeMinutes: 5, hiddenProjects: ['Scratch'] } };
  const store = new Store({ settings: { get: (k) => data[k] }, now: () => now });
  const attention = [];
  store.on('attention', (s) => attention.push(store.isHidden(s)));
  store.onHook({ session_id: 'a', cwd: '/w/scratch', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  store.onHook({ session_id: 'b', cwd: '/w/real', hook_event_name: 'UserPromptSubmit' });
  let snap = store.snapshot();
  assert.deepEqual(snap.sessions.map((v) => v.project), ['real'], 'hidden project is not listed');
  assert.equal(snap.focus.project, 'real', 'and never takes focus, even when waiting');
  assert.deepEqual(attention, [true], 'main.js uses isHidden to skip its notification');

  now += 6 * 60000;
  snap = store.snapshot();
  assert.equal(snap.sessions.length, 0, 'inactive after the configured 5 minutes');
});

test('hook installer keeps the user’s own hooks and removes only ours', () => {
  const user = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }] } };
  const installed = claudeConfig.withHooks(user, 47821, 'win32');
  assert.equal(installed.model, 'opus');
  assert.equal(installed.hooks.PreToolUse.length, 2);
  assert.equal(installed.hooks.PreToolUse[0].hooks[0].command, 'my-guard.sh');
  for (const event of claudeConfig.HOOK_EVENTS) assert.ok(installed.hooks[event], event);
  const ours = installed.hooks.Stop[0].hooks[0];
  assert.equal(ours.async, true);
  assert.match(ours.command, /^curl\.exe .*127\.0\.0\.1:47821\/hook\?src=claude-companion" ; exit 0$/);

  const again = claudeConfig.withHooks(installed, 50000, 'linux');
  assert.equal(again.hooks.Stop.length, 1, 'reinstall replaces instead of duplicating');
  assert.match(again.hooks.Stop[0].hooks[0].command, /^curl .*:50000\//);

  const removed = claudeConfig.stripOurHooks(JSON.parse(JSON.stringify(again)));
  assert.deepEqual(removed, user);
  assert.equal(user.hooks.PreToolUse.length, 1, 'input not mutated');
});

test('watcher tails appended lines and holds back partial ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, 'sess1', 'subagents'), { recursive: true });
  const file = path.join(proj, 'sess1.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n{"type":"assi');
  fs.writeFileSync(path.join(proj, 'sess1', 'subagents', 'agent-1.jsonl'), JSON.stringify({ type: 'assistant', message: {} }) + '\n');

  const w = new TranscriptWatcher(dir);
  const got = [];
  w.on('entries', (id, entries, meta) => got.push([id, entries.length, meta.isSub]));
  w.scan(0);
  w.poll();
  assert.deepEqual(got.sort(), [['sess1', 1, false], ['sess1', 1, true]]);

  fs.appendFileSync(file, 'stant","message":{}}\n');
  w.poll();
  assert.deepEqual(got[2], ['sess1', 1, false]);
  fs.rmSync(dir, { recursive: true, force: true });
});
