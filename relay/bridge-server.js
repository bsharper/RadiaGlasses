#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { RadiaCode, RealTimeData, RareData } = require('./radiacode');

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8787);
const pollMs = Number(process.env.POLL_MS || 1000);

const clients = new Set();
const staticRoot = __dirname;
const staticFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
  ['/radiacode.js', 'radiacode.js']
]);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png'
};

let device = null;
let serial = null;
let latestStatus = {
  status: 'starting',
  message: 'Bridge starting'
};

function sendEvent(res, payload) {
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function broadcast(payload) {
  latestStatus = Object.assign({}, latestStatus, payload);
  for (const res of clients) {
    sendEvent(res, latestStatus);
  }
}

function latestRealtime(records) {
  if (!Array.isArray(records)) return null;

  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record instanceof RealTimeData || (
      record &&
      typeof record.count_rate === 'number' &&
      typeof record.dose_rate === 'number'
    )) {
      return record;
    }
  }

  return null;
}

function latestRare(records) {
  if (!Array.isArray(records)) return null;

  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record instanceof RareData || (
      record &&
      typeof record.charge_level === 'number' &&
      typeof record.temperature === 'number'
    )) {
      return record;
    }
  }

  return null;
}

async function connectDevice() {
  device = new RadiaCode();
  await device.connect();

  try {
    serial = await device.serial_number();
  } catch (_) {
    serial = 'RadiaCode';
  }

  broadcast({
    status: 'connected',
    message: 'Device connected',
    serial,
    connectionType: 'bridge'
  });
}

async function pollDevice() {
  const records = await device.data_buf();
  const realtime = latestRealtime(records);
  const rare = latestRare(records);

  if (!realtime && !rare) return;

  const payload = {
    status: 'live',
    message: 'Live',
    serial,
    connectionType: 'bridge',
    timestamp: new Date().toISOString()
  };

  if (realtime) {
    payload.doseRate = realtime.dose_rate;
    payload.countRate = realtime.count_rate;
    payload.doseRateError = realtime.dose_rate_err;
    payload.countRateError = realtime.count_rate_err;
    payload.timestamp = realtime.dt instanceof Date ? realtime.dt.toISOString() : payload.timestamp;
  }

  if (rare) {
    payload.batteryLevel = rare.charge_level;
    payload.temperature = rare.temperature;
  }

  broadcast(payload);
}

async function runDeviceLoop() {
  while (true) {
    try {
      if (!device || !device.connected()) {
        broadcast({ status: 'connecting', message: 'Connecting to RadiaCode' });
        await connectDevice();
      }

      await pollDevice();
      await sleep(pollMs);
    } catch (error) {
      broadcast({
        status: 'error',
        message: error.message || 'Bridge error'
      });

      try {
        if (device) await device.disconnect();
      } catch (_) {
        // Ignore cleanup errors before reconnecting.
      }

      device = null;
      await sleep(3000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');

  if (req.url === '/health') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*'
    });
    res.end(JSON.stringify(latestStatus));
    return;
  }

  if (requestUrl.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    clients.add(res);
    sendEvent(res, latestStatus);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (staticFiles.has(requestUrl.pathname)) {
    const filename = staticFiles.get(requestUrl.pathname);
    const filePath = path.join(staticRoot, filename);
    const ext = path.extname(filename);

    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found\n');
        return;
      }

      res.writeHead(200, { 'content-type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found\n');
});

server.listen(port, host, () => {
  console.log(`RadiaCode bridge listening on http://${host}:${port}/events`);
});

runDeviceLoop().catch((error) => {
  console.error(error);
  process.exit(1);
});
