'use strict';

const $ = (id) => document.getElementById(id);
const api = window.companion;
const buddy = new window.Character($('char'));

let snap = null;
let petUntil = 0;
let busySince = 0;

// What to show and how (Settings → Display / Look). Mirrors display.js
// defaults so the page also works standalone in demo mode.
const DEFAULT_DISPLAY = {
  showTokens: true,
  tokenMetric: 'session',
  showCredits: true,
  creditsMode: 'auto',
  showTasks: true,
  showCrew: true,
  crewSize: 4,
  showHelpers: true,
  showFooter: true,
  showCost: true,
  bubbleLevel: 'all',
  bubbleSeconds: 6,
  bodyColor: '#e07b56',
  theme: 'dark',
  cardOpacity: 0.9,
  motion: 'full',
  eyesFollow: true,
};
let display = DEFAULT_DISPLAY;
let appliedLook = '';

function applyLook(d) {
  const key = [d.bodyColor, d.theme, d.cardOpacity, d.motion, d.eyesFollow].join('|');
  if (key === appliedLook) return;
  appliedLook = key;
  window.setBodyColor(d.bodyColor);
  document.documentElement.dataset.theme = d.theme;
  document.documentElement.style.setProperty('--card-alpha', String(d.cardOpacity));
  document.body.classList.remove('motion-full', 'motion-reduced', 'motion-off');
  document.body.classList.add(`motion-${d.motion}`);
  if (!d.eyesFollow) buddy.lookAt(0, 0);
}

// ---------- formatting ----------

function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

function fmtUsd(n) {
  if (!n) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

function fmtIn(ms) {
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const STATUS_WORDS = {
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  waiting: 'needs you',
  done: 'done',
  error: 'error',
  sleeping: 'asleep',
  compacting: 'compacting',
};

const SOURCE_NAMES = { vscode: 'VS Code', desktop: 'Claude Desktop', terminal: 'Terminal', sdk: 'Agent SDK' };

// ---------- render ----------

// Mood for a session view (the focus, or a crew member).
function moodFor(v) {
  if (!v) return 'idle';
  if (v.decision || v.waiting) return 'waiting';
  return v.status in STATUS_WORDS ? v.status : 'idle';
}

function moodOf(s) {
  if (Date.now() < petUntil) return 'pet';
  return moodFor(s.focus);
}

function render(s) {
  snap = s;
  display = { ...DEFAULT_DISPLAY, ...(s.display || {}) };
  applyLook(display);
  const f = s.focus;
  const mood = moodOf(s);
  const helpers = display.showHelpers ? (f && f.helpers) || [] : [];
  let act = f && f.decision ? 'ask' : f && f.activity ? f.activity.kind : null;
  // The clones at its feet already show the helpers.
  if (act === 'agent' && helpers.length) act = null;

  if (mood === 'working') busySince = busySince || Date.now();
  else busySince = 0;
  buddy.svg.classList.toggle('busy', !!busySince && Date.now() - busySince > 90000);
  buddy.setMood(mood, act);

  renderTokens(s);
  renderCredits(s);
  renderTasks(f);
  renderHelpers(helpers);
  renderCrew(s);
  renderFooter(s);
  renderAttention(s);
  renderBubble(s);
  updateBubbleButtons(f);
  if (openPop) fillPop(openPop);
  if (window.chatUI) window.chatUI.render(s);
}

// Allow / Deny right in the "Needs you" bubble, when the buddy can answer.
function updateBubbleButtons(f) {
  const box = $('bubble-buttons');
  const a = shown && shown.kind === 'waiting' && f && f.actions && f.actions[0];
  const html = !a
    ? ''
    : a.kind === 'permission'
      ? `<button type="button" class="primary" data-b="allow">Allow</button><button type="button" data-b="deny">Deny</button><button type="button" data-b="chat" title="Open the chat">💬</button>`
      : `<button type="button" class="primary" data-b="chat">${a.kind === 'plan' ? 'Review plan' : 'Answer'}</button>`;
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
    box.dataset.id = a ? a.id : '';
  }
  bubbleEl.classList.toggle('has-buttons', !!a);
  if (a) bubbleEl.classList.add('interactive');
  else if (!bubbleEl.dataset.jump) bubbleEl.classList.remove('interactive');
}

$('bubble-buttons').addEventListener('click', (e) => {
  e.stopPropagation();
  const b = e.target.closest('[data-b]');
  if (!b) return;
  const id = $('bubble-buttons').dataset.id;
  if (b.dataset.b === 'chat') window.chatUI.setOpen(true);
  else if (window.bubbleDecide) window.bubbleDecide(id, b.dataset.b);
});

// ---------- helpers (subagents) ----------

const helpersEl = $('helpers');
const helperChars = [];
const MAX_HELPERS = 3;

function renderHelpers(list) {
  helpersEl.hidden = !list.length;
  const n = Math.min(MAX_HELPERS, list.length);
  while (helperChars.length < n) {
    const host = document.createElement('div');
    host.className = 'helper';
    helpersEl.insertBefore(host, helpersEl.querySelector('.helpers-more'));
    helperChars.push(new window.Character(host));
  }
  while (helperChars.length > n) helperChars.pop().svg.parentElement.remove();
  list.slice(0, n).forEach((h, i) => {
    const mood = h.status === 'done' ? 'done' : h.status === 'thinking' ? 'thinking' : 'working';
    helperChars[i].setMood(mood, h.activity ? h.activity.kind : null);
  });
  let more = helpersEl.querySelector('.helpers-more');
  if (list.length > MAX_HELPERS) {
    if (!more) {
      more = document.createElement('span');
      more.className = 'helpers-more';
      helpersEl.appendChild(more);
    }
    more.textContent = `+${list.length - MAX_HELPERS}`;
  } else if (more) {
    more.remove();
  }
}

// ---------- crew (other sessions) ----------

const crewEl = $('crew');
const mates = new Map(); // session id -> { el, character }

function renderCrew(s) {
  const others = display.showCrew ? s.sessions.filter((x) => !x.focused) : [];
  const MAX_CREW = display.crewSize;
  crewEl.hidden = !others.length;
  const shown = others.slice(0, MAX_CREW);
  const ids = new Set(shown.map((v) => v.id));
  for (const [id, m] of mates) {
    if (!ids.has(id)) {
      m.el.remove();
      mates.delete(id);
    }
  }
  for (const v of shown) {
    let m = mates.get(v.id);
    if (!m) m = createMate(v.id);
    m.el.classList.toggle('waiting', v.waiting);
    m.el.querySelector('.src-dot').className = `src-dot s-${v.source}`;
    m.el.querySelector('.mate-name').textContent = v.project;
    m.el.querySelector('.mate-bar').hidden = !v.todos.total;
    m.el.querySelector('.mate-fill').style.width = `${v.todos.total ? (v.todos.done / v.todos.total) * 100 : 0}%`;
    m.character.setMood(moodFor(v), v.decision ? 'ask' : v.activity ? v.activity.kind : null);
  }
  // Re-append only when the order changed: moving nodes restarts animations.
  const order = shown.map((v) => v.id).join('|');
  if (crewEl.dataset.order !== order) {
    crewEl.dataset.order = order;
    for (const v of shown) crewEl.appendChild(mates.get(v.id).el);
  }
  let more = crewEl.querySelector('.mate-more');
  if (others.length > MAX_CREW) {
    if (!more) {
      more = document.createElement('span');
      more.className = 'mate-more';
    }
    more.textContent = `+${others.length - MAX_CREW}`;
    crewEl.appendChild(more);
  } else if (more) {
    more.remove();
  }
}

function createMate(id) {
  const el = document.createElement('button');
  el.className = 'mate interactive';
  el.dataset.pop = 'mate';
  el.dataset.id = id;
  el.innerHTML = '<div class="mate-char"></div><div class="mate-label"><span class="src-dot"></span><span class="mate-name"></span></div><div class="mate-bar"><div class="mate-fill"></div></div>';
  const character = new window.Character(el.querySelector('.mate-char'));
  el.addEventListener('mouseenter', () => openPopFor(el));
  el.addEventListener('mouseleave', scheduleClosePop);
  el.addEventListener('click', () => api && api.follow(id));
  const m = { el, character };
  mates.set(id, m);
  crewEl.appendChild(el);
  return m;
}

function renderTokens(s) {
  $('tokens').hidden = !display.showTokens;
  if (!display.showTokens) return;
  const f = s.focus;
  const pct = f ? f.context.pct : 0;
  const ring = $('ctx-ring');
  ring.style.strokeDashoffset = String(50.27 * (1 - pct / 100));
  ring.style.stroke = pct > 85 ? 'var(--bad)' : pct > 65 ? 'var(--warn)' : 'var(--accent)';
  const ctx = f ? `ctx ${Math.round(pct)}%` : 'no session';
  const [label, big, sub] = {
    session: () => ['Tokens', fmtTokens(f ? f.tokens.total : s.usage.today.tokens), f ? ctx : 'today'],
    output: () => ['Output', fmtTokens(f ? f.tokens.output : s.usage.today.output), f ? ctx : 'today'],
    today: () => ['Today', fmtTokens(s.usage.today.tokens), ctx],
    context: () => ['Context', `${Math.round(pct)}%`, f ? `${fmtTokens(f.context.used)} / ${fmtTokens(f.context.limit)}` : '—'],
  }[display.tokenMetric]();
  $('tok-label').textContent = label;
  $('tok-total').textContent = big;
  $('ctx-label').textContent = sub;
}

function meter(name, pct) {
  const level = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : '';
  return `<div class="meter"><span>${name}</span><div class="m-bar"><div class="m-fill ${level}" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div><b>${Math.round(pct)}%</b></div>`;
}

// Which view the credits card uses: plan limits, a budget, or spend.
function creditsMode(s) {
  const c = s.credits;
  let mode = display.creditsMode;
  if (mode === 'auto') mode = c.plan ? 'plan' : c.budget ? 'budget' : 'today';
  // With money hidden, only plan percentages are left to show.
  if (!display.showCost && mode !== 'plan') mode = c.plan ? 'plan' : null;
  return display.showCredits ? mode : null;
}

function renderCredits(s) {
  const c = s.credits;
  const mode = creditsMode(s);
  $('credits').hidden = !mode;
  if (!mode) return;
  const body = $('cred-body');
  let label;
  let html;
  if (mode === 'plan') {
    label = 'Plan usage';
    html = c.plan
      ? (c.plan.fiveHour ? meter('5h', c.plan.fiveHour.pct) : '') + (c.plan.sevenDay ? meter('7d', c.plan.sevenDay.pct) : '') + (c.plan.spend ? meter('$', c.plan.spend.pct) : '')
      : '<div class="chip-note">Turn on plan usage in Settings → Connect</div>';
  } else if (mode === 'budget') {
    label = 'Budget left';
    if (c.budget) {
      const per = { '5h': '5h', day: 'day', week: 'wk', month: 'mo' }[c.budget.period] || c.budget.period;
      html = `<div class="chip-big">${fmtUsd(c.budget.left)}</div>${meter(per, c.budget.pct)}`;
    } else {
      html = '<div class="chip-note">Set a budget in Settings → Data</div>';
    }
  } else if (mode === 'session') {
    label = 'This session';
    html = `<div class="chip-big">≈${fmtUsd(s.focus ? s.focus.cost : 0)}</div><div class="chip-note">API-price estimate</div>`;
  } else {
    label = 'Today';
    html = `<div class="chip-big">≈${fmtUsd(s.usage.today.cost)}</div><div class="chip-note">API-price estimate</div>`;
  }
  $('cred-label').textContent = label;
  if (body.dataset.html !== html) {
    body.dataset.html = html;
    body.innerHTML = html;
  }
}

function renderTasks(f) {
  const box = $('tasks');
  const todos = f && display.showTasks ? f.todos : [];
  if (!todos.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  const next = todos.find((t) => t.status === 'pending');
  $('tasks-count').textContent = `${done}/${todos.length}`;
  $('tasks-current').textContent = current ? current.activeForm || current.content : done === todos.length ? 'All tasks done!' : next ? `Next: ${next.content}` : '';
  $('tasks-fill').style.width = `${(done / todos.length) * 100}%`;
  box.classList.toggle('all-done', done === todos.length);
}

function renderFooter(s) {
  const f = s.focus;
  // ⚡ connect and ↺ auto live here, so keep the footer while they're needed.
  $('footer').hidden = !display.showFooter && !s.following && !(s.setup && !s.setup.hooks.installed);
  $('src').className = `src-dot s-${(f && f.source) || ''}`;
  $('src').hidden = !f;
  $('project').textContent = f ? f.title || f.project : 'No Claude session yet';
  $('model').textContent = [f && f.model, f && SOURCE_NAMES[f.source]].filter(Boolean).map((x) => `· ${x}`).join(' ');
  $('auto').hidden = !s.following;
  $('connect').hidden = !s.setup || s.setup.hooks.installed;
}

function renderAttention(s) {
  const el = $('attention');
  const a = s.attention && s.attention[0];
  el.hidden = !a;
  if (a) {
    el.textContent = `❗ ${a.project} needs you${s.attention.length > 1 ? ` (+${s.attention.length - 1})` : ''}`;
    el.dataset.id = a.id;
  }
}

// ---------- speech bubble ----------

const bubbleEl = $('bubble');
const TAGS = { waiting: 'Needs you', done: 'Done', error: 'Uh oh', oops: 'Hmm', task: 'Progress' };
let shown = null; // { id, kind, sticky, text }
const seen = new Set(); // bubble ids already displayed; never replay them
let queued = null;
let queueTimer = null;
let hideTimer = null;
let typeTimer = null;
let lastShownAt = 0;
let hintShown = false;

// Which bubble kinds each "Speech bubbles" level lets through (null = all).
const BUBBLE_KINDS = { all: null, important: ['waiting', 'done', 'error', 'task'], decisions: ['waiting'], off: [] };

function bubbleAllowed(kind) {
  const allowed = BUBBLE_KINDS[display.bubbleLevel];
  return !allowed || allowed.includes(kind);
}

function renderBubble(s) {
  // The chat panel shows everything a bubble would, with buttons.
  if (display.bubbleLevel === 'off' || (window.chatUI && window.chatUI.isOpen())) {
    hideBubble();
    return;
  }
  const f = s.focus;
  let b = f && f.bubble;
  if (b && !bubbleAllowed(b.kind)) b = null;

  // A pending decision always has a visible, sticky bubble.
  if (f && f.decision && (!b || b.kind !== 'waiting')) {
    const text = decisionText(f.decision);
    if (shown && shown.kind === 'waiting' && shown.text === text) return;
    b = { id: `decision:${f.id}:${f.decision.since}:${text}`, kind: 'waiting', text, sticky: true, ttl: 0, at: Date.now() };
  }
  if (shown && shown.sticky && !(f && f.decision) && (!b || b.id === shown.id)) {
    hideBubble();
  }
  if (!b && !hintShown && s.setup && bubbleAllowed('info')) {
    hintShown = true;
    if (!f) b = { id: 'hint:none', kind: 'info', text: "Hi! I'll keep an eye on Claude Code for you. Start a session!", ttl: 9000, at: Date.now() };
    else if (!s.setup.hooks.installed) b = { id: 'hint:hooks', kind: 'info', text: 'Tip: click “⚡ connect” so I can tell you when Claude needs a decision.', ttl: 9000, at: Date.now() };
  }
  if (!b || seen.has(b.id) || (queued && b.id === queued.id)) return;
  if (!b.sticky && Date.now() - b.at > b.ttl) return;
  // A VS Code session's "needs you" bubble opens VS Code when clicked.
  if (b.kind === 'waiting' && f && f.canJump) b = { ...b, jumpId: f.id };

  const wait = 900 - (Date.now() - lastShownAt);
  if (wait > 0 && b.kind !== 'waiting' && shown && !shown.sticky) {
    queued = b;
    clearTimeout(queueTimer);
    queueTimer = setTimeout(() => {
      const q = queued;
      queued = null;
      if (q) showBubble(q);
    }, wait);
    return;
  }
  queued = null;
  showBubble(b);
}

function decisionText(d) {
  if (d.kind === 'question' && !/^quick question/i.test(d.text)) return `Quick question: ${d.text}`;
  return d.text;
}

function showBubble(b) {
  clearTimeout(hideTimer);
  clearInterval(typeTimer);
  bubbleEl.hidden = false;
  bubbleEl.className = `bubble k-${b.kind}${b.jumpId ? ' clickable interactive' : ''}`;
  bubbleEl.dataset.jump = b.jumpId || '';
  void bubbleEl.offsetWidth; // restart pop-in
  bubbleEl.querySelector('.bubble-tag').textContent = TAGS[b.kind] || '';
  const textEl = bubbleEl.querySelector('.bubble-text');
  const text = b.text;
  // Quick typewriter, capped at ~0.7s.
  let i = 0;
  const step = Math.max(1, Math.ceil(text.length / 35));
  textEl.textContent = '';
  typeTimer = setInterval(() => {
    i += step;
    textEl.textContent = text.slice(0, i);
    if (i >= text.length) clearInterval(typeTimer);
  }, 20);
  shown = { id: b.id, kind: b.kind, sticky: !!b.sticky, text };
  seen.add(b.id);
  if (seen.size > 500) seen.delete(seen.values().next().value);
  lastShownAt = Date.now();
  if (!b.sticky) {
    // "Bubbles stay for N seconds" scales every bubble's normal duration.
    const ttl = (b.ttl || 6000) * ((display.bubbleSeconds || 6) / 6);
    const remaining = Math.max(2000, ttl - Math.max(0, Date.now() - (b.at || Date.now())));
    hideTimer = setTimeout(hideBubble, remaining);
  }
}

function hideBubble() {
  if (bubbleEl.hidden) return;
  clearTimeout(hideTimer);
  clearInterval(typeTimer);
  bubbleEl.classList.add('out');
  const id = shown && shown.id;
  setTimeout(() => {
    if (shown && shown.id === id) {
      bubbleEl.hidden = true;
      shown = null;
    }
  }, 220);
}

// ---------- popovers ----------

const popEl = $('pop');
let openPop = null;
let openPopId = null; // which crew member a 'mate' popover is about
let popCloseTimer = null;

function fillPop(kind) {
  const s = snap;
  if (!s) return;
  const f = s.focus;
  let html = '';
  const money = display.showCost;
  const usd = (n) => (money ? ` · ${fmtUsd(n)}` : '');
  if (kind === 'tokens') {
    if (f) {
      html += `<h4>This session</h4><div class="grid">
        <span>Input</span><span>${fmtTokens(f.tokens.input)}</span>
        <span>Output</span><span>${fmtTokens(f.tokens.output)}</span>
        <span>Cache read</span><span>${fmtTokens(f.tokens.cacheRead)}</span>
        <span>Cache write</span><span>${fmtTokens(f.tokens.cacheWrite)}</span>
        <span>Context</span><span>${fmtTokens(f.context.used)} / ${fmtTokens(f.context.limit)}</span>
        ${money ? `<span>Est. cost</span><span>${fmtUsd(f.cost)}</span>` : ''}</div>`;
    }
    html += `<h4>All sessions</h4><div class="grid">
      <span>Today</span><span>${fmtTokens(s.usage.today.tokens)}${usd(s.usage.today.cost)}</span>
      <span>Last 5 hours</span><span>${fmtTokens(s.usage.last5h.tokens)}${usd(s.usage.last5h.cost)}</span>
      <span>Output today</span><span>${fmtTokens(s.usage.today.output)}</span></div>
      ${money ? '<div class="hint">Costs are estimates at API list prices.</div>' : ''}`;
  } else if (kind === 'credits') {
    const c = s.credits;
    if (c.plan) {
      html += '<h4>claude.ai plan</h4><div class="grid">';
      const row = (name, w) => (w ? `<span>${name}</span><span>${Math.round(w.pct)}% · resets in ${fmtIn(w.resetsAt - Date.now())}</span>` : '');
      html += row('5-hour window', c.plan.fiveHour) + row('Weekly', c.plan.sevenDay);
      if (c.plan.spend) html += `<span>Spend limit</span><span>${Math.round(c.plan.spend.pct)}%${c.plan.spend.limitUsd ? ` of ${fmtUsd(c.plan.spend.limitUsd)}` : ''}</span>`;
      html += '</div>';
    }
    if (c.budget && money) {
      html += `<h4>Your budget</h4><div class="grid">
        <span>Spent (${esc(c.budget.period)})</span><span>${fmtUsd(c.budget.spent)} / ${fmtUsd(c.budget.amount)}</span>
        <span>Left</span><span>${fmtUsd(c.budget.left)}</span></div>`;
    }
    if (money) {
      html += `<h4>Estimated spend</h4><div class="grid">
        <span>This session</span><span>${fmtUsd(f ? f.cost : 0)}</span>
        <span>Today</span><span>${fmtUsd(s.usage.today.cost)}</span>
        <span>Last 5 hours</span><span>${fmtUsd(s.usage.last5h.cost)}</span></div>`;
    }
    if (!c.plan) html += '<div class="hint">Plan limits (5h / weekly) show up once plan usage is turned on in Settings → Connect. Budgets are set in Settings → Data.</div>';
  } else if (kind === 'tasks' && f) {
    const icon = { completed: '✓', in_progress: '▶', pending: '○' };
    html += `<h4>Tasks · ${esc(f.project)}</h4><ul>${f.todos.map((t) => `<li class="${esc(t.status)}"><span class="ic">${icon[t.status] || '○'}</span><span>${esc(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</span></li>`).join('')}</ul>`;
  } else if (kind === 'helpers' && f) {
    const list = f.helpers || [];
    html += `<h4>Helpers · ${list.length}</h4><ul>${list
      .map((h) => {
        const doing = h.activity ? h.activity.label : h.status === 'done' ? 'Finished' : 'Thinking…';
        return `<li><span class="ic">✦</span><span><b>${esc(h.type || 'Helper')}</b> — ${esc(doing)}${h.label ? `<span class="sub">${esc(h.label)}</span>` : ''}</span></li>`;
      })
      .join('')}</ul>`;
  } else if (kind === 'mate') {
    const v = s.sessions.find((x) => x.id === openPopId);
    if (!v) return closePop();
    html += `<h4>${esc(v.project)} · ${esc(SOURCE_NAMES[v.source] || 'Claude Code')}</h4>`;
    if (v.title) html += `<div>${esc(v.title)}</div>`;
    if (v.decision) html += `<div class="need">❗ ${esc(decisionText(v.decision))}</div>`;
    else html += `<div class="sub">${esc(v.activity ? v.activity.label : STATUS_WORDS[v.status] || v.status)}</div>`;
    if (v.todos.total) html += `<div class="sub">Tasks ${v.todos.done}/${v.todos.total}${v.todos.current ? ` · ${esc(v.todos.current)}` : ''}</div>`;
    if (v.helpers) html += `<div class="sub">${v.helpers} helper${v.helpers > 1 ? 's' : ''} working</div>`;
    html += `<div class="actions"><button data-act="follow" data-id="${esc(v.id)}">Follow</button>${v.canJump ? `<button class="primary" data-act="jump" data-id="${esc(v.id)}">Open in VS Code</button>` : ''}</div>`;
  } else if (kind === 'sessions') {
    html += '<h4>Following</h4>';
    if (!s.sessions.length) html += '<div class="hint">No active Claude Code sessions in the last 45 minutes.</div>';
    for (const x of s.sessions) {
      html += `<button class="sess" data-id="${esc(x.id)}"><span class="src-dot s-${esc(x.source)}"></span><span>${esc(x.project)}${x.title ? ` — ${esc(x.title.slice(0, 32))}` : ''}</span><span class="st">${x.waiting ? 'needs you' : STATUS_WORDS[x.status] || x.status}${x.focused ? ' · shown' : ''}</span></button>`;
    }
    if (s.following) html += '<button class="sess" data-id=""><span>↺ Back to automatic</span></button>';
    if (f && f.canJump) html += `<div class="actions"><button class="primary" data-act="jump" data-id="${esc(f.id)}">Open ${esc(f.project)} in VS Code</button></div>`;
    if (f && !f.hooked && s.setup && s.setup.hooks.installed) html += '<div class="hint">Hooks are installed but this session hasn’t reported yet. Restart it to get live permission alerts.</div>';
  }
  // Only touch the DOM when something changed, so clicks on buttons inside
  // the popover aren't lost to a re-render.
  if (popEl.dataset.html !== html) {
    popEl.dataset.html = html;
    popEl.innerHTML = html;
  }
}

function closePop() {
  popEl.hidden = true;
  openPop = null;
  openPopId = null;
}

function openPopFor(el) {
  if (window.chatUI && window.chatUI.isOpen()) return;
  const kind = el.dataset.pop;
  const f = snap && snap.focus;
  if (!kind || (kind === 'tasks' && !(f && f.todos.length)) || (kind === 'helpers' && !(f && f.helpers && f.helpers.length))) return;
  clearTimeout(popCloseTimer);
  openPop = kind;
  openPopId = el.dataset.id || null;
  fillPop(kind);
  popEl.hidden = false;
  const rect = el.getBoundingClientRect();
  popEl.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  popEl.style.top = 'auto';
}

function scheduleClosePop() {
  clearTimeout(popCloseTimer);
  popCloseTimer = setTimeout(closePop, 250);
}

for (const el of document.querySelectorAll('[data-pop]')) {
  el.addEventListener('mouseenter', () => openPopFor(el));
  el.addEventListener('mouseleave', scheduleClosePop);
}
popEl.addEventListener('mouseenter', () => clearTimeout(popCloseTimer));
popEl.addEventListener('mouseleave', scheduleClosePop);
popEl.addEventListener('click', (e) => {
  if (!api) return;
  const act = e.target.closest('[data-act]');
  if (act && act.dataset.act === 'jump') api.jump(act.dataset.id);
  else if (act && act.dataset.act === 'follow') api.follow(act.dataset.id);
  const btn = e.target.closest('.sess');
  if (btn) api.follow(btn.dataset.id || null);
});

bubbleEl.addEventListener('click', () => {
  if (bubbleEl.dataset.jump && api) api.jump(bubbleEl.dataset.jump);
});
$('auto').addEventListener('click', (e) => {
  e.stopPropagation();
  if (api) api.follow(null);
});

// ---------- interaction ----------

// The window is click-through except over the widgets themselves.
let ignoring = true;
document.addEventListener('mousemove', (e) => {
  const over = !!(e.target && e.target.closest && e.target.closest('.interactive'));
  if (over === !ignoring) return;
  ignoring = !over;
  if (api) api.setIgnoreMouse(ignoring);
});
document.addEventListener('mouseleave', () => {
  if (!ignoring && api) api.setIgnoreMouse(true);
  ignoring = true;
});

const buddyEl = $('buddy');
buddyEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (api) api.dragStart();
});
buddyEl.addEventListener('mouseup', async (e) => {
  if (e.button !== 0) return;
  const moved = api ? await api.dragEnd() : false;
  if (!moved) pet();
});

function pet() {
  petUntil = Date.now() + 1800;
  const lines = ['Hehe!', '♥', 'That tickles!', 'Yay!', '*happy wiggle*'];
  if (!(snap && snap.focus && snap.focus.decision) && bubbleAllowed('info')) {
    showBubble({ id: `pet:${Date.now()}`, kind: 'info', text: lines[Math.floor(Math.random() * lines.length)], ttl: 2200, at: Date.now() });
  }
  if (snap) render(snap);
  setTimeout(() => snap && render(snap), 1850);
}

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (api) api.openMenu();
});

$('attention').addEventListener('click', (e) => {
  if (api) api.follow(e.currentTarget.dataset.id);
});
$('connect').addEventListener('click', () => api && api.installHooks());

// Eyes follow the mouse pointer.
function onCursor({ x, y, zoom }) {
  if (!display.eyesFollow) return;
  const r = buddyEl.getBoundingClientRect();
  const cx = (r.left + r.width / 2) * zoom;
  const cy = (r.top + r.height * 0.55) * zoom;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy) || 1;
  const reach = Math.min(1, dist / 220);
  buddy.lookAt((dx / dist) * reach, (dy / dist) * reach);
}

// ---------- boot ----------

const demo = new URLSearchParams(location.search).get('demo');
// In demo mode the data is made up, but your display settings still apply.
let liveDisplay = null;
let lastDemo = null;
const renderDemo = (s) => {
  lastDemo = s;
  render(liveDisplay ? { ...s, display: liveDisplay } : s);
  if (s.demoChat && window.chatUI && !window.chatUI.isOpen()) window.chatUI.setOpen(true);
};
if (api) {
  if (!demo) api.onState(render);
  else {
    api.onState((s) => {
      const changed = JSON.stringify(s.display) !== JSON.stringify(liveDisplay);
      liveDisplay = s.display;
      if (changed && lastDemo) renderDemo(lastDemo);
    });
  }
  api.onCursor(onCursor);
}
if (!api || demo) {
  window.startDemo(renderDemo, demo && demo !== '1' && demo !== 'true' ? demo : null);
  if (!api) document.addEventListener('mousemove', (e) => onCursor({ x: e.clientX, y: e.clientY, zoom: 1 }));
}
