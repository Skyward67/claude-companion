# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through this repository's **Security → Report a vulnerability** page (GitHub private vulnerability reporting), not in public issues. Include steps to reproduce and the impact you see. You should hear back within a week.

## What the app can do

Claude Companion sits next to Claude Code, which can run commands on your machine, so these are the parts worth scrutiny:

| Area | Behaviour |
| --- | --- |
| Local server | Listens on `127.0.0.1` only (default port 47821). Rejects requests with a browser `Origin` header. |
| Hooks | Added to `~/.claude/settings.json` only when you ask, with a backup. They `curl` hook events to the local server. |
| Answering prompts | A synchronous `PermissionRequest` hook waits while the buddy shows the prompt. Only the buddy's own window can answer it, through Electron IPC; the HTTP server can't approve anything. An unanswered prompt falls back to Claude Code's own flow. |
| Terminal channel | `bridge/channel.js` is loaded only into sessions you start with the channel command. Messages and verdicts reach it only from the local app. |
| Buddy chats | Runs your installed Claude Code with your login and its normal permission rules. Prompts are answered in the buddy. |
| Data | Reads Claude Code transcripts locally. Sends nothing to any server of its own. |

The local server trusts other processes running under your user account, as most local developer tools do. If that's not acceptable in your environment, don't connect the hooks or the channel.

## Supported versions

Only the latest release gets fixes.
