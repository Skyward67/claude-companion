'use strict';

// Adds/removes Claude Code hooks and the optional status-line bridge in
// ~/.claude/settings.json. Everything we add carries MARK so it can be found
// and removed again without touching the user's own entries.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARK = 'claude-companion';

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'TaskCompleted',
];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function settingsPath() {
  return path.join(claudeDir(), 'settings.json');
}

function readSettings(file = settingsPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Can't read ${file}: ${err.message}`);
  }
}

function writeSettings(data, file = settingsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.companion-backup`);
  const tmp = `${file}.companion-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// curl ships with Windows 10+, macOS and most Linux distros, so hooks need no
// extra runtime. `; exit 0` keeps a closed companion from showing hook errors.
function hookCommand(port, platform = process.platform) {
  const curl = platform === 'win32' ? 'curl.exe' : 'curl';
  return `${curl} -s -m 2 -X POST -H "Content-Type: application/json" --data-binary "@-" "http://127.0.0.1:${port}/hook?src=${MARK}" ; exit 0`;
}

// PermissionRequest runs synchronously: the buddy may hold the request while
// you decide, and curl prints its JSON answer for Claude Code to apply. An
// empty reply (or a closed buddy) leaves the normal permission flow alone.
const DECIDE_TIMEOUT_S = 3600;
function decideCommand(port, platform = process.platform) {
  const curl = platform === 'win32' ? 'curl.exe' : 'curl';
  return `${curl} -s -m ${DECIDE_TIMEOUT_S - 10} -X POST -H "Content-Type: application/json" --data-binary "@-" "http://127.0.0.1:${port}/decide?src=${MARK}" ; exit 0`;
}

function handlerFor(event, port, platform) {
  if (event === 'PermissionRequest') return { type: 'command', command: decideCommand(port, platform), timeout: DECIDE_TIMEOUT_S };
  return { type: 'command', command: hookCommand(port, platform), async: true, timeout: 5 };
}

function hooksBlock(port, platform, events = HOOK_EVENTS) {
  const hooks = {};
  for (const event of events) {
    const handler = handlerFor(event, port, platform);
    hooks[event] = [TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] }];
  }
  return hooks;
}

// Settings passed with --settings to chats the buddy runs itself. When your
// global hooks are already installed they report events, so only the
// decision hook is added (needed: headless sessions deny unanswered prompts).
function buddyChatSettings(port, { globalHooks }) {
  return { hooks: hooksBlock(port, process.platform, globalHooks ? ['PermissionRequest'] : HOOK_EVENTS) };
}

function isOurs(handler) {
  return handler && typeof handler.command === 'string' && handler.command.includes(MARK);
}

function stripOurHooks(settings) {
  if (!settings.hooks) return settings;
  for (const event of Object.keys(settings.hooks)) {
    const groups = (settings.hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (groups.length) settings.hooks[event] = groups;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function withHooks(settings, port, platform) {
  const out = stripOurHooks(JSON.parse(JSON.stringify(settings)));
  out.hooks = out.hooks || {};
  for (const [event, groups] of Object.entries(hooksBlock(port, platform))) {
    out.hooks[event] = [...(out.hooks[event] || []), ...groups];
  }
  return out;
}

function hooksStatus(port) {
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    return { installed: false, error: err.message, file: settingsPath() };
  }
  const commands = [];
  let decide = false;
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const g of groups || []) {
      for (const h of g.hooks || []) {
        if (!isOurs(h)) continue;
        commands.push(h.command);
        if (event === 'PermissionRequest' && h.command.includes('/decide') && !h.async) decide = true;
      }
    }
  }
  return {
    installed: commands.length > 0,
    // Older installs used an async PermissionRequest hook and can't answer prompts.
    upToDate: decide && commands.length >= HOOK_EVENTS.length && commands.every((c) => c.includes(`:${port}/`)),
    file: settingsPath(),
  };
}

function installHooks(port) {
  writeSettings(withHooks(readSettings(), port));
}

function uninstallHooks() {
  writeSettings(stripOurHooks(readSettings()));
}

// ---- status line bridge (claude.ai plan limits) ---------------------------

function bridgeScript() {
  // When packaged, scripts live in app.asar.unpacked.
  return path.join(__dirname, '..', '..', 'bridge', 'statusline.js').replace('app.asar', 'app.asar.unpacked');
}

function statusLineCommand(port, chain) {
  let cmd = `node "${bridgeScript()}" --port ${port} --tag ${MARK}`;
  if (chain) cmd += ` --chain ${Buffer.from(chain, 'utf8').toString('base64')}`;
  return cmd;
}

function statusLineStatus() {
  try {
    const sl = readSettings().statusLine;
    return { installed: !!(sl && isOurs(sl)), other: !!(sl && !isOurs(sl)) };
  } catch {
    return { installed: false, other: false };
  }
}

// Returns the previous statusLine so it can be restored later.
function installStatusLine(port) {
  const settings = readSettings();
  const prev = settings.statusLine && !isOurs(settings.statusLine) ? settings.statusLine : null;
  const chain = prev && prev.type === 'command' ? prev.command : null;
  settings.statusLine = { type: 'command', command: statusLineCommand(port, chain), padding: prev ? prev.padding : 0 };
  if (prev && prev.refreshInterval) settings.statusLine.refreshInterval = prev.refreshInterval;
  writeSettings(settings);
  return prev;
}

function uninstallStatusLine(previous) {
  const settings = readSettings();
  if (settings.statusLine && isOurs(settings.statusLine)) {
    if (previous) settings.statusLine = previous;
    else delete settings.statusLine;
    writeSettings(settings);
  }
}

module.exports = {
  MARK,
  HOOK_EVENTS,
  claudeDir,
  settingsPath,
  hookCommand,
  decideCommand,
  buddyChatSettings,
  withHooks,
  stripOurHooks,
  hooksStatus,
  installHooks,
  uninstallHooks,
  statusLineStatus,
  installStatusLine,
  uninstallStatusLine,
};
