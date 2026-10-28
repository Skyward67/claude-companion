# Contributing to Claude Companion

Thanks for helping! Bug reports, ideas, docs fixes and code are all welcome.

## Getting set up

```bash
npm install
```

```bash
npm start
```

You need Node.js 22 or later. Claude Code is optional, but you'll want it to see real sessions; the demo mode works without it.

## Useful commands and flags

| Command | What it does |
| --- | --- |
| `npm test` | Unit and integration tests (`node --test`). Run them before opening a pull request |
| `npm run dev` | Logs hook events and a state summary every 5 seconds |
| `npx electron . --demo` | Cycles through every mood with made-up data |
| `npx electron . --demo=<scene>` | One scene: `idle`, `thinking`, `read`, `edit`, `run`, `web`, `agent`, `waiting`, `question`, `done`, `error`, `compacting`, `sleeping`, `chat`, `chatq` |
| `--preset=<name>` / `--display=<json>` | Try a layout or look without saving it, for example `--display={"theme":"light"}` |
| `--scale=<n>` | Override the size for this run |
| `--settings[=<tab>]` | Open the Settings window at start |
| `--snapshot=<file.png> [--snapshot-delay=ms] [--exit]` | Save a picture of the widget (or of Settings, with `--settings`) and quit. Handy for checking UI changes and for screenshots |
| `--screen=<n>` | Sent to a running instance: moves the buddy to screen n |

`npm run pack` builds an unpacked app in `dist/`, and `npm run dist` builds installers for your platform.

## Project layout

```
src/main/        Electron main process (CommonJS)
  main.js          windows, tray, menus, notifications, IPC
  store.js         session state machine: hooks + transcripts → what the buddy shows and says
  transcripts.js   finds and tails ~/.claude/projects/**/*.jsonl, folds lines into state + chat log
  hookServer.js    127.0.0.1 HTTP endpoint for hooks, status line and channels
  decisions.js     prompts the buddy can answer (held hooks, channel relays)
  channels.js      terminal sessions connected through bridge/channel.js
  buddyChats.js    headless Claude Code sessions run by the buddy
  claudeConfig.js  installs/removes hooks and the status line in ~/.claude/settings.json
  display.js       display presets and validation of every display setting
  describe.js      tool call → friendly sentence
  pricing.js       model prices, cost estimate, context sizes
  settings.js, trayIcon.js
src/renderer/    the widget: plain scripts, no bundler
  character.js     the buddy's SVG and colours (animation lives in style.css)
  app.js           cards, bubbles, crew, popovers
  chat.js          chat panel
  demo.js          made-up data for demo mode
src/settings/    Settings window
bridge/          scripts Claude Code runs: status-line bridge, MCP channel server
test/            node:test suites
```

## Guidelines

- **Keep it dependency-light.** The app has no runtime dependencies. Please discuss before adding one.
- **Follow the surrounding style:** 2-space indent, single quotes, small functions, and comments that explain *why*.
- **Be careful with Claude Code integration points** (hooks, transcripts, channels, the status line). They're the contract with Claude Code, and parts of them are in research preview. Link to the docs you relied on in your pull request.
- **Never print anything from the hook endpoint** except a hook decision. For some events, Claude Code feeds hook output back to Claude as context.
- **UI changes:** attach a before/after screenshot (`--snapshot` makes this easy) and check both the dark and light card themes.
- **Add or update tests** for logic changes, in `test/`.

## Reporting bugs

Open an issue with your OS, the app version, how you run Claude Code (terminal, VS Code or Desktop) and its version (`claude --version`), and what you expected. Logs from `npm run dev` help a lot. Please remove anything private from transcripts or logs before sharing them.

## Security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
