'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, Notification, dialog, shell, clipboard } = require('electron');
const { Settings } = require('./settings');
const { Store } = require('./store');
const { TranscriptWatcher } = require('./transcripts');
const { startHookServer } = require('./hookServer');
const claudeConfig = require('./claudeConfig');
const { drawTrayIcon } = require('./trayIcon');
const { updateDisplay, presetList, DISPLAY_DEFAULTS } = require('./display');
const { Decisions } = require('./decisions');
const { Channels } = require('./channels');
const { BuddyChats, findClaudeExecutable } = require('./buddyChats');
const characters = require('./characters');

const CHARACTER_GUIDE = 'https://github.com/Skyward67/claude-companion/blob/main/docs/characters.md';

const argv = process.argv.slice(1);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const DEBUG = !!flag('verbose');
const DEMO = flag('demo');
const SNAPSHOT = flag('snapshot');

const WIN_W = 360;
const WIN_H = 640; // tall enough for the chat panel; the empty part lets clicks through
const SCALES = { Small: 0.8, Normal: 1, Large: 1.25 };

let settings;
let store;
let watcher;
let decisions;
let channels;
let buddyChats;
let chatOpen = false;
let win = null;
let settingsWin = null;
let tray = null;
let serverError = null;
let setup = { hooks: { installed: false }, statusLine: { installed: false } };
let trayMood = null;
let quitting = false;
let character = null; // the pack the widget shows (characters.js)
let characterStatus = null; // { id, ok, error, warnings } for the chosen pack, shown in Settings
let charactersRev = 0; // bumped when pack files change, so Settings refreshes its list
let stopWatchingCharacters = () => {};
let preview = null; // a mood Settings shows on the buddy instead of the live one

// Keep settings in the same folder whether run from source or installed
// (Electron would otherwise name it after productName in packaged builds).
// `--user-data=<dir>` runs with a separate folder, e.g. to try things out.
app.setPath('userData', typeof flag('user-data') === 'string' ? path.resolve(flag('user-data')) : path.join(app.getPath('appData'), 'claude-companion'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching again focuses the running buddy; `--screen=2` also moves it.
  app.on('second-instance', (_e, args) => {
    const n = Number((args.find((a) => a.startsWith('--screen=')) || '').slice('--screen='.length));
    const target = screen.getAllDisplays()[n - 1];
    if (target) moveToDisplay(target.id);
    else showWidget();
  });
  app.whenReady().then(boot);
}

async function boot() {
  app.setAppUserModelId('dev.claude-companion');
  settings = new Settings(app.getPath('userData'));
  // Dev: try display variants without saving them, e.g. `--preset=minimal`
  // or `--display={"theme":"light"}`.
  if (typeof flag('preset') === 'string') settings.data.display = updateDisplay(settings.get('display'), { preset: flag('preset') });
  if (typeof flag('scale') === 'string') settings.data.scale = Number(flag('scale')) || 1;
  if (typeof flag('display') === 'string') {
    try {
      settings.data.display = updateDisplay(settings.get('display'), JSON.parse(flag('display')));
    } catch {
      console.error('--display must be JSON');
    }
  }
  store = new Store({ settings });
  decisions = new Decisions();
  decisions.on('change', () => (store.dirty = true));
  channels = new Channels({ store, decisions });
  buddyChats = new BuddyChats({ settings, findClaude, settingsFile: writeBuddyChatSettings });
  buddyChats.on('change', () => (store.dirty = true));
  store.isOwned = (id) => buddyChats.owns(id);

  try {
    fs.mkdirSync(charactersDir(), { recursive: true });
  } catch (err) {
    console.error('Could not create the characters folder:', err.message);
  }
  loadCharacter();
  // Built-in packs are only edited when running from source.
  stopWatchingCharacters = characters.watchCharacters([charactersDir(), ...(app.isPackaged ? [] : [characters.BUILT_IN_DIR])], onCharacterFiles);

  watcher = new TranscriptWatcher(path.join(claudeConfig.claudeDir(), 'projects'));
  watcher.on('entries', (id, entries, meta) => store.onTranscriptEntries(id, entries, meta));
  watcher.scan(store.windowStart());
  watcher.poll();

  try {
    await startHookServer({
      port: settings.get('port'),
      onHook,
      onDecide,
      onStatusLine: (data) => {
        if (data.transcript_path) watcher.track(data.transcript_path, data.session_id);
        store.onStatusLine(data);
      },
      channel: channels,
      getState: () => store.snapshot(),
    });
  } catch (err) {
    serverError = err.code === 'EADDRINUSE' ? `Port ${settings.get('port')} is already in use` : err.message;
    console.error('Hook server failed:', serverError);
  }

  store.on('attention', (s) => notify('decision', s));
  store.on('done', (s) => notify('done', s));

  refreshSetup();
  createWidget();
  createTray();

  every(1000, () => watcher.poll());
  every(10000, () => watcher.scan(store.windowStart()));
  every(15000, refreshSetup);
  every(1000, () => store.tick());
  let lastPush = 0;
  every(200, () => {
    if (store.dirty || Date.now() - lastPush > 1000) {
      store.dirty = false;
      lastPush = Date.now();
      push();
    }
  });
  every(80, trackCursor);
  every(5000, keepOnTop);

  if (flag('settings')) openSettings(typeof flag('settings') === 'string' ? flag('settings') : undefined);
  if (DEBUG) every(5000, () => console.log(JSON.stringify(summary(store.snapshot()))));
  if (typeof SNAPSHOT === 'string') {
    setTimeout(async () => {
      const target = flag('settings') ? settingsWin : win;
      if (flag('snapshot-bottom')) await target.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
      const img = await target.webContents.capturePage();
      fs.writeFileSync(SNAPSHOT, img.toPNG());
      console.log('snapshot written', SNAPSHOT);
      if (flag('exit')) {
        stopTimers();
        app.exit(0);
      }
    }, Number(flag('snapshot-delay')) || 3500);
  }
}

// Timers are stopped before quitting; otherwise they can fire after the
// widget window is destroyed and throw "Object has been destroyed".
const timers = [];
function every(ms, fn) {
  timers.push(setInterval(fn, ms));
}
function stopTimers() {
  for (const t of timers.splice(0)) clearInterval(t);
  endDrag();
}

function alive(w) {
  return !!w && !w.isDestroyed();
}

// ---- events, decisions & chat ---------------------------------------------

// Events that mean a pending prompt was answered somewhere else (Claude's own
// dialog, the terminal), so a held decision hook should let go.
const RESOLVING = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);
const ENDING = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd']);

function onHook(ev) {
  if (DEBUG) console.log('[hook]', ev.hook_event_name, ev.tool_name || ev.notification_type || '');
  if (ev.transcript_path) watcher.track(ev.transcript_path, ev.session_id);
  store.onHook(ev);
  if (RESOLVING.has(ev.hook_event_name)) decisions.releaseSession(ev.session_id, ev.tool_name);
  else if (ENDING.has(ev.hook_event_name)) decisions.releaseSession(ev.session_id);
}

// The synchronous PermissionRequest hook. VS Code and Claude Desktop keep
// their own prompt open alongside hooks (whichever answers first wins), so we
// hold the request and show buttons. Terminal prompts wait for hooks, so we
// answer at once and leave them to the terminal (or its channel). Chats the
// buddy runs have no other UI, so we always hold those.
function onDecide(ev, res) {
  if (ev.transcript_path) {
    watcher.track(ev.transcript_path, ev.session_id);
    watcher.poll(); // learn where the session runs before deciding
  }
  onHook(ev);
  const s = store.sessions.get(ev.session_id);
  const source = s ? store.sourceOf(s) : '';
  const owned = source === 'buddy';
  const hold = owned || (settings.get('answerFromBuddy') && (source === 'vscode' || source === 'desktop'));
  if (!hold) {
    res.writeHead(204).end();
    return;
  }
  decisions.fromHook(ev, res, { holdMs: (owned ? 59 : 30) * 60 * 1000 });
}

function findClaude() {
  return findClaudeExecutable(settings.get('claudePath'));
}

// Settings file handed to buddy chats with --settings (hooks for that chat).
function writeBuddyChatSettings() {
  const file = path.join(app.getPath('userData'), 'buddy-chat-settings.json');
  const data = claudeConfig.buddyChatSettings(settings.get('port'), { globalHooks: setup.hooks.installed && setup.hooks.upToDate });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// MCP config that adds the buddy's channel to a terminal session.
function channelMcpConfig() {
  const file = path.join(app.getPath('userData'), 'channel-mcp.json');
  const script = path.join(__dirname, '..', '..', 'bridge', 'channel.js').replace('app.asar', 'app.asar.unpacked');
  // Electron runs plain Node scripts with ELECTRON_RUN_AS_NODE, so no separate Node install is needed.
  const config = { mcpServers: { 'claude-companion': { command: process.execPath, args: [script, '--port', String(settings.get('port'))], env: { ELECTRON_RUN_AS_NODE: '1' } } } };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

function terminalCommand() {
  return `claude --mcp-config "${channelMcpConfig()}" --dangerously-load-development-channels server:claude-companion`;
}

// How (and whether) the chat box can reach a session.
function inputFor(s) {
  const source = store.sourceOf(s);
  if (source === 'buddy') return { mode: 'direct', via: 'buddy' };
  if (source === 'terminal') {
    if (channels.forSession(s)) return { mode: 'direct', via: 'channel' };
    return { mode: 'none', hint: 'Start terminal sessions with the buddy’s channel to type here (Settings → Connect).' };
  }
  if (source === 'vscode') return { mode: 'vscode', hint: 'Opens this chat in VS Code with your message ready. Press Enter there to send it.' };
  if (source === 'desktop') return { mode: 'none', hint: 'Claude Desktop doesn’t accept messages from other apps. Reply in Desktop, or start a buddy chat.' };
  return { mode: 'none', hint: 'Can’t reach this session from here.' };
}

function sendChat(sessionId, text) {
  text = String(text || '').trim();
  if (!text) return { ok: false, error: 'Type something first.' };
  const s = store.sessions.get(sessionId);
  if (!s) return { ok: false, error: 'That session is gone.' };
  const input = inputFor(s);
  try {
    if (input.via === 'buddy') {
      buddyChats.send(sessionId, text);
      return { ok: true, mode: 'sent' };
    }
    if (input.via === 'channel') {
      return channels.sendMessage(s, text) ? { ok: true, mode: 'sent' } : { ok: false, error: 'The terminal’s channel isn’t connected.' };
    }
    if (input.mode === 'vscode') {
      shell.openExternal(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}&prompt=${encodeURIComponent(text)}`);
      return { ok: true, mode: 'prefilled' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: false, error: input.hint };
}

function setChatOpen(open) {
  chatOpen = !!open;
  if (alive(win)) {
    // The widget never takes focus, except while you type in the chat.
    win.setFocusable(chatOpen);
    if (chatOpen) win.focus();
  }
  store.dirty = true;
}

function summary(snap) {
  const f = snap.focus;
  return {
    focus: f && { project: f.project, status: f.status, activity: f.activity && f.activity.label, todos: `${f.todos.filter((t) => t.status === 'completed').length}/${f.todos.length}`, tokens: f.tokens.total, cost: f.cost.toFixed(3), ctx: Math.round(f.context.pct), decision: f.decision && f.decision.text, bubble: f.bubble && f.bubble.text },
    sessions: snap.sessions.length,
    today: snap.usage.today,
  };
}

function refreshSetup() {
  setup = {
    hooks: claudeConfig.hooksStatus(settings.get('port')),
    statusLine: claudeConfig.statusLineStatus(),
    serverError,
  };
}

// ---- character packs ----------------------------------------------------------

function charactersDir() {
  return path.join(app.getPath('userData'), 'characters');
}

function selectedCharacter() {
  return settings.get('display').character;
}

// Loads the chosen pack and sends it to the widget. While a pack is broken
// (say, mid-edit) the last good version of it stays up; a pack that never
// loaded falls back to the buddy. Either way Settings shows the error.
function loadCharacter() {
  const id = selectedCharacter();
  try {
    character = characters.loadCharacter(id, charactersDir());
    characterStatus = { id, ok: true, warnings: character.warnings };
  } catch (err) {
    const fallback = !character || character.id !== id;
    characterStatus = { id, ok: false, error: err.message, warnings: [], fallback };
    if (fallback) {
      try {
        character = characters.loadCharacter(characters.DEFAULT_ID, charactersDir());
      } catch (e) {
        console.error('Could not load the built-in character:', e.message);
      }
    }
  }
  if (alive(win) && character) win.webContents.send('character', character);
  push();
}

function selectCharacter(id) {
  settings.set({ display: updateDisplay(settings.get('display'), { character: id }) });
  loadCharacter();
}

function onCharacterFiles(ids) {
  charactersRev++;
  if (ids.has(selectedCharacter()) || ids.has('')) loadCharacter();
  else push();
}

function characterList() {
  return { list: characters.listCharacters(charactersDir()), selected: selectedCharacter(), folder: charactersDir(), status: characterStatus };
}

// Neither window ever navigates or opens another: a stray link (in a
// character's art, say) must not load a page that would get the preload API.
function lockNavigation(w) {
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// ---- widget window ----------------------------------------------------------

function widgetSize() {
  const scale = settings.get('scale') || 1;
  return { width: Math.round(WIN_W * scale), height: Math.round(WIN_H * scale), scale };
}

function defaultPosition({ width, height }) {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - width - 12, y: workArea.y + workArea.height - height };
}

function onSomeScreen(pos, { width, height }) {
  return screen.getAllDisplays().some(({ workArea: a }) => pos.x + width / 2 > a.x && pos.x + width / 2 < a.x + a.width && pos.y + height / 2 > a.y && pos.y + height / 2 < a.y + a.height);
}

// Keeps the whole window inside its screen's work area (e.g. after the window
// grew taller, its bottom shouldn't end up behind the taskbar).
function clampToWorkArea(pos, { width, height }) {
  const a = screen.getDisplayMatching({ x: pos.x, y: pos.y, width, height }).workArea;
  return {
    x: Math.min(Math.max(pos.x, a.x), a.x + a.width - width),
    y: Math.min(Math.max(pos.y, a.y), a.y + a.height - height),
  };
}

function currentDisplay() {
  return alive(win) ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
}

function listDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  const current = currentDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `${d.label || `Screen ${i + 1}`} — ${d.size.width}×${d.size.height}${d.id === primary ? ' (main)' : ''}`,
    current: d.id === current,
  }));
}

function placeWindow(x, y) {
  const { width, height } = widgetSize();
  // Moving between screens with different scaling can make Windows resize
  // the window on the first call; the second one settles it.
  win.setBounds({ x, y, width, height });
  win.setBounds({ x, y, width, height });
}

function savePosition() {
  const [x, y] = win.getPosition();
  settings.set({ position: { x, y } });
}

// Moves the buddy to another screen, keeping the same relative spot (e.g. the
// bottom-right corner stays the bottom-right corner).
function moveToDisplay(id) {
  const target = screen.getAllDisplays().find((d) => d.id === Number(id));
  if (!alive(win) || !target) return;
  const b = win.getBounds();
  const from = currentDisplay().workArea;
  const rel = (v, start, span) => (span > 0 ? Math.min(1, Math.max(0, (v - start) / span)) : 1);
  const fx = rel(b.x, from.x, from.width - b.width);
  const fy = rel(b.y, from.y, from.height - b.height);
  const a = target.workArea;
  placeWindow(Math.round(a.x + fx * (a.width - b.width)), Math.round(a.y + fy * (a.height - b.height)));
  savePosition();
  showWidget();
}

// When a screen is unplugged or rearranged, bring the buddy back into view.
function keepOnScreen() {
  if (!alive(win)) return;
  const b = win.getBounds();
  if (onSomeScreen(b, b)) return;
  const p = defaultPosition(widgetSize());
  placeWindow(p.x, p.y);
  savePosition();
}

function createWidget() {
  const size = widgetSize();
  let pos = settings.get('position');
  if (!pos || !onSomeScreen(pos, size)) pos = defaultPosition(size);
  pos = clampToWorkArea(pos, size);

  win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    title: 'Claude Companion',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyAlwaysOnTop();
  lockNavigation(win);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { demo: DEMO ? String(DEMO) : '' } });
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(size.scale);
    push();
  });
  win.once('ready-to-show', () => {
    win.showInactive();
    applyAlwaysOnTop();
  });

  let saveTimer;
  win.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 400);
  });
  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// On Windows only the 'screen-saver' level actually sets WS_EX_TOPMOST here;
// 'floating' (and `alwaysOnTop: true` at creation) are silently ignored.
function applyAlwaysOnTop() {
  if (!alive(win)) return;
  if (settings.get('alwaysOnTop')) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(false);
}

// Re-assert if something (a fullscreen app, explorer restarting) drops it.
function keepOnTop() {
  if (alive(win) && settings.get('alwaysOnTop') && !win.isAlwaysOnTop()) applyAlwaysOnTop();
}

function applyScale() {
  const size = widgetSize();
  const [x, y] = win.getPosition();
  const old = win.getBounds();
  // Keep the bottom-centre anchored so the buddy doesn't jump around.
  win.setBounds({ x: Math.round(x + old.width / 2 - size.width / 2), y: y + old.height - size.height, width: size.width, height: size.height });
  win.webContents.setZoomFactor(size.scale);
}

function showWidget() {
  if (!win) return;
  win.showInactive();
}

function push() {
  if (!win || win.isDestroyed()) return;
  const snap = store.snapshot();
  snap.setup = setup;
  snap.display = settings.get('display');
  snap.buddyName = settings.get('buddyName');
  snap.chatOpen = chatOpen;
  snap.preview = preview;
  if (snap.focus) {
    const s = store.sessions.get(snap.focus.id);
    snap.focus.actions = decisions.viewsFor(snap.focus.id);
    snap.focus.input = inputFor(s);
    snap.focus.chat = buddyChats.view(snap.focus.id);
    if (chatOpen) snap.chatItems = store.chatOf(snap.focus.id);
  }
  for (const v of snap.sessions) v.actionable = decisions.forSession(v.id).length;
  win.webContents.send('state', snap);
  updateTray(snap);
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('state', { setup, usage: snap.usage, credits: snap.credits, display: snap.display, characters: { rev: charactersRev, status: characterStatus } });
  }
}

let lastCursor = '';
function trackCursor() {
  if (!alive(win) || !win.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const key = `${p.x},${p.y},${b.x},${b.y}`;
  if (key === lastCursor) return;
  lastCursor = key;
  win.webContents.send('cursor', { x: p.x - b.x, y: p.y - b.y, zoom: settings.get('scale') || 1 });
}

// ---- dragging -------------------------------------------------------------

let drag = null;
ipcMain.on('drag:start', () => {
  if (!win) return;
  const p = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  const { width, height } = win.getBounds();
  drag = { dx: p.x - x, dy: p.y - y, start: p, moved: false, width, height };
  clearInterval(drag.timer);
  drag.timer = setInterval(() => {
    if (!drag) return;
    const c = screen.getCursorScreenPoint();
    if (!drag.moved && Math.hypot(c.x - drag.start.x, c.y - drag.start.y) < 4) return;
    drag.moved = true;
    win.setBounds({ x: c.x - drag.dx, y: c.y - drag.dy, width: drag.width, height: drag.height });
  }, 16);
  setTimeout(() => endDrag(), 60000);
});

function endDrag() {
  if (!drag) return false;
  clearInterval(drag.timer);
  const moved = drag.moved;
  drag = null;
  // Programmatic moves don't fire 'moved' on Windows, so save here.
  if (moved && alive(win)) savePosition();
  return moved;
}
ipcMain.handle('drag:end', () => endDrag());

ipcMain.on('mouse:ignore', (_e, ignore) => {
  if (alive(win) && !drag) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.on('menu:open', () => buildMenu().popup({ window: win }));
// ---- jumping to a session ------------------------------------------------------

function vscodeExecutable() {
  if (process.platform !== 'win32') return 'code';
  // code.cmd needs a shell; Code.exe next to it opens folders directly.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, 'code.cmd'))) {
      const exe = path.join(dir, '..', 'Code.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  for (const base of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles]) {
    const exe = base && path.join(base, 'Microsoft VS Code', 'Code.exe');
    if (exe && fs.existsSync(exe)) return exe;
  }
  return null;
}

// Brings up the app a session runs in. Only VS Code can be targeted: opening
// the workspace folder focuses the window that already has it open.
function jumpTo(id) {
  const s = store.sessions.get(id);
  if (!s || store.sourceOf(s) !== 'vscode') return false;
  const dir = store.projectDirOf(s);
  const exe = vscodeExecutable();
  if (!dir || !exe || !fs.existsSync(dir)) return false;
  const child = spawn(exe, [dir], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (err) => console.error('Could not open VS Code:', err.message));
  child.unref();
  return true;
}

ipcMain.handle('session:jump', (_e, id) => jumpTo(id));

ipcMain.on('chat:open', (_e, open) => setChatOpen(open));
ipcMain.handle('chat:send', (_e, { sessionId, text }) => sendChat(sessionId, text));
ipcMain.handle('chat:new', (_e, { cwd, text }) => {
  try {
    if (!String(text || '').trim()) return { ok: false, error: 'Type a first message.' };
    const id = buddyChats.start({ cwd, text: String(text).trim() });
    settings.set({ lastChatDir: cwd });
    store.session(id, { cwd });
    // The transcript appears once Claude Code starts; look for it soon.
    for (const ms of [1500, 4000, 9000]) setTimeout(() => watcher.scan(Date.now() - 60000), ms);
    store.follow(id);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('chat:stop', (_e, id) => buddyChats.stop(id));
ipcMain.handle('chat:defaults', () => {
  const f = store.snapshot().focus;
  const s = f && store.sessions.get(f.id);
  return { cwd: settings.get('lastChatDir') || (s && store.projectDirOf(s)) || app.getPath('home'), claude: findClaude() };
});
ipcMain.handle('chat:pick-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { title: 'Folder for Claude to work in', defaultPath: current || undefined, properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('decision:answer', (_e, { id, behavior, answers, always, message }) => {
  const r = decisions.answer(id, { behavior, answers, always, message });
  if (r && r.relay) channels.sendVerdict(r.relay.channelId, r.relay.requestId, r.relay.behavior);
  push();
  return !!r;
});

ipcMain.on('session:follow', (_e, id) => {
  store.follow(id);
  push();
});

// ---- tray & menus -----------------------------------------------------------

function createTray() {
  tray = new Tray(trayImage('idle'));
  tray.setToolTip('Claude Companion');
  tray.on('click', () => alive(win) && (win.isVisible() ? win.hide() : showWidget()));
  // Built on demand so the session list is always current.
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

function trayImage(mood) {
  const { buffer, width, height } = drawTrayIcon(mood);
  return nativeImage.createFromBitmap(buffer, { width, height, scaleFactor: 2 });
}

function updateTray(snap) {
  if (!tray) return;
  const f = snap.focus;
  let mood = f ? f.status : 'idle';
  if ((f && f.decision) || snap.attention.length) mood = 'waiting';
  const iconMood = ['waiting', 'done', 'error', 'sleeping'].includes(mood) ? mood : 'idle';
  if (iconMood !== trayMood) {
    trayMood = iconMood;
    tray.setImage(trayImage(iconMood));
  }
  let tip = settings.get('buddyName') || 'Claude Companion';
  if (f) {
    const what = f.decision ? `needs you: ${f.decision.text}` : f.activity ? f.activity.label : f.status;
    tip += `\n${f.project} — ${what}`;
  }
  tray.setToolTip(tip.slice(0, 120));
}

function setDisplay(patch) {
  settings.set({ display: updateDisplay(settings.get('display'), patch) });
  store.dirty = true;
  push();
}

const BUBBLE_LEVELS = { all: 'Everything', important: 'Important only', decisions: 'Only when I’m needed', off: 'Off' };
const ACTIVITY_LEVELS = { subtle: 'Subtle', normal: 'Normal', lively: 'Lively' };
const SHOW_ITEMS = [
  ['showTokens', 'Tokens card'],
  ['showCredits', 'Credits card'],
  ['showTasks', 'Task progress'],
  ['showCrew', 'Other sessions'],
  ['showHelpers', 'Helpers (subagents)'],
  ['showFooter', 'Project & model line'],
  ['showCost', 'Money amounts'],
];

function displayMenu() {
  const d = settings.get('display');
  return [
    {
      label: 'Layout',
      submenu: [
        ...presetList().map((p) => ({ label: p.label, sublabel: p.hint, type: 'radio', checked: d.preset === p.id, click: () => setDisplay({ preset: p.id }) })),
        { label: 'Custom', type: 'radio', checked: d.preset === 'custom', enabled: false },
      ],
    },
    { label: 'Show', submenu: SHOW_ITEMS.map(([key, label]) => ({ label, type: 'checkbox', checked: !!d[key], click: (item) => setDisplay({ [key]: item.checked }) })) },
    {
      label: 'Speech bubbles',
      submenu: Object.entries(BUBBLE_LEVELS).map(([id, label]) => ({ label, type: 'radio', checked: d.bubbleLevel === id, click: () => setDisplay({ bubbleLevel: id }) })),
    },
    {
      label: 'Activities',
      submenu: [
        { label: 'Act out what Claude is doing', type: 'checkbox', checked: d.activities, click: (item) => setDisplay({ activities: item.checked }) },
        { type: 'separator' },
        ...Object.entries(ACTIVITY_LEVELS).map(([id, label]) => ({ label, type: 'radio', checked: d.activityLevel === id, enabled: d.activities, click: () => setDisplay({ activityLevel: id }) })),
        { type: 'separator' },
        { label: 'Choose which…', click: () => openSettings('look') },
      ],
    },
    { label: 'Customize…', click: () => openSettings('display') },
  ];
}

function buildMenu() {
  const snap = store.snapshot();
  const SOURCES = { vscode: ' (VS Code)', desktop: ' (Desktop)', terminal: ' (Terminal)', sdk: ' (SDK)' };
  const sessionItems = snap.sessions.map((s) => ({
    label: `${s.waiting ? '❗ ' : ''}${s.project}${s.title ? ` — ${s.title.slice(0, 40)}` : ''}${SOURCES[s.source] || ''}`,
    type: 'radio',
    checked: snap.following === s.id,
    click: () => store.follow(s.id),
  }));
  const scale = settings.get('scale');
  const hooks = setup.hooks;
  return Menu.buildFromTemplate([
    { label: settings.get('buddyName') || 'Claude Companion', enabled: false },
    { type: 'separator' },
    {
      label: 'Follow',
      submenu: [{ label: 'Automatic (most recent / needs you)', type: 'radio', checked: !snap.following, click: () => store.follow(null) }, ...(sessionItems.length ? [{ type: 'separator' }, ...sessionItems] : [])],
    },
    { label: alive(win) && win.isVisible() ? 'Hide buddy' : 'Show buddy', click: () => alive(win) && (win.isVisible() ? win.hide() : showWidget()) },
    ...(screen.getAllDisplays().length > 1
      ? [
          {
            label: 'Move to screen',
            submenu: listDisplays().map((d) => ({ label: d.label, type: 'radio', checked: d.current, click: () => moveToDisplay(d.id) })),
          },
        ]
      : []),
    {
      label: 'Size',
      submenu: Object.entries(SCALES).map(([label, value]) => ({
        label,
        type: 'radio',
        checked: scale === value,
        click: () => {
          settings.set({ scale: value });
          applyScale();
        },
      })),
    },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: settings.get('alwaysOnTop'),
      click: (item) => {
        settings.set({ alwaysOnTop: item.checked });
        applyAlwaysOnTop();
      },
    },
    { type: 'separator' },
    ...displayMenu(),
    { type: 'separator' },
    hooks.installed
      ? { label: hooks.upToDate ? 'Connected to Claude Code ✓' : 'Update Claude Code hooks…', click: hooks.upToDate ? openSettings : () => doInstallHooks() }
      : { label: 'Connect to Claude Code…', click: () => doInstallHooks() },
    { label: 'Chat', click: () => openChat(false) },
    { label: 'New buddy chat…', click: () => openChat(true) },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

// ---- notifications ------------------------------------------------------------

const lastNotified = new Map();
function notify(kind, s) {
  const enabled = kind === 'decision' ? settings.get('notifyOnDecision') : settings.get('notifyOnDone');
  if (!enabled || !Notification.isSupported() || store.isHidden(s)) return;
  const project = store.projectOf(s);
  const body = kind === 'decision' ? (s.waiting && s.waiting.text) || 'Claude is waiting for you' : (s.bubble && s.bubble.text) || 'Claude finished';
  const key = `${kind}:${s.id}:${body}`;
  if (Date.now() - (lastNotified.get(key) || 0) < 30000) return;
  lastNotified.set(key, Date.now());
  const name = settings.get('buddyName');
  const title = `${name ? `${name}: ` : ''}${kind === 'decision' ? 'Claude needs you' : 'Claude is done'} · ${project}`;
  const n = new Notification({ title, body, silent: kind !== 'decision' });
  // Clicking a VS Code session's notification takes you straight to it.
  n.on('click', () => jumpTo(s.id) || showWidget());
  n.show();
}

// ---- Claude Code setup --------------------------------------------------------

async function doInstallHooks(parent) {
  const file = claudeConfig.settingsPath();
  const { response } = await dialog.showMessageBox(parent || null, {
    type: 'question',
    buttons: ['Connect', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Connect to Claude Code',
    message: 'Add Claude Companion hooks to your Claude Code settings?',
    detail:
      `This adds background hooks to:\n${file}\n\n` +
      `They send session events (tool use, permission prompts, finished turns) to this app on 127.0.0.1:${settings.get('port')} using curl, and never block Claude.\n\n` +
      'A backup is saved next to the file. Restart running Claude Code sessions to pick them up. You can remove the hooks from Settings at any time.',
  });
  if (response !== 0) return false;
  try {
    claudeConfig.installHooks(settings.get('port'));
  } catch (err) {
    dialog.showErrorBox('Could not update Claude Code settings', err.message);
    return false;
  }
  refreshSetup();
  push();
  return true;
}

function openSettings(tab) {
  tab = typeof tab === 'string' ? tab : '';
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (tab) settingsWin.webContents.send('tab', tab);
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 760,
    title: 'Claude Companion — Settings',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    resizable: true,
    backgroundColor: '#1f1b18',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockNavigation(settingsWin);
  settingsWin.loadFile(path.join(__dirname, '..', 'settings', 'settings.html'), { query: { tab } });
  settingsWin.webContents.on('did-finish-load', () => push());
  // A preview only lasts while you're looking at it in Settings.
  settingsWin.on('closed', () => {
    if (!preview) return;
    preview = null;
    push();
  });
}

function openChat(fresh) {
  showWidget();
  if (alive(win)) win.webContents.send('chat:show', { fresh: !!fresh });
}

ipcMain.handle('settings:get', () => ({
  settings: settings.all(),
  presets: presetList(),
  displayDefaults: DISPLAY_DEFAULTS,
  setup,
  claudeSettings: claudeConfig.settingsPath(),
  claudeFound: findClaude(),
  terminalCommand: terminalCommand(),
  channelsLive: channels.live().length,
  loginItem: app.getLoginItemSettings().openAtLogin,
  version: app.getVersion(),
}));
ipcMain.handle('terminal:copy', () => {
  const cmd = terminalCommand();
  clipboard.writeText(cmd);
  return cmd;
});
ipcMain.handle('claude:pick', async () => {
  const r = await dialog.showOpenDialog(settingsWin || win, { title: 'Claude Code executable', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [] });
  if (r.canceled) return findClaude();
  settings.set({ claudePath: r.filePaths[0] });
  return findClaude();
});
ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = ['notifyOnDecision', 'notifyOnDone', 'sleepAfterMin', 'budget', 'alwaysOnTop', 'scale', 'answerFromBuddy'];
  const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
  if (patch && typeof patch.buddyName === 'string') clean.buddyName = patch.buddyName.trim().slice(0, 24);
  if (patch && patch.claudePath === '') clean.claudePath = '';
  if (patch && patch.display) clean.display = patch.display === 'reset' ? updateDisplay({}, {}) : updateDisplay(settings.get('display'), patch.display);
  const before = selectedCharacter();
  settings.set(clean);
  if ('alwaysOnTop' in clean) applyAlwaysOnTop();
  if ('scale' in clean) applyScale();
  if (selectedCharacter() !== before) loadCharacter();
  store.dirty = true;
  push();
  return settings.all();
});

ipcMain.handle('character:get', (_e, opts) => {
  if (!(opts && opts.fallback)) return character;
  try {
    return characters.loadCharacter(characters.DEFAULT_ID, charactersDir());
  } catch {
    return null;
  }
});
// The widget's verdict after parsing the pack (SVG errors show up only there).
ipcMain.on('character:status', (_e, r) => {
  if (!r || r.id !== selectedCharacter()) return;
  characterStatus = { id: r.id, ok: !!r.ok, error: String(r.error || ''), warnings: Array.isArray(r.warnings) ? r.warnings.map(String).slice(0, 20) : [], fallback: r.showing !== r.id };
  push();
});
ipcMain.handle('characters:list', () => characterList());
ipcMain.handle('characters:copy', (_e, id) => {
  try {
    const copy = characters.copyCharacter(id, charactersDir());
    selectCharacter(copy);
    shell.openPath(path.join(charactersDir(), copy));
    return { ok: true, id: copy, ...characterList() };
  } catch (err) {
    return { ok: false, error: err.message, ...characterList() };
  }
});
ipcMain.handle('characters:import', async () => {
  const r = await dialog.showOpenDialog(settingsWin || win, { title: 'Character folder (with a character.json)', properties: ['openDirectory'] });
  if (r.canceled) return { ok: false, ...characterList() };
  try {
    selectCharacter(characters.importCharacter(r.filePaths[0], charactersDir()));
    return { ok: true, ...characterList() };
  } catch (err) {
    return { ok: false, error: err.message, ...characterList() };
  }
});
// Your pack's own folder, or the folder that holds them all.
ipcMain.handle('characters:open', (_e, id) => {
  const own = characters.validId(id) && path.join(charactersDir(), id);
  const dir = own && fs.existsSync(own) ? own : charactersDir();
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
ipcMain.on('open:character-guide', () => shell.openExternal(CHARACTER_GUIDE));
ipcMain.on('preview:set', (_e, scene) => {
  preview = typeof scene === 'string' && /^[a-z]+(:[a-z]+)?$/.test(scene) ? scene : null;
  push();
});
ipcMain.handle('login:set', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('hooks:install', () => doInstallHooks(settingsWin));
ipcMain.handle('hooks:uninstall', () => {
  claudeConfig.uninstallHooks();
  refreshSetup();
  push();
  return setup;
});
ipcMain.handle('statusline:install', async () => {
  const { response } = await dialog.showMessageBox(settingsWin, {
    type: 'question',
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Show claude.ai plan usage?',
    detail:
      'Claude Code only shares your 5-hour and weekly plan usage with its status line. This sets the status line in ' +
      `${claudeConfig.settingsPath()} to a small Node.js bridge that forwards it here. ` +
      'An existing status line keeps working: the bridge runs it and shows its output. Works in the Claude Code terminal (requires Node.js on PATH).',
  });
  if (response !== 0) return setup;
  const prev = claudeConfig.installStatusLine(settings.get('port'));
  if (prev) settings.set({ statusLineChain: prev });
  refreshSetup();
  push();
  return setup;
});
ipcMain.handle('statusline:uninstall', () => {
  claudeConfig.uninstallStatusLine(settings.get('statusLineChain'));
  settings.set({ statusLineChain: null });
  refreshSetup();
  push();
  return setup;
});
ipcMain.on('open:claude-settings', () => shell.showItemInFolder(claudeConfig.settingsPath()));
ipcMain.on('open:settings', (_e, tab) => openSettings(tab));
ipcMain.handle('displays:list', () => listDisplays());
ipcMain.handle('displays:move', (_e, id) => {
  moveToDisplay(id);
  return listDisplays();
});

app.on('before-quit', () => {
  quitting = true;
  stopTimers();
  stopWatchingCharacters();
  // Let held prompts fall back to Claude's own UI, and end buddy chats.
  if (decisions) decisions.closeAll();
  if (channels) channels.closeAll();
  if (buddyChats) buddyChats.stopAll();
});
app.on('window-all-closed', (e) => e.preventDefault());
