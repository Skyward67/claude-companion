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

// Settings → Look → Activities, in the order shown. Kept in step with
// ACTIVITY_SWITCHES in main/display.js.
const ACTIVITIES = [
  ['typing', 'Typing a reply'],
  ['coding', 'Coding'],
  ['reading', 'Reading files'],
  ['searching', 'Searching'],
  ['running', 'Running commands'],
  ['browsing', 'Browsing the web'],
  ['planning', 'Planning'],
  ['quirks', 'Little quirks'],
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
  const dependents = { tokenMetric: 'showTokens', creditsMode: 'showCredits', crewSize: 'showCrew', activityLevel: 'activities', bubbleSeconds: null };
  for (const [key, parent] of Object.entries(dependents)) {
    const el = document.querySelector(`[data-d="${key}"]`);
    if (el) el.disabled = parent ? !d[parent] : d.bubbleLevel === 'off';
  }
  for (const el of document.querySelectorAll('[data-activity]')) {
    el.checked = !(d.activitiesOff || []).includes(el.dataset.activity);
    el.disabled = !d.activities;
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

function buildActivities() {
  const box = $('activity-list');
  box.innerHTML = '';
  for (const [id, label] of ACTIVITIES) {
    const row = document.createElement('label');
    row.className = 'check';
    row.innerHTML = '<input type="checkbox" /><span></span>';
    row.querySelector('input').dataset.activity = id;
    row.querySelector('span').textContent = label;
    row.querySelector('input').addEventListener('change', () => {
      const off = [...box.querySelectorAll('[data-activity]')].filter((el) => !el.checked).map((el) => el.dataset.activity);
      setDisplay({ activitiesOff: off });
    });
    box.appendChild(row);
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

// ---------- character ----------

let characterInfo = { list: [], selected: 'buddy', status: null };
let charactersRev = -1;

function renderCharacters(info) {
  if (!info || !info.list) return;
  characterInfo = info;
  const box = $('characters');
  box.innerHTML = '';
  for (const c of info.list) {
    const b = document.createElement('button');
    b.className = `preset character${c.id === info.selected ? ' active' : ''}${c.error ? ' broken' : ''}`;
    b.innerHTML = '<b></b><span class="by"></span><span class="what"></span>';
    b.querySelector('b').textContent = c.name;
    b.querySelector('.by').textContent = [c.builtIn ? 'Built in' : c.id, c.author && `by ${c.author}`].filter(Boolean).join(' · ');
    b.querySelector('.what').textContent = c.error ? `⚠ ${c.error}` : c.description;
    b.title = c.folder;
    b.addEventListener('click', () => setDisplay({ character: c.id }).then(refreshCharacters));
    box.appendChild(b);
  }
  const current = info.list.find((c) => c.id === info.selected);
  $('char-copy').disabled = !current;
  $('char-folder').textContent = current && !current.builtIn ? 'Open its folder' : 'Open characters folder';
  // Colour only applies to characters drawn with the --body colours.
  const colorable = !current || current.colorable;
  $('color-note').hidden = colorable;
  for (const el of $('swatches').children) el.disabled = !colorable;
  renderCharacterStatus(info.status);
}

function renderCharacterStatus(status) {
  const el = $('char-status');
  const mine = status && status.id === characterInfo.selected;
  const problem = mine && !status.ok ? `⚠ ${status.error.replace(/\.?$/, '.')} ${status.fallback ? 'It shows up once that’s fixed.' : 'The last version that worked stays up until it’s fixed.'}` : '';
  const lines = mine ? [problem, ...(status.warnings || [])].filter(Boolean) : [];
  el.hidden = !lines.length;
  el.className = `char-status${mine && !status.ok ? ' bad' : ''}`;
  el.textContent = '';
  for (const line of lines) {
    const p = document.createElement('div');
    p.textContent = line;
    el.appendChild(p);
  }
}

async function refreshCharacters() {
  renderCharacters(await api.listCharacters());
}

async function characterAction(run) {
  const r = await run();
  renderCharacters(r);
  if (r && r.error) {
    const el = $('char-status');
    el.hidden = false;
    el.className = 'char-status bad';
    el.textContent = `⚠ ${r.error}`;
  }
}

$('char-copy').addEventListener('click', () => characterAction(() => api.copyCharacter(characterInfo.selected)));
$('char-import').addEventListener('click', () => characterAction(() => api.importCharacter()));
$('char-folder').addEventListener('click', () => api.openCharacterFolder(characterInfo.selected));
$('char-preview').addEventListener('change', (e) => api.setPreview(e.target.value || null));
$('char-guide').addEventListener('click', (e) => {
  e.preventDefault();
  api.openCharacterGuide();
});

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
  buildActivities();
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
  refreshCharacters();
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
  // Pack files changed on disk: names, descriptions or errors may have too.
  if (s.characters) {
    if (s.characters.rev !== charactersRev || (s.display && s.display.character !== characterInfo.selected)) {
      charactersRev = s.characters.rev;
      refreshCharacters();
    } else if (JSON.stringify(s.characters.status) !== JSON.stringify(characterInfo.status)) {
      characterInfo.status = s.characters.status;
      renderCharacterStatus(s.characters.status);
    }
  }
  const b = s.credits && s.credits.budget;
  const today = s.usage ? s.usage.today.cost : 0;
  $('spend').textContent = b
    ? `Spent so far this period: $${b.spent.toFixed(2)} of $${b.amount} (${Math.round(b.pct)}%).`
    : `Estimated spend today across all sessions: $${today.toFixed(2)}.`;
});

load();
