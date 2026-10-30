'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { activityFor, Behavior, QUIRK_MS, LEVELS } = require('../src/renderer/activity');
const characters = require('../src/main/characters');
const { updateDisplay, ACTIVITY_SWITCHES } = require('../src/main/display');

const NOW = 1_000_000;
const ON = { activities: true, activitiesOff: [], activityLevel: 'normal', motion: 'full' };

test('activities match the ones characters and settings know', () => {
  const { ACTIVITIES, QUIRKS } = require('../src/renderer/activity');
  assert.deepEqual(ACTIVITIES, characters.ACTIVITIES);
  assert.deepEqual(QUIRKS, characters.QUIRKS);
  assert.deepEqual(ACTIVITY_SWITCHES, [...characters.ACTIVITIES, 'quirks']);
});

test('a running tool is acted out, other moods are left alone', () => {
  assert.deepEqual(activityFor({ mood: 'working', act: 'edit' }, ON, NOW), { mood: 'working', act: 'edit', activity: 'coding' });
  assert.deepEqual(activityFor({ mood: 'working', act: 'read' }, ON, NOW), { mood: 'working', act: 'read', activity: 'reading' });
  // Helpers and other tools keep their prop.
  assert.equal(activityFor({ mood: 'working', act: 'agent' }, ON, NOW).activity, null);
  assert.equal(activityFor({ mood: 'working', act: 'tool' }, ON, NOW).activity, null);
  for (const mood of ['idle', 'waiting', 'done', 'error', 'sleeping', 'compacting', 'pet']) {
    assert.deepEqual(activityFor({ mood, act: 'ask', flow: { tool: 'edit', toolAt: NOW, writingAt: NOW } }, ON, NOW), { mood, act: 'ask', activity: null }, mood);
  }
});

test('while thinking, the buddy keeps at what Claude was doing', () => {
  const thinking = (flow, now = NOW) => activityFor({ mood: 'thinking', act: null, flow }, ON, now);
  // Just got the prompt: plain thinking.
  assert.deepEqual(thinking({ tool: null, toolAt: 0, writingAt: 0 }), { mood: 'thinking', act: null, activity: null });
  assert.deepEqual(thinking(null), { mood: 'thinking', act: null, activity: null });
  // Thinking done, now writing: a reply, or code after an edit.
  assert.deepEqual(thinking({ tool: null, toolAt: 0, writingAt: NOW - 2000 }), { mood: 'working', act: null, activity: 'typing' });
  assert.deepEqual(thinking({ tool: 'read', toolAt: NOW - 9000, writingAt: NOW - 2000 }).activity, 'typing');
  assert.deepEqual(thinking({ tool: 'edit', toolAt: NOW - 9000, writingAt: NOW - 2000 }), { mood: 'working', act: 'edit', activity: 'coding' });
  // Writing for ages means we lost track.
  assert.equal(thinking({ tool: null, toolAt: 0, writingAt: NOW - 4 * 60_000 }).activity, null);
  // Right after a tool, its activity lingers, then thinking again.
  assert.deepEqual(thinking({ tool: 'search', toolAt: NOW - 1000, writingAt: 0 }), { mood: 'working', act: 'search', activity: 'searching' });
  assert.equal(thinking({ tool: 'search', toolAt: NOW - LEVELS.normal.linger - 1, writingAt: 0 }).activity, null);
  assert.equal(thinking({ tool: 'agent', toolAt: NOW - 100, writingAt: 0 }).activity, null);
});

test('settings turn activities off, one by one or all at once', () => {
  const writing = { mood: 'thinking', act: null, flow: { tool: 'edit', toolAt: NOW - 3000, writingAt: NOW - 500 } };
  assert.equal(activityFor(writing, { ...ON, activitiesOff: ['coding'] }, NOW).activity, null);
  assert.equal(activityFor(writing, { ...ON, activitiesOff: ['coding'] }, NOW).mood, 'thinking');
  assert.equal(activityFor(writing, { ...ON, activitiesOff: ['typing'] }, NOW).activity, 'coding');
  // Off entirely: exactly the plain mood and tool.
  assert.deepEqual(activityFor(writing, { ...ON, activities: false }, NOW), { mood: 'thinking', act: null, activity: null });
  assert.deepEqual(activityFor({ mood: 'working', act: 'read' }, { ...ON, activities: false }, NOW), { mood: 'working', act: 'read', activity: null });
  // A tool still shows its prop when its activity is off.
  assert.deepEqual(activityFor({ mood: 'working', act: 'read' }, { ...ON, activitiesOff: ['reading'] }, NOW), { mood: 'working', act: 'read', activity: null });
  // Subtle: barely lingers. Lively: lingers a while.
  const after = { mood: 'thinking', act: null, flow: { tool: 'read', toolAt: NOW - 3000, writingAt: 0 } };
  assert.equal(activityFor(after, { ...ON, activityLevel: 'subtle' }, NOW).activity, null);
  assert.equal(activityFor(after, { ...ON, activityLevel: 'normal' }, NOW).activity, 'reading');
  assert.equal(activityFor({ ...after, flow: { ...after.flow, toolAt: NOW - 8000 } }, { ...ON, activityLevel: 'lively' }, NOW).activity, 'reading');
});

test('quirks come now and then while idle or thinking, never twice in a row', () => {
  const b = new Behavior(() => 0); // always the shortest wait and the first choice
  const idle = { mood: 'idle', act: null };
  const wait = LEVELS.normal.quirkEvery[0];
  assert.equal(b.next(idle, ON, NOW).quirk, null);
  assert.equal(b.next(idle, ON, NOW + wait - 1).quirk, null);
  const first = b.next(idle, ON, NOW + wait).quirk;
  assert.ok(first);
  assert.equal(b.next(idle, ON, NOW + wait + QUIRK_MS - 1).quirk, first, 'plays for a while');
  const end = NOW + wait + QUIRK_MS;
  assert.equal(b.next(idle, ON, end).quirk, null, 'then stops');
  const second = b.next(idle, ON, end + wait).quirk;
  assert.ok(second && second !== first);

  // A new mood starts the wait again; working, waiting and sleeping get none.
  assert.equal(b.next({ mood: 'thinking', act: null }, ON, end + wait + 1).quirk, null);
  assert.ok(['look', 'scratch', 'stretch'].includes(b.next({ mood: 'thinking', act: null }, ON, end + 2 * wait + 1).quirk));
  for (const mood of ['working', 'waiting', 'sleeping', 'done']) assert.equal(new Behavior(() => 0).next({ mood, act: null }, ON, NOW + 10 * wait).quirk, null, mood);

  // Off: with quirks switched off, with all activities off, or when nothing may move.
  for (const prefs of [{ ...ON, activitiesOff: ['quirks'] }, { ...ON, activities: false }, { ...ON, motion: 'off' }]) {
    const quiet = new Behavior(() => 0);
    quiet.next(idle, prefs, NOW);
    assert.equal(quiet.next(idle, prefs, NOW + 10 * wait).quirk, null, JSON.stringify(prefs));
  }
});

test('activity settings are validated', () => {
  let d = updateDisplay({}, {});
  assert.equal(d.activities, true);
  assert.deepEqual(d.activitiesOff, []);
  assert.equal(d.activityLevel, 'normal');
  d = updateDisplay(d, { activities: false, activitiesOff: ['quirks', 'typing', 'dancing', 'typing'], activityLevel: 'hyper' });
  assert.equal(d.activities, false);
  assert.deepEqual(d.activitiesOff, ['typing', 'quirks'], 'known ones, once, in a fixed order');
  assert.equal(d.activityLevel, 'normal');
  assert.deepEqual(updateDisplay(d, { activitiesOff: 'typing' }).activitiesOff, ['typing', 'quirks'], 'not a list: unchanged');
  assert.equal(updateDisplay(d, { activityLevel: 'lively' }).activityLevel, 'lively');
  assert.equal(updateDisplay(d, { activityLevel: 'lively' }).preset, 'standard', 'not part of the layout presets');
});
