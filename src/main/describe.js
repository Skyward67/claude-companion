'use strict';

// Turns Claude Code tool calls and events into short, friendly lines for the
// speech bubble.

function base(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

function trunc(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return trunc(url, 30);
  }
}

function firstSentence(text, n = 140) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(clean);
  return trunc(m ? m[1] : clean, n);
}

const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'mcp__ccd_turn__update_plan']);

// kind: read | search | edit | run | web | agent | plan | ask | tool
function describeTool(name, input) {
  input = input || {};
  switch (name) {
    case 'Read':
      return { kind: 'read', label: `Reading ${base(input.file_path || input.path)}` };
    case 'NotebookRead':
      return { kind: 'read', label: `Reading ${base(input.notebook_path)}` };
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'edit', label: `Editing ${base(input.file_path)}` };
    case 'Write':
      return { kind: 'edit', label: `Writing ${base(input.file_path)}` };
    case 'NotebookEdit':
      return { kind: 'edit', label: `Editing ${base(input.notebook_path)}` };
    case 'Bash':
    case 'PowerShell':
      return {
        kind: 'run',
        label: input.description ? trunc(input.description, 60) : `Running ${trunc(input.command, 40)}`,
        detail: trunc(input.command, 80),
      };
    case 'Grep':
      return { kind: 'search', label: `Searching for “${trunc(input.pattern, 28)}”` };
    case 'Glob':
      return { kind: 'search', label: `Looking for ${trunc(input.pattern, 32)}` };
    case 'WebFetch':
      return { kind: 'web', label: `Reading ${host(input.url)}` };
    case 'WebSearch':
      return { kind: 'web', label: `Searching the web for “${trunc(input.query, 28)}”` };
    case 'Task':
    case 'Agent':
      return { kind: 'agent', label: `Sending a helper: ${trunc(input.description || input.subagent_type || 'subtask', 40)}` };
    case 'AskUserQuestion': {
      const q = Array.isArray(input.questions) && input.questions[0] ? input.questions[0].question : input.question;
      return { kind: 'ask', label: q ? trunc(q, 90) : 'I have a question for you' };
    }
    case 'ExitPlanMode':
      return { kind: 'ask', label: 'My plan is ready — take a look?' };
    case 'Skill':
      return { kind: 'plan', label: `Loading the ${trunc(input.skill, 30)} skill` };
    case 'mcp__ccd_turn__wrap_up':
      return { kind: 'plan', label: 'Wrapping up' };
  }
  if (PLAN_TOOLS.has(name)) return { kind: 'plan', label: 'Updating the plan' };
  if (name && name.startsWith('mcp__')) {
    const [, server = '', tool = ''] = name.split('__');
    const nice = `${server.replace(/[_-]+/g, ' ')} · ${tool.replace(/[_-]+/g, ' ')}`.trim();
    const kind = /browser|chrome|navigate|fetch|search/i.test(name) ? 'web' : 'tool';
    return { kind, label: `Using ${trunc(nice, 44)}` };
  }
  return { kind: 'tool', label: `Using ${name || 'a tool'}` };
}

function permissionLine(name, input) {
  const d = describeTool(name, input);
  switch (d.kind) {
    case 'run':
      return `May I run this? ${d.detail || d.label}`;
    case 'edit':
      return `May I edit ${base(input && input.file_path)}?`;
    case 'web':
      return `May I go online? ${d.label}`;
    default:
      return `Need your OK: ${d.label}`;
  }
}

const PHRASES = {
  prompt: ['On it!', "Ooh, let's go!", 'Thinking cap: on.', 'Got it — working on it.', 'Ready, set, code!'],
  hello: ['Hi! Ready when you are.', 'Hello again!', 'Reporting for duty!'],
  done: ['All done! ✨', 'Finished!', 'Ta-da!'],
  yourTurn: ['Your turn! 👋', 'Waiting for you…'],
  pet: ['Hehe!', '♥', 'That tickles!', 'Yay!', '*happy wiggle*'],
  compact: ['Tidying up my memory…', 'Making room to think…'],
  helper: ['Calling in a helper…', 'Teamwork time!'],
  helperDone: ['My helper is back!', 'Helper finished.'],
  denied: ['Okay, skipping that.', 'No problem, trying something else.'],
};

function pick(key) {
  const list = PHRASES[key] || [key];
  return list[Math.floor(Math.random() * list.length)];
}

function errorLine(err) {
  const map = {
    rate_limit: 'I hit the rate limit — need a breather.',
    overloaded: 'The servers are busy. Retrying soon…',
    authentication_failed: "I can't sign in. Check your login?",
    billing_error: 'Billing problem — check your account.',
    server_error: 'Server hiccup. Sorry!',
  };
  return map[err] || `Oops — ${trunc(err || 'something went wrong', 60)}`;
}

module.exports = { describeTool, permissionLine, firstSentence, pick, errorLine, trunc, base, PLAN_TOOLS };
