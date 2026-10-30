# Changelog

All notable changes are listed here. This project follows [Semantic Versioning](https://semver.org).

## Unreleased

- **Characters.** Choose the buddy's look in Settings → Look: Buddy, Blip (a small robot) or Ghost (pixel art). Make your own as pictures (one per mood, sprite sheets, animated GIF/WebP) or as an SVG with CSS animation. Make an editable copy of any character, add one someone shared, preview every mood, and see your changes each time you save. The [character guide](docs/characters.md) explains it all.
- **Activities.** The buddy no longer spends most of a turn thinking. It acts out what Claude is most likely doing: typing on a laptop while Claude writes its reply, coding while it edits (and while it writes the next edit), reading a book, sweeping a magnifier, watching a terminal, browsing a page and ticking off a checklist. The last activity lingers for a moment after its tool, so quick tool calls no longer flicker. Now and then it looks around, stretches, scratches its head, hops or yawns while idle or thinking. Settings → Look → Activities turns each one off and sets how present they are (subtle, normal, lively); the right-click menu has the switch and the level too. Mini buddies and helpers act out their sessions as well.
- Characters can draw activities and quirks with the new `do-*` and `quirk-*` classes, picture packs can add poses for them, and `gaze` takes a direction per activity. Characters that don't draw them show their working look. See the [character guide](docs/characters.md).
- The buddy's pencil now stays in its hand while editing, instead of floating over the credits card.
- The widget and Settings windows can no longer navigate to another page or open new windows.

## 0.1.1

- Fixed project names for sessions started in a Windows-style folder (`D:\Dev\app`) when the buddy runs on macOS or Linux. This also fixes the test failure that stopped the 0.1.0 installers from being built.

## 0.1.0

First public release.

- Desktop buddy with moods for idle, thinking, working (with a prop for each tool), needs you, done, error, compacting and asleep; eyes that follow the cursor; petting and dragging.
- Follows Claude Code sessions from the terminal, VS Code and Claude Desktop, using transcripts and optional hooks.
- Tokens, context fill, cost estimates, claude.ai plan limits (through the status-line bridge) and budgets.
- Task progress from `TodoWrite`, `TaskCreate`/`TaskUpdate` and the Desktop plan.
- Several sessions at once as mini buddies, and subagents as helper clones.
- Chat panel with buttons to answer permission prompts, questions and plans; typing into terminal sessions (through a channel) and VS Code (pre-filled); buddy chats that run Claude Code inside the app.
- Personalisation: layout presets, per-card data choices, bubble levels, colours, names, themes, motion, ignored projects.
- Multi-monitor support, always on top, notifications, tray menu.
