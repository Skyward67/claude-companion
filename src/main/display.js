'use strict';

// What the widget shows and how it looks. The main process validates every
// change here; the renderer receives the result as-is.

const { validId, ACTIVITIES } = require('./characters');

// What the buddy can act out (Settings → Look → Activities). 'quirks' are the
// little things it does on its own while idle or thinking for a while.
const ACTIVITY_SWITCHES = [...ACTIVITIES, 'quirks'];

const DISPLAY_DEFAULTS = {
  preset: 'standard',
  // What's shown
  showTokens: true,
  tokenMetric: 'session', // session | output | today | context
  showCredits: true,
  creditsMode: 'auto', // auto | plan | budget | today | session
  showTasks: true,
  showCrew: true,
  crewSize: 4,
  showHelpers: true,
  showFooter: true,
  showCost: true,
  bubbleLevel: 'all', // all | important | decisions | off
  bubbleSeconds: 6,
  // Look
  character: 'buddy', // a character pack's folder name (see characters.js)
  bodyColor: '#e07b56',
  theme: 'dark', // dark | light
  cardOpacity: 0.9,
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
const LAYOUT_KEYS = ['showTokens', 'tokenMetric', 'showCredits', 'creditsMode', 'showTasks', 'showCrew', 'crewSize', 'showHelpers', 'showFooter', 'showCost', 'bubbleLevel', 'bubbleSeconds'];

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
  creditsMode: ['auto', 'plan', 'budget', 'today', 'session'],
  bubbleLevel: ['all', 'important', 'decisions', 'off'],
  theme: ['dark', 'light'],
  motion: ['full', 'reduced', 'off'],
  activityLevel: ['subtle', 'normal', 'lively'],
};
const RANGES = { crewSize: [1, 6], bubbleSeconds: [2, 30], cardOpacity: [0.4, 1], activeMinutes: [5, 24 * 60] };

function cleanValue(key, value) {
  const def = DISPLAY_DEFAULTS[key];
  if (CHOICES[key]) return CHOICES[key].includes(value) ? value : undefined;
  if (RANGES[key]) {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    const [lo, hi] = RANGES[key];
    return Math.min(hi, Math.max(lo, key === 'cardOpacity' ? Math.round(n * 100) / 100 : Math.round(n)));
  }
  if (key === 'bodyColor') return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toLowerCase() : undefined;
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

function presetList() {
  return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, hint: p.hint }));
}

module.exports = { DISPLAY_DEFAULTS, PRESETS, LAYOUT_KEYS, ACTIVITY_SWITCHES, normalizeDisplay, updateDisplay, presetList };
