'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companion', {
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onCursor: (fn) => ipcRenderer.on('cursor', (_e, c) => fn(c)),
  setIgnoreMouse: (ignore) => ipcRenderer.send('mouse:ignore', ignore),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragEnd: () => ipcRenderer.invoke('drag:end'),
  openMenu: () => ipcRenderer.send('menu:open'),
  follow: (id) => ipcRenderer.send('session:follow', id),
  jump: (id) => ipcRenderer.invoke('session:jump', id),

  // Chat & decisions
  setChatOpen: (open) => ipcRenderer.send('chat:open', open),
  onChatShow: (fn) => ipcRenderer.on('chat:show', (_e, o) => fn(o)),
  sendChat: (sessionId, text) => ipcRenderer.invoke('chat:send', { sessionId, text }),
  newChat: (cwd, text) => ipcRenderer.invoke('chat:new', { cwd, text }),
  stopChat: (id) => ipcRenderer.invoke('chat:stop', id),
  chatDefaults: () => ipcRenderer.invoke('chat:defaults'),
  pickFolder: (current) => ipcRenderer.invoke('chat:pick-folder', current),
  answer: (id, answer) => ipcRenderer.invoke('decision:answer', { id, ...answer }),
  copyTerminalCommand: () => ipcRenderer.invoke('terminal:copy'),
  pickClaude: () => ipcRenderer.invoke('claude:pick'),
  openSettings: (tab) => ipcRenderer.send('open:settings', tab),
  onTab: (fn) => ipcRenderer.on('tab', (_e, tab) => fn(tab)),

  // Character packs
  getCharacter: (opts) => ipcRenderer.invoke('character:get', opts),
  onCharacter: (fn) => ipcRenderer.on('character', (_e, c) => fn(c)),
  characterStatus: (status) => ipcRenderer.send('character:status', status),
  listCharacters: () => ipcRenderer.invoke('characters:list'),
  copyCharacter: (id) => ipcRenderer.invoke('characters:copy', id),
  importCharacter: () => ipcRenderer.invoke('characters:import'),
  openCharacterFolder: (id) => ipcRenderer.invoke('characters:open', id),
  openCharacterGuide: () => ipcRenderer.send('open:character-guide'),
  setPreview: (scene) => ipcRenderer.send('preview:set', scene),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setLogin: (on) => ipcRenderer.invoke('login:set', on),
  installHooks: () => ipcRenderer.invoke('hooks:install'),
  uninstallHooks: () => ipcRenderer.invoke('hooks:uninstall'),
  installStatusLine: () => ipcRenderer.invoke('statusline:install'),
  uninstallStatusLine: () => ipcRenderer.invoke('statusline:uninstall'),
  revealClaudeSettings: () => ipcRenderer.send('open:claude-settings'),
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  moveToDisplay: (id) => ipcRenderer.invoke('displays:move', id),
});
