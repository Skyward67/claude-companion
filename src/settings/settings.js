'use strict';

const api = window.companion;
const $ = (id) => document.getElementById(id);

const COLORS = [
  ['Terracotta', '#e07b56'],
  ['Ocean', '#4f8fe0'],
  ['Mint', '#43b98a'],
  ['Lavender', '#9b7be0'],
  ['Rose', '#e06f9b'],
  ['Sunny', '#e8b33f'],
  ['Graphite', '#7d8790'],
];

let presets = [];
let display = {};

// ---------- tabs ----------

function showTab(name) {
  const tab = document.querySelector(`[data-tab="${name}"]`) ? name : 'display';
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('[data-panel]')) p.classList.toggle('active', p.dataset.panel === tab);
}
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
api.onTab(showTab);
showTab(new URLSearchParams(location.search).get('tab') || 'display');

// ---------- display & look (data-d controls) ----------

async function setDisplay(patch) {
  const all = await api.setSettings({ display: patch });
  renderDisplay(all.display);
}

function renderDisplay(d) {
  if (!d) return;
  display = d;
  for (const el of document.querySelectorAll('[data-d]')) {
    const key = el.dataset.d;
    if (document.activeElement === el && el.type !== 'checkbox') continue; // don't fight typing
    if (el.type === 'checkbox') el.checked = !!d[key];
    else el.value = String(d[key]);
  }
  // A sub-option only matters while its card is on.
  const dependents = { tokenMetric: 'showTokens', creditsMode: 'showCredits', crewSize: 'showCrew', bubbleSeconds: null };
  for (const [key, parent] of Object.entries(dependents)) {
    const el = document.querySelector(`[data-d="${key}"]`);
    if (el) el.disabled = parent ? !d[parent] : d.bubbleLevel === 'off';
  }
  $('opacity-val').textContent = `${Math.round(d.cardOpacity * 100)}%`;
  if (document.activeElement !== $('hiddenProjects')) $('hiddenProjects').value = (d.hiddenProjects || []).join(', ');

  for (const b of document.querySelectorAll('.preset')) b.classList.toggle('active', b.dataset.preset === d.preset);
  for (const s of document.querySelectorAll('.swatch')) s.classList.toggle('active', s.dataset.color === d.bodyColor);
  $('custom-color').value = d.bodyColor;
  $('logo').style.background = `radial-gradient(circle at 38% 32%, #ffffff55, ${d.bodyColor} 60%)`;
}

for (const el of document.querySelectorAll('[data-d]')) {
  const key = el.dataset.d;
  const read = () => (el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value);
  el.addEventListener(el.type === 'range' ? 'input' : 'change', () => setDisplay({ [key]: read() }));
}
$('hiddenProjects').addEventListener('change', (e) => setDisplay({ hiddenProjects: e.target.value }));

function buildPresets() {
  const box = $('presets');
  box.innerHTML = '';
  for (const p of [...presets, { id: 'custom', label: 'Custom', hint: 'Your own mix — change anything below.' }]) {
    const b = document.createElement('button');
    b.className = `preset${p.id === 'custom' ? ' custom' : ''}`;
    b.dataset.preset = p.id;
    b.innerHTML = '<b></b><span></span>';
    b.querySelector('b').textContent = p.label;
    b.querySelector('span').textContent = p.hint;
    if (p.id !== 'custom') b.addEventListener('click', () => setDisplay({ preset: p.id }));
    box.appendChild(b);
  }
}

function buildSwatches() {
  const box = $('swatches');
  box.innerHTML = '';
  for (const [name, color] of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = name;
    b.dataset.color = color;
    b.style.background = color;
    b.addEventListener('click', () => setDisplay({ bodyColor: color }));
    box.appendChild(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.id = 'custom-color';
  custom.title = 'Any colour';
  custom.addEventListener('input', () => setDisplay({ bodyColor: custom.value }));
  box.appendChild(custom);
}

for (const b of document.querySelectorAll('[data-reset]')) {
  b.addEventListener('click', async () => {
    const all = await api.setSettings({ display: 'reset' });
    renderDisplay(all.display);
  });
}

$('buddyName').addEventListener('input', (e) => {
  api.setSettings({ buddyName: e.target.value });
  $('title').textContent = e.target.value.trim() || 'Claude Companion';
});

// ---------- other settings ----------

async function load() {
  const current = await api.getSettings();
  const s = current.settings;
  presets = current.presets;
  buildPresets();
  buildSwatches();
  $('version').textContent = `v${current.version}`;
  for (const id of ['notifyOnDecision', 'notifyOnDone', 'alwaysOnTop', 'answerFromBuddy']) $(id).checked = !!s[id];
  $('terminal-cmd').textContent = current.terminalCommand;
  $('channels-live').textContent = current.channelsLive ? `${current.channelsLive} terminal session${current.channelsLive > 1 ? 's' : ''} connected` : '';
  $('claude-path').textContent = current.claudeFound || 'Not found — pick claude.exe';
  $('login').checked = !!current.loginItem;
  $('sleepAfterMin').value = s.sleepAfterMin;
  $('scale').value = String(s.scale);
  $('buddyName').value = s.buddyName || '';
  $('title').textContent = s.buddyName || 'Claude Companion';
  $('budget-amount').value = s.budget && s.budget.amount ? s.budget.amount : '';
  $('budget-period').value = (s.budget && s.budget.period) || 'none';
  renderDisplay(s.display);
  renderSetup(current.setup);
}

function renderSetup(setup) {
  if (!setup) return;
  const hooks = setup.hooks || {};
  const hp = $('hooks-pill');
  hp.textContent = hooks.installed ? (hooks.upToDate ? 'Connected' : 'Needs update') : 'Not connected';
  hp.className = `pill ${hooks.installed ? (hooks.upToDate ? 'on' : 'stale') : ''}`;
  const hb = $('hooks-btn');
  hb.textContent = hooks.installed ? (hooks.upToDate ? 'Disconnect' : 'Update') : 'Connect';
  hb.className = hooks.installed && hooks.upToDate ? '' : 'primary';
  hb.onclick = async () => {
    if (hooks.installed && hooks.upToDate) renderSetup(await api.uninstallHooks());
    else await api.installHooks();
    load();
  };

  const sl = setup.statusLine || {};
  const sp = $('sl-pill');
  sp.textContent = sl.installed ? 'On' : 'Off';
  sp.className = `pill ${sl.installed ? 'on' : ''}`;
  const sb = $('sl-btn');
  sb.textContent = sl.installed ? 'Turn off' : 'Turn on';
  sb.onclick = async () => {
    renderSetup(sl.installed ? await api.uninstallStatusLine() : await api.installStatusLine());
  };

  const err = $('server-error');
  err.hidden = !setup.serverError;
  err.textContent = setup.serverError ? `Event server problem: ${setup.serverError}. Hooks can't reach the app until this is fixed.` : '';
}

function save(patch) {
  api.setSettings(patch);
}

for (const id of ['notifyOnDecision', 'notifyOnDone', 'alwaysOnTop', 'answerFromBuddy']) {
  $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
}
$('copy-cmd').addEventListener('click', async () => {
  await api.copyTerminalCommand();
  $('copy-cmd').textContent = 'Copied ✓';
  setTimeout(() => ($('copy-cmd').textContent = 'Copy command'), 1800);
});
$('pick-claude').addEventListener('click', async () => {
  $('claude-path').textContent = (await api.pickClaude()) || 'Not found — pick claude.exe';
});
$('auto-claude').addEventListener('click', async () => {
  await api.setSettings({ claudePath: '' });
  load();
});
$('login').addEventListener('change', async (e) => {
  e.target.checked = await api.setLogin(e.target.checked);
});
$('sleepAfterMin').addEventListener('change', (e) => save({ sleepAfterMin: Math.max(1, Number(e.target.value) || 10) }));
$('scale').addEventListener('change', (e) => save({ scale: Number(e.target.value) }));
function saveBudget() {
  save({ budget: { period: $('budget-period').value, amount: Math.max(0, Number($('budget-amount').value) || 0) } });
}
$('budget-amount').addEventListener('change', saveBudget);
$('budget-period').addEventListener('change', saveBudget);
$('reveal').addEventListener('click', (e) => {
  e.preventDefault();
  api.revealClaudeSettings();
});

function renderDisplays(list) {
  const sel = $('display');
  sel.innerHTML = '';
  for (const d of list) {
    const opt = document.createElement('option');
    opt.value = String(d.id);
    opt.textContent = d.label;
    opt.selected = d.current;
    sel.appendChild(opt);
  }
  sel.disabled = list.length < 2;
}
$('display').addEventListener('change', async (e) => renderDisplays(await api.moveToDisplay(Number(e.target.value))));
// Screens can be plugged in or the buddy dragged while this window is open.
$('display').addEventListener('mousedown', async () => renderDisplays(await api.listDisplays()));
window.addEventListener('focus', async () => renderDisplays(await api.listDisplays()));
api.listDisplays().then(renderDisplays);

// Keep in sync with changes made from the buddy's right-click menu.
api.onState((s) => {
  renderSetup(s.setup);
  if (s.display && JSON.stringify(s.display) !== JSON.stringify(display)) renderDisplay(s.display);
  const b = s.credits && s.credits.budget;
  const today = s.usage ? s.usage.today.cost : 0;
  $('spend').textContent = b
    ? `Spent so far this period: $${b.spent.toFixed(2)} of $${b.amount} (${Math.round(b.pct)}%).`
    : `Estimated spend today across all sessions: $${today.toFixed(2)}.`;
});

load();
