'use strict';

// Local HTTP endpoint that Claude Code hooks, the status-line bridge and the
// terminal channel bridge talk to. Bound to 127.0.0.1 only.
//
//   POST /hook          async hook events            -> 204
//   POST /decide        sync PermissionRequest hook  -> held until decided
//   POST /statusline    status-line bridge           -> 204
//   POST /channel/register, /channel/permission       -> JSON
//   GET  /channel/events?id=                          -> server-sent events
//   GET  /health, /state

const http = require('http');

const MAX_BODY = 8 * 1024 * 1024;

function startHookServer({ port, onHook, onDecide, onStatusLine, channel, getState }) {
  const server = http.createServer((req, res) => {
    // Browsers always send Origin on cross-site requests; Claude Code's curl,
    // the bridges and the channel never do. Refusing it keeps web pages from
    // spoofing events or answering prompts.
    if (req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET') {
      if (url.pathname === '/health') return json(res, { app: 'claude-companion', ok: true });
      if (url.pathname === '/state' && getState) return json(res, getState());
      if (url.pathname === '/channel/events' && channel) return channel.events(url.searchParams.get('id'), res);
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    readJson(req, (body) => {
      if (body === undefined) {
        res.writeHead(400).end();
        return;
      }
      try {
        switch (url.pathname) {
          case '/hook':
            // Hook stdout for some events is fed back to Claude as context, so
            // answer with an empty 204 and never print anything.
            res.writeHead(204).end();
            onHook(body);
            return;
          case '/decide':
            // The handler owns `res`: it answers now (no opinion) or later.
            onDecide(body, res);
            return;
          case '/statusline':
            res.writeHead(204).end();
            onStatusLine(body);
            return;
          case '/channel/register':
            return json(res, channel ? channel.register(body) : { ok: false });
          case '/channel/permission':
            if (channel) channel.permission(body);
            res.writeHead(204).end();
            return;
          default:
            res.writeHead(404).end();
        }
      } catch (err) {
        console.error('Request handling failed:', err);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function readJson(req, cb) {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) tooBig = true;
    else chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) return cb(undefined);
    try {
      cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch {
      cb(undefined);
    }
  });
}

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

module.exports = { startHookServer };
