#!/usr/bin/env node
'use strict';

const http = require('http');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8790);
const basePath = process.env.BASE_PATH || '/bridge';
const streamTtlMs = Number(process.env.STREAM_TTL_MS || 120000);

const streams = new Map();

function cleanId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
}

function getStream(id) {
  if (!streams.has(id)) {
    streams.set(id, {
      latest: null,
      subscribers: new Set(),
      updatedAt: 0
    });
  }

  return streams.get(id);
}

function sendSse(res, event, payload) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(stream, payload) {
  stream.latest = payload;
  stream.updatedAt = Date.now();

  for (const res of stream.subscribers) {
    sendSse(res, 'reading', payload);
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function parseRoute(req) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  const prefixes = Array.from(new Set([basePath, '/bridge', '/radiacode-relay'])).filter((prefix) => prefix && prefix !== '/');

  for (const prefix of prefixes) {
    if (pathname === prefix) {
      pathname = '/';
      break;
    }

    if (pathname.startsWith(prefix + '/')) {
      pathname = pathname.slice(prefix.length) || '/';
      break;
    }
  }

  const match = pathname.match(/^\/streams\/([^/]+)(\/events)?$/);
  return {
    url,
    pathname,
    streamId: match ? cleanId(match[1]) : '',
    events: Boolean(match && match[2])
  };
}

const server = http.createServer(async (req, res) => {
  const route = parseRoute(req);
  console.log(`${new Date().toISOString()} ${req.method} ${route.url.pathname} -> ${route.pathname}`);

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (route.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      streams: streams.size
    });
    return;
  }

  if (req.method === 'GET' && route.events && route.streamId) {
    const stream = getStream(route.streamId);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*'
    });

    stream.subscribers.add(res);
    sendSse(res, 'hello', { streamId: route.streamId });

    if (stream.latest) {
      sendSse(res, 'reading', stream.latest);
    }

    const keepAlive = setInterval(() => {
      sendSse(res, 'ping', { now: Date.now() });
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      stream.subscribers.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && route.streamId && !route.events) {
    try {
      const payload = await readJson(req);
      const stream = getStream(route.streamId);
      broadcast(stream, Object.assign({}, payload, {
        streamId: route.streamId,
        serverReceivedAt: new Date().toISOString()
      }));
      sendJson(res, 200, { ok: true, streamId: route.streamId, subscribers: stream.subscribers.size });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || 'Invalid JSON' });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found', method: req.method, path: route.url.pathname, normalizedPath: route.pathname });
});

setInterval(() => {
  const now = Date.now();

  for (const [id, stream] of streams) {
    if (stream.subscribers.size === 0 && stream.updatedAt && now - stream.updatedAt > streamTtlMs) {
      streams.delete(id);
    }
  }
}, 30000).unref();

server.listen(port, host, () => {
  console.log(`RadiaCode relay listening on http://${host}:${port}${basePath}`);
});
