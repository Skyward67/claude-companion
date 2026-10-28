'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeDisplay } = require('./display');

const DEFAULTS = {
  port: 47821,
  position: null, // { x, y }
  scale: 1,
  alwaysOnTop: true,
  notifyOnDecision: true,
  notifyOnDone: false,
  sleepAfterMin: 10,
  buddyName: '',
  display: null, // see display.js
  answerFromBuddy: true, // hold VS Code/Desktop permission prompts so the buddy can answer
  claudePath: '', // Claude Code executable for buddy chats ('' = find it)
  lastChatDir: '',
  buddyChats: [], // [{ id, cwd }] chats the buddy started
  budget: { period: 'none', amount: 0 }, // period: none | 5h | day | week | month
  statusLineChain: null, // the user's previous statusLine, restored on uninstall
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    let loaded = {};
    try {
      loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      Object.assign(this.data, loaded);
    } catch {
      // First run or unreadable file: keep defaults.
    }
    // Older versions had a single on/off switch for bubbles.
    const legacy = loaded.bubbles === false ? { bubbleLevel: 'off' } : {};
    delete this.data.bubbles;
    this.data.display = normalizeDisplay({ ...legacy, ...(loaded.display || {}) });
    this.listeners = [];
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return { ...this.data };
  }

  set(patch) {
    Object.assign(this.data, patch);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('Could not save settings:', err.message);
    }
    for (const fn of this.listeners) fn(patch, this.data);
  }

  onChange(fn) {
    this.listeners.push(fn);
  }
}

module.exports = { Settings, DEFAULTS };
