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

// Settings → Look → Card colour. Dark ones get the dark theme's text, light
// ones the light theme's (see pickColor).
const CARD_COLORS = [
  ['Midnight', '#1b2233'],
  ['Forest', '#1d2b23'],
  ['Plum', '#2b1f31'],
  ['Slate', '#2c3138'],
  ['Ink', '#121212'],
  ['Sky', '#e9f1fb'],
  ['Sage', '#e8f3ec'],
  ['Blush', '#fbecef'],
  ['Sand', '#f6eedf'],
];

// Settings → Display → Arrangement. Kept in step with PANELS and PLACES in
// main/display.js.
const PANEL_NAMES = { tokens: 'Tokens card', credits: 'Credits card', tasks: 'Task progress', crew: 'Other sessions', footer: 'Project & model line' };
const PANEL_SHOWN = { tokens: 'showTokens', credits: 'showCredits', tasks: 'showTasks', crew: 'showCrew', footer: 'showFooter' };
const PLACE_ORDER = ['above', 'left', 'right', 'below'];

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
let defaults = {};

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
  // A sub-option only matters while its card (or what it belongs to) is on.
  const ring = d.showTokens && d.tokenStyle === 'ring';
  const enabled = {
    tokenMetric: d.showTokens && !ring,
    tokenStyle: d.showTokens,
    ringMetric: ring,
    ringSize: ring,
    creditsMode: d.showCredits,
    crewSize: d.showCrew,
    helpersMax: d.showHelpers,
    helpersSide: d.showHelpers,
    activityLevel: d.activities,
    bubbleSeconds: d.bubbleLevel !== 'off',
  };
  for (const [key, on] of Object.entries(enabled)) {
    const el = document.querySelector(`[data-d="${key}"]`);
    if (el) el.disabled = !on;
  }
  for (const el of document.querySelectorAll('[data-activity]')) {
    el.checked = !(d.activitiesOff || []).includes(el.dataset.activity);
    el.disabled = !d.activities;
  }
  $('opacity-val').textContent = `${Math.round(d.cardOpacity * 100)}%`;
  $('idle-val').textContent = d.idleOpacity >= 1 ? 'Off' : `${Math.round(d.idleOpacity * 100)}%`;
  if (document.activeElement !== $('hiddenProjects')) $('hiddenProjects').value = (d.hiddenProjects || []).join(', ');

  for (const b of document.querySelectorAll('.preset')) b.classList.toggle('active', b.dataset.preset === d.preset);
  renderSwatches(d);
  renderArrangement(d);
  for (const logo of document.querySelectorAll('.logo')) logo.style.background = `radial-gradient(circle at 38% 32%, #ffffff55, ${d.bodyColor} 60%)`;
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

// ---------- colours ----------

// Relative luminance (as in WCAG): 0 is black, 1 is white.
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

function pickColor(key, value) {
  const patch = { [key]: value };
  // Light text on a light card (or the other way round) would be unreadable.
  if (key === 'cardColor' && value) patch.theme = luminance(value) > 0.4 ? 'light' : 'dark';
  setDisplay(patch);
}

// One row of colour buttons and a picker for any colour. `named` are extra
// choices shown as words, like "Theme" for the theme's own colour.
function buildSwatches(box, colors, named = []) {
  const key = box.dataset.key;
  box.innerHTML = '';
  for (const [label, value, title] of named) {
    const b = document.createElement('button');
    b.className = 'swatch named';
    b.textContent = label;
    b.title = title;
    b.dataset.value = value;
    b.addEventListener('click', () => pickColor(key, value));
    box.appendChild(b);
  }
  for (const [name, color] of colors) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = name;
    b.dataset.value = color;
    b.style.background = color;
    b.addEventListener('click', () => pickColor(key, color));
    box.appendChild(b);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'custom-color';
  custom.title = 'Any colour';
  custom.addEventListener('input', () => pickColor(key, custom.value));
  box.appendChild(custom);
}

function renderSwatches(d) {
  for (const box of document.querySelectorAll('.swatches[data-key]')) {
    const value = d[box.dataset.key];
    for (const s of box.querySelectorAll('.swatch')) s.classList.toggle('active', s.dataset.value === value);
    const picker = box.querySelector('.custom-color');
    if (picker && document.activeElement !== picker) picker.value = /^#[0-9a-f]{6}$/i.test(value) ? value : d.bodyColor;
  }
  const match = document.querySelector('#accent-swatches [data-value="buddy"]');
  if (match) match.style.setProperty('--dot', d.bodyColor);
}

// ---------- arrangement ----------

let dragging = null; // the panel being dragged on the arrangement map
let arrangedKey = '';

function renderArrangement(d) {
  if (dragging) return;
  const key = JSON.stringify([d.panels, Object.values(PANEL_SHOWN).map((k) => d[k])]);
  if (key === arrangedKey) return;
  arrangedKey = key;
  const focused = document.activeElement && document.activeElement.dataset.panel;
  for (const zone of document.querySelectorAll('.pzone')) zone.querySelector('.plist').innerHTML = '';
  for (const p of d.panels) {
    const chip = document.createElement('button');
    chip.className = `pchip${d[PANEL_SHOWN[p.id]] ? '' : ' off'}`;
    chip.textContent = PANEL_NAMES[p.id];
    chip.draggable = true;
    chip.dataset.panel = p.id;
    if (!d[PANEL_SHOWN[p.id]]) chip.title = 'Turned off in “What the buddy shows”';
    document.querySelector(`.pzone[data-place="${p.place}"] .plist`).appendChild(chip);
  }
  for (const zone of document.querySelectorAll('.pzone')) zone.classList.toggle('empty', !zone.querySelector('.pchip'));
  if (focused) document.querySelector(`.pchip[data-panel="${focused}"]`)?.focus();
  const crewPlace = document.querySelector('select[data-place="crew"]');
  crewPlace.value = d.panels.find((p) => p.id === 'crew').place;
  crewPlace.disabled = !d.showCrew;
}

// The map as it stands, in the order the widget reads it.
function readArrangement() {
  return PLACE_ORDER.flatMap((place) => [...document.querySelectorAll(`.pzone[data-place="${place}"] .pchip`)].map((c) => ({ id: c.dataset.panel, place })));
}

function saveArrangement(panels) {
  if (JSON.stringify(panels) !== JSON.stringify(display.panels)) setDisplay({ panels });
}

function movePanel(id, place) {
  saveArrangement([...display.panels.filter((p) => p.id !== id), { id, place }]);
}

const arrangeEl = $('arrange');
arrangeEl.addEventListener('dragstart', (e) => {
  dragging = e.target.closest('.pchip');
  if (!dragging) return;
  dragging.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragging.dataset.panel);
});
arrangeEl.addEventListener('dragover', (e) => {
  const list = dragging && e.target.closest('.pzone')?.querySelector('.plist');
  if (!list) return;
  e.preventDefault();
  // Live preview: the panel slides to where it would land.
  const before = [...list.querySelectorAll('.pchip:not(.dragging)')].find((c) => {
    const r = c.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });
  if (before !== dragging.nextSibling || dragging.parentElement !== list) list.insertBefore(dragging, before || null);
  for (const zone of arrangeEl.querySelectorAll('.pzone')) zone.classList.toggle('over', zone.contains(list));
});
arrangeEl.addEventListener('drop', (e) => e.preventDefault());
arrangeEl.addEventListener('dragend', () => {
  if (!dragging) return;
  dragging.classList.remove('dragging');
  dragging = null;
  for (const zone of arrangeEl.querySelectorAll('.pzone')) zone.classList.remove('over');
  // The map already shows the result; the saved settings redraw it.
  arrangedKey = '';
  saveArrangement(readArrangement());
});
arrangeEl.addEventListener('keydown', (e) => {
  const chip = e.target.closest('.pchip');
  if (!chip) return;
  const panels = readArrangement();
  const i = panels.findIndex((p) => p.id === chip.dataset.panel);
  const p = panels[i];
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // Swap with the neighbour in the same place.
    const step = e.key === 'ArrowUp' ? -1 : 1;
    let j = i + step;
    while (panels[j] && panels[j].place !== p.place) j += step;
    if (!panels[j]) return;
    [panels[i], panels[j]] = [panels[j], panels[i]];
    saveArrangement(panels);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const k = PLACE_ORDER.indexOf(p.place) + (e.key === 'ArrowLeft' ? -1 : 1);
    if (k < 0 || k >= PLACE_ORDER.length) return;
    movePanel(p.id, PLACE_ORDER[k]);
  } else {
    return;
  }
  e.preventDefault();
});
document.querySelector('select[data-place="crew"]').addEventListener('change', (e) => movePanel('crew', e.target.value));
$('arrange-reset').addEventListener('click', () => setDisplay({ panels: defaults.panels }));

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
  defaults = current.displayDefaults;
  buildPresets();
  buildSwatches($('swatches'), COLORS);
  buildSwatches($('card-swatches'), CARD_COLORS, [['Theme', '', 'The theme’s own colour']]);
  buildSwatches($('accent-swatches'), COLORS, [
    ['Theme', '', 'The theme’s own accent'],
    ['Buddy', 'buddy', 'Same colour as the buddy'],
  ]);
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
