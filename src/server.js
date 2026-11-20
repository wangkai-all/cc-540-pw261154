'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('./engine');
const data = require('./synthetic-data');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

function bootstrapStore() {
  const store = engine.createStore();
  for (const u of data.USERS) engine.registerUser(store, u);
  for (const m of data.METERS) engine.registerMeter(store, m);
  for (const s of data.INITIAL_SEGMENTS) engine.addSegment(store, s);
  engine.recompute(store, '基线：用户与表计关系登记');
  return store;
}

let store = bootstrapStore();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, engine.getState(store));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/revisions') {
      sendJson(res, 200, { revisions: engine.getRevisions(store) });
      return;
    }

    // 操作一：接入换表前后读数（工单尚未到达 -> 误判掉零）
    if (req.method === 'POST' && url.pathname === '/api/demo/ingest-readings') {
      const fresh = data.BATCH_READINGS.filter(
        (r) => !engine.getState(store).readings.some((x) => x.meterId === r.meterId && x.date === r.date)
      );
      const records = engine.ingestReadings(store, fresh, '接入换表前后读数（工单未到，新表疑似掉零）');
      sendJson(res, 200, { ok: true, ingested: records, state: engine.getState(store) });
      return;
    }

    // 操作二：补交迟到的换表工单（撤回误判，两段重算）
    if (req.method === 'POST' && url.pathname === '/api/demo/ingest-work-order') {
      const out = engine.ingestWorkOrder(store, { ...data.REPLACEMENT_WORK_ORDER });
      sendJson(res, 200, { ok: true, workOrder: out.record, warnings: out.warnings, state: engine.getState(store) });
      return;
    }

    // 操作三：重传样例（读数回拨订正，验证非负）
    if (req.method === 'POST' && url.pathname === '/api/demo/retransmission') {
      const out = engine.ingestReading(store, { ...data.RETRANSMISSION_READING }, '接入重传样例：回拨订正，日用量钳 0');
      sendJson(res, 200, { ok: true, ingested: out.record, state: engine.getState(store) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      store = bootstrapStore();
      sendJson(res, 200, { ok: true, state: engine.getState(store) });
      return;
    }

    sendJson(res, 404, { error: 'not found', path: url.pathname });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`metering demo listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { server, bootstrapStore };
