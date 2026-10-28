'use strict';

// Fake snapshots that walk the buddy through every mood. Used with
// `npm run demo`, `--demo=<state>`, or when index.html is opened in a browser.

(function () {
  const todos = (done, current) =>
    ['Read the transcript format', 'Write the session parser', 'Draw the buddy', 'Wire up hooks', 'Polish animations'].map((content, i) => ({
      content,
      activeForm: ['Reading the transcript format', 'Writing the session parser', 'Drawing the buddy', 'Wiring up hooks', 'Polishing animations'][i],
      status: i < done ? 'completed' : i === current ? 'in_progress' : 'pending',
    }));

  let bubbleId = 0;
  const scenes = {
    idle: { status: 'idle', bubble: ['info', 'Hi! Ready when you are.'] },
    thinking: { status: 'thinking', bubble: ['info', 'Ooh, let’s go!'], todos: todos(0, 0) },
    read: { status: 'working', activity: { kind: 'read', label: 'Reading transcripts.js' }, bubble: ['tool', 'Reading transcripts.js'], todos: todos(0, 0) },
    search: { status: 'working', activity: { kind: 'search', label: 'Searching for “usage”' }, bubble: ['tool', 'Searching for “usage”'], todos: todos(1, 1) },
    edit: { status: 'working', activity: { kind: 'edit', label: 'Editing store.js' }, bubble: ['task', 'Next up: Writing the session parser'], todos: todos(1, 1) },
    run: { status: 'working', activity: { kind: 'run', label: 'Run the test suite' }, bubble: ['tool', 'Run the test suite'], todos: todos(2, 2) },
    web: { status: 'working', activity: { kind: 'web', label: 'Reading code.claude.com' }, bubble: ['tool', 'Reading code.claude.com'], todos: todos(2, 2) },
    agent: {
      status: 'working',
      activity: { kind: 'agent', label: 'Sending a helper: explore the repo' },
      bubble: ['tool', 'Sending a helper: explore the repo'],
      helpers: [
        { id: 'h1', type: 'Explore', label: 'Find where hooks are registered', activity: { kind: 'search', label: 'Searching for “hooks”' }, status: 'working' },
        { id: 'h2', type: 'general-purpose', label: 'Check the README examples', activity: { kind: 'read', label: 'Reading README.md' }, status: 'working' },
      ],
      todos: todos(3, 3),
    },
    waiting: {
      status: 'waiting',
      decision: { kind: 'permission', text: 'May I run this? npm install electron' },
      todos: todos(3, 3),
      actions: [{ id: 'd0', kind: 'permission', tool: 'Bash', title: 'Allow Bash?', detail: 'Install Electron', preview: 'npm install electron', canAlways: false }],
    },
    question: { status: 'done', decision: { kind: 'question', text: 'Should I also add a settings window?' }, todos: todos(4, 4) },
    done: { status: 'done', bubble: ['done', 'The buddy now follows your sessions, tokens and plan usage. ✨'], todos: todos(5, -1) },
    error: { status: 'error', bubble: ['error', 'I hit the rate limit — need a breather.'], todos: todos(3, 3) },
    compacting: { status: 'compacting', bubble: ['info', 'Tidying up my memory…'], todos: todos(3, 3) },
    sleeping: { status: 'sleeping' },
    // Chat panel scenes (opened automatically in demo mode)
    chat: {
      status: 'waiting',
      decision: { kind: 'permission', text: 'May I run this? npm test' },
      todos: todos(3, 3),
      chat: true,
      actions: [{ id: 'd1', kind: 'permission', tool: 'Bash', title: 'Allow Bash?', detail: 'Run the test suite', preview: 'npm test -- --watch=false', canAlways: true }],
    },
    chatq: {
      status: 'working',
      decision: { kind: 'question', text: 'Which colour should the default buddy be?' },
      todos: todos(4, 4),
      chat: true,
      source: 'buddy',
      actions: [
        {
          id: 'd2',
          kind: 'question',
          tool: 'AskUserQuestion',
          title: 'Claude has a question',
          questions: [{ question: 'Which colour should the default buddy be?', header: 'Colour', multiSelect: false, options: [{ label: 'Terracotta', description: '' }, { label: 'Ocean', description: '' }, { label: 'Mint', description: '' }] }],
        },
      ],
    },
  };
  const CHAT_ITEMS = [
    { id: 1, kind: 'user', text: 'Can you add a chat to the buddy?' },
    { id: 2, kind: 'assistant', text: 'Sure! I’ll add a **chat panel** with buttons for decisions. First, let me check how sessions can receive messages.' },
    { id: 3, kind: 'tools', items: ['Reading channels.md', 'Reading hooks.md', 'Editing main.js'], count: 5 },
    { id: 4, kind: 'assistant', text: 'The panel is in place. I need to run the tests next.' },
  ];
  const order = ['idle', 'thinking', 'read', 'search', 'edit', 'run', 'web', 'agent', 'waiting', 'question', 'done', 'error', 'compacting', 'sleeping'];

  function mate(id, project, source, status, decision, activity, todos) {
    return { id, project, title: '', source, status, waiting: !!decision, decision, activity, todos: { current: '', ...todos }, helpers: 0, canJump: source === 'vscode', focused: false };
  }

  function snapshot(name, i) {
    const sc = scenes[name] || scenes.idle;
    const now = Date.now();
    const total = 412000 + i * 38211;
    return {
      now,
      focus: {
        id: 'demo',
        project: 'ClaudeCompanion',
        title: '',
        status: sc.status,
        activity: sc.activity || null,
        decision: sc.decision || null,
        bubble: sc.bubble ? { id: ++bubbleId, kind: sc.bubble[0], text: sc.bubble[1], ttl: 6000, sticky: false, at: now } : null,
        model: 'Opus 5.5',
        source: sc.source || 'desktop',
        canJump: false,
        actions: sc.actions || [],
        input: sc.source === 'buddy' ? { mode: 'direct', via: 'buddy' } : { mode: 'none', hint: 'Claude Desktop doesn’t accept messages from other apps. Reply in Desktop, or start a buddy chat.' },
        chat: sc.source === 'buddy' ? { running: true, busy: true, error: null } : null,
        helpers: sc.helpers || [],
        todos: sc.todos || [],
        tokens: { input: 1200, output: 48000 + i * 900, cacheRead: total - 60000, cacheWrite: 10800, total },
        cost: 1.84 + i * 0.07,
        context: { used: 182000 + i * 4000, limit: 1000000, pct: 18.2 + i * 0.4 },
        hooked: true,
      },
      following: null,
      sessions: [
        { id: 'demo', project: 'ClaudeCompanion', source: 'desktop', status: sc.status, waiting: !!sc.decision, todos: { done: 3, total: 5 }, focused: true },
        mate('b', 'web-shop', 'vscode', name === 'edit' ? 'waiting' : 'working', name === 'edit' ? { kind: 'permission', text: 'May I edit db.ts?' } : null, { kind: 'edit', label: 'Editing db.ts' }, { done: 2, total: 6 }),
        mate('c', 'server', 'vscode', 'thinking', null, null, { done: 1, total: 3 }),
        mate('d', 'scripts', 'terminal', 'sleeping', null, null, { done: 0, total: 0 }),
      ],
      attention: name === 'edit' ? [{ id: 'b', project: 'web-shop', kind: 'permission', text: 'May I edit db.ts?' }] : [],
      usage: { today: { tokens: 18_400_000, output: 210_000, cost: 12.37 }, last5h: { tokens: 6_200_000, output: 81_000, cost: 4.12 } },
      credits: { plan: { fiveHour: { pct: 42, resetsAt: now + 2.2 * 3600e3 }, sevenDay: { pct: 67, resetsAt: now + 3.4 * 86400e3 } }, budget: null },
      setup: { hooks: { installed: true, upToDate: true }, statusLine: { installed: true } },
      display: null,
      chatItems: sc.chat ? CHAT_ITEMS : [],
      demoChat: !!sc.chat,
    };
  }

  window.startDemo = function (render, fixed) {
    if (fixed) {
      render(snapshot(fixed, 0));
      setInterval(() => {
        const s = snapshot(fixed, 0);
        s.focus.bubble = null;
        render(s);
      }, 4000);
      return;
    }
    let i = 0;
    const next = () => {
      render(snapshot(order[i % order.length], i));
      i++;
    };
    next();
    setInterval(next, 3600);
  };
})();
