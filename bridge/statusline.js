#!/usr/bin/env node
'use strict';

// Claude Code status-line bridge. Claude Code pipes session JSON (including
// claude.ai plan usage in `rate_limits`) to this script; we forward it to
// Claude Companion, then print a status line: the user's previous one when
// chained (--chain <base64 command>), otherwise a compact default.

const http = require('http');
const { spawn } = require('child_process');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const port = Number(arg('port')) || 47821;
const chain = arg('chain') ? Buffer.from(arg('chain'), 'base64').toString('utf8') : null;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  await forward(input);
  if (chain) runChain(chain, input);
  else process.stdout.write(defaultLine(input));
});

function forward(body) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/statusline', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 300 },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', resolve);
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

function runChain(command, stdin) {
  const child = spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', () => process.stdout.write(defaultLine(stdin)));
  child.stdin.end(stdin);
}

function defaultLine(raw) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return '';
  }
  const parts = [];
  if (d.model && d.model.display_name) parts.push(d.model.display_name);
  const ctx = d.context_window && d.context_window.used_percentage;
  if (typeof ctx === 'number') parts.push(`ctx ${Math.round(ctx)}%`);
  const rl = d.rate_limits || {};
  if (rl.five_hour) parts.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl.seven_day) parts.push(`7d ${Math.round(rl.seven_day.used_percentage)}%`);
  if (d.cost && typeof d.cost.total_cost_usd === 'number') parts.push(`$${d.cost.total_cost_usd.toFixed(2)}`);
  return `✦ ${parts.join(' · ')}`;
}
