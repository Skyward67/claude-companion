'use strict';

// Decides what the buddy acts out, on top of the mood Claude's status gives
// it. Tool calls are short and most of a turn is Claude writing, so a plain
// status says "thinking" nearly all the time. This keeps the buddy doing
// what Claude is most likely doing instead:
//   - while a tool runs, its activity: reading, searching, coding…
//   - for a moment after it, the same activity (Claude takes in the result)
//   - once Claude starts writing (a thinking or text block landed), typing,
//     or coding when the last thing it did was edit a file
//   - otherwise plain thinking, with a quirk now and then (looking around,
//     stretching) when it lasts, and when idle
// Settings → Look → Activities turns each one off, and sets how present
// they are. Loaded as a plain script in the widget, and by the tests.

(function (root) {
  const ACTIVITIES = ['typing', 'coding', 'reading', 'searching', 'running', 'browsing', 'planning'];
  const QUIRKS = ['look', 'stretch', 'scratch', 'hop', 'yawn'];
  const FOR_TOOL = { edit: 'coding', read: 'reading', search: 'searching', run: 'running', web: 'browsing', plan: 'planning' };
  // The tool an activity stands for, shown as act-* too so characters
  // without activities still show the right prop.
  const TOOL_FOR = { typing: null, coding: 'edit', reading: 'read', searching: 'search', running: 'run', browsing: 'web', planning: 'plan' };
  const QUIRKS_IN = { idle: ['look', 'stretch', 'hop', 'yawn'], thinking: ['look', 'scratch', 'stretch'] };
  const QUIRK_MS = 2400;
  // Writing that goes on longer than this is probably a turn we lost track of.
  const WRITING_MS = 3 * 60 * 1000;
  // How present activities are: how long one lingers after its tool, and how
  // often a quirk comes (a random wait between the two, in ms).
  const LEVELS = {
    subtle: { linger: 1000, quirkEvery: [45000, 90000] },
    normal: { linger: 4000, quirkEvery: [16000, 32000] },
    lively: { linger: 9000, quirkEvery: [7000, 15000] },
  };

  function levelOf(prefs) {
    return LEVELS[prefs && prefs.activityLevel] || LEVELS.normal;
  }

  function allowed(prefs, name) {
    return !!name && !!prefs && prefs.activities !== false && !(prefs.activitiesOff || []).includes(name);
  }

  // Claude's best-guess activity while its status says thinking.
  function guess(flow, level, now) {
    if (!flow) return null;
    if (flow.writingAt && now - flow.writingAt < WRITING_MS) return flow.tool === 'edit' ? 'coding' : 'typing';
    if (flow.tool && flow.toolAt && now - flow.toolAt < level.linger) return FOR_TOOL[flow.tool] || null;
    return null;
  }

  // facts: { mood, act, flow } from the session. Returns what to show:
  // { mood, act, activity }. An activity always shows as working.
  function activityFor(facts, prefs, now) {
    let { mood, act } = facts;
    let activity = null;
    if (mood === 'working') {
      if (allowed(prefs, FOR_TOOL[act])) activity = FOR_TOOL[act];
    } else if (mood === 'thinking') {
      const a = guess(facts.flow, levelOf(prefs), now);
      if (allowed(prefs, a)) {
        activity = a;
        mood = 'working';
        act = TOOL_FOR[a];
      }
    }
    return { mood, act: act || null, activity };
  }

  // One per buddy on screen, so each picks its own quirks at its own times.
  class Behavior {
    constructor(random = Math.random) {
      this.random = random;
      this.quirk = null;
      this.quirkUntil = 0;
      this.nextQuirkAt = 0;
      this.quirkMood = null;
      this.lastQuirk = null;
    }

    next(facts, prefs, now) {
      const shown = activityFor(facts, prefs, now);
      const quietly = !allowed(prefs, 'quirks') || (prefs && prefs.motion === 'off');
      shown.quirk = this.pickQuirk(shown.activity || quietly ? null : shown.mood, levelOf(prefs), now);
      return shown;
    }

    // A quirk starts after a random wait in a mood that has some, plays
    // once, and the wait starts again. Changing mood resets the wait.
    pickQuirk(mood, level, now) {
      const pool = QUIRKS_IN[mood];
      if (!pool) {
        this.quirkMood = null;
        this.quirk = null;
        return null;
      }
      if (mood !== this.quirkMood) {
        this.quirkMood = mood;
        this.quirk = null;
        this.nextQuirkAt = now + this.wait(level);
      }
      if (this.quirk && now >= this.quirkUntil) {
        this.quirk = null;
        this.nextQuirkAt = now + this.wait(level);
      }
      if (!this.quirk && now >= this.nextQuirkAt) {
        const choices = pool.filter((q) => q !== this.lastQuirk);
        this.quirk = choices[Math.floor(this.random() * choices.length)] || pool[0];
        this.lastQuirk = this.quirk;
        this.quirkUntil = now + QUIRK_MS;
      }
      return this.quirk;
    }

    wait(level) {
      const [lo, hi] = level.quirkEvery;
      return lo + this.random() * (hi - lo);
    }
  }

  const api = { ACTIVITIES, QUIRKS, TOOL_FOR, FOR_TOOL, LEVELS, QUIRK_MS, activityFor, Behavior };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Activity = api;
})(typeof window === 'object' ? window : globalThis);
