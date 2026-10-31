'use strict';

// What the widget shows and how it looks. The main process validates every
// change here; the renderer receives the result as-is.

const { validId, ACTIVITIES } = require('./characters');

// What the buddy can act out (Settings → Look → Activities). 'quirks' are the
// little things it does on its own while idle or thinking for a while.
const ACTIVITY_SWITCHES = [...ACTIVITIES, 'quirks'];

// The cards around the buddy, and where each one sits (Settings → Display →
// Arrangement). Left and right are narrow columns beside the buddy; above and
// below are rows across the widget. Within a place, panels keep this order,
// top to bottom.
const PANELS = ['tokens', 'credits', 'tasks', 'crew', 'footer'];
const PLACES = ['left', 'right', 'above', 'below'];
const DEFAULT_PANELS = [
  { id: 'tokens', place: 'left' },
  { id: 'credits', place: 'right' },
  { id: 'tasks', place: 'below' },
  { id: 'crew', place: 'below' },
  { id: 'footer', place: 'below' },
];

const DISPLAY_DEFAULTS = {
  preset: 'standard',
  // What's shown
  showTokens: true,
  tokenMetric: 'session', // session | output | today | context
  tokenStyle: 'number', // number | ring (a big ring that fills up to a limit)
  ringMetric: 'context', // context | fiveHour | sevenDay | budget
  ringSize: 'medium', // medium | large
  showCredits: true,
  creditsMode: 'auto', // auto | plan | budget | today | session
  showTasks: true,
  showCrew: true,
  crewSize: 4,
  showHelpers: true,
  helpersMax: 3,
  helpersSide: 'left', // left | right: which foot of the buddy they gather at
  showFooter: true,
  showCost: true,
  bubbleLevel: 'all', // all | important | decisions | off
  bubbleSeconds: 6,
  panels: DEFAULT_PANELS,
  // Look
  character: 'buddy', // a character pack's folder name (see characters.js)
  bodyColor: '#e07b56',
  theme: 'dark', // dark | light
  cardColor: '', // '' (the theme's) or #rrggbb
  accentColor: '', // '' (the theme's), 'buddy' (the body colour) or #rrggbb
  cardOpacity: 0.9,
  idleOpacity: 1, // the whole widget fades to this while nothing's happening
  motion: 'full', // full | reduced | off
  eyesFollow: true,
  activities: true, // act out what Claude is doing (typing, coding, reading…)
  activitiesOff: [], // ones turned off; a list, so new ones start on
  activityLevel: 'normal', // subtle | normal | lively
  // Which sessions count
  activeMinutes: 45,
  hiddenProjects: [],
};

// Keys a preset controls. Look and session filters are left alone.
// How cards look and where they sit are left alone too, like the look.
const LAYOUT_KEYS = ['showTokens', 'tokenMetric', 'showCredits', 'creditsMode', 'showTasks', 'showCrew', 'crewSize', 'showHelpers', 'helpersMax', 'showFooter', 'showCost', 'bubbleLevel', 'bubbleSeconds'];

const PRESETS = {
  standard: { label: 'Standard', hint: 'Everything at a glance.', values: {} },
  minimal: {
    label: 'Minimal',
    hint: 'Just the buddy and the important bubbles.',
    values: { showTokens: false, showCredits: false, showTasks: false, showCrew: false, showFooter: false, bubbleLevel: 'important' },
  },
  focus: {
    label: 'Focus',
    hint: 'Stay quiet until Claude needs a decision.',
    values: { showTokens: false, showCredits: false, showFooter: false, showHelpers: false, bubbleLevel: 'decisions' },
  },
  budget: {
    label: 'Budget watcher',
    hint: 'Today’s tokens and spend up front.',
    values: { tokenMetric: 'today', creditsMode: 'auto', showCost: true, showCrew: false, bubbleLevel: 'important' },
  },
  everything: { label: 'Everything', hint: 'All the data, the whole crew, every bubble.', values: { crewSize: 6, bubbleSeconds: 8 } },
};

const CHOICES = {
  tokenMetric: ['session', 'output', 'today', 'context'],
  tokenStyle: ['number', 'ring'],
  ringMetric: ['context', 'fiveHour', 'sevenDay', 'budget'],
  ringSize: ['medium', 'large'],
  helpersSide: ['left', 'right'],
  creditsMode: ['auto', 'plan', 'budget', 'today', 'session'],
  bubbleLevel: ['all', 'important', 'decisions', 'off'],
  theme: ['dark', 'light'],
  motion: ['full', 'reduced', 'off'],
  activityLevel: ['subtle', 'normal', 'lively'],
};
const RANGES = { crewSize: [1, 8], helpersMax: [1, 6], bubbleSeconds: [2, 30], cardOpacity: [0.1, 1], idleOpacity: [0.2, 1], activeMinutes: [5, 24 * 60] };
const FRACTIONS = ['cardOpacity', 'idleOpacity'];
const HEX = /^#[0-9a-f]{6}$/i;

// Every panel exactly once; one that's missing (new in this version, say)
// goes where it would by default.
function cleanPanels(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const p of value) {
    if (!p || !PANELS.includes(p.id) || out.some((q) => q.id === p.id)) continue;
    out.push({ id: p.id, place: PLACES.includes(p.place) ? p.place : DEFAULT_PANELS.find((q) => q.id === p.id).place });
  }
  for (const p of DEFAULT_PANELS) if (!out.some((q) => q.id === p.id)) out.push({ ...p });
  return out;
}

function cleanValue(key, value) {
  const def = DISPLAY_DEFAULTS[key];
  if (CHOICES[key]) return CHOICES[key].includes(value) ? value : undefined;
  if (RANGES[key]) {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    const [lo, hi] = RANGES[key];
    return Math.min(hi, Math.max(lo, FRACTIONS.includes(key) ? Math.round(n * 100) / 100 : Math.round(n)));
  }
  if (key === 'bodyColor') return HEX.test(String(value)) ? String(value).toLowerCase() : undefined;
  if (key === 'cardColor' || key === 'accentColor') {
    if (value === '' || (key === 'accentColor' && value === 'buddy')) return value;
    return HEX.test(String(value)) ? String(value).toLowerCase() : undefined;
  }
  if (key === 'panels') return cleanPanels(value);
  if (key === 'character') return validId(value) ? value : undefined;
  if (key === 'hiddenProjects') {
    const list = Array.isArray(value) ? value : String(value || '').split(',');
    return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))].slice(0, 50);
  }
  if (key === 'activitiesOff') return Array.isArray(value) ? ACTIVITY_SWITCHES.filter((a) => value.includes(a)) : undefined;
  if (typeof def === 'boolean') return !!value;
  return undefined;
}

function layoutOf(preset) {
  const values = {};
  for (const k of LAYOUT_KEYS) values[k] = k in preset.values ? preset.values[k] : DISPLAY_DEFAULTS[k];
  return values;
}

// The preset whose layout matches exactly, so toggling things back lands on
// the preset name again instead of "custom".
function matchingPreset(display) {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const layout = layoutOf(preset);
    if (LAYOUT_KEYS.every((k) => layout[k] === display[k])) return name;
  }
  return 'custom';
}

function normalizeDisplay(stored) {
  const out = { ...DISPLAY_DEFAULTS };
  for (const [k, v] of Object.entries(stored || {})) {
    if (!(k in DISPLAY_DEFAULTS) || k === 'preset') continue;
    const clean = cleanValue(k, v);
    if (clean !== undefined) out[k] = clean;
  }
  out.preset = matchingPreset(out);
  return out;
}

// Applies a (possibly partial, untrusted) patch. `{ preset: 'focus' }`
// switches presets; anything else edits individual values.
function updateDisplay(current, patch) {
  const base = normalizeDisplay(current);
  if (!patch || typeof patch !== 'object') return base;
  if (patch.preset && PRESETS[patch.preset]) return normalizeDisplay({ ...base, ...layoutOf(PRESETS[patch.preset]) });
  const next = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DISPLAY_DEFAULTS) || k === 'preset') continue;
    const clean = cleanValue(k, v);
    if (clean !== undefined) next[k] = clean;
  }
  return normalizeDisplay(next);
}

// The widget window is sized for 98px cards beside the buddy; a large ring
// card there needs a little more room.
const LARGE_RING_EXTRA = 24;
function extraWidth(display) {
  const d = normalizeDisplay(display);
  const place = d.panels.find((p) => p.id === 'tokens').place;
  const beside = place === 'left' || place === 'right';
  return d.showTokens && d.tokenStyle === 'ring' && d.ringSize === 'large' && beside ? LARGE_RING_EXTRA : 0;
}

function presetList() {
  return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, hint: p.hint }));
}

module.exports = { DISPLAY_DEFAULTS, PRESETS, LAYOUT_KEYS, ACTIVITY_SWITCHES, PANELS, PLACES, normalizeDisplay, updateDisplay, extraWidth, presetList };
