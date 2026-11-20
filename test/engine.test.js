'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const engine = require('../src/engine');
const synthetic = require('../src/synthetic-data');

// ---------- 辅助 ----------
function demoStore() {
  const store = engine.createStore();
  for (const u of synthetic.USERS) engine.registerUser(store, u);
  for (const m of synthetic.METERS) engine.registerMeter(store, m);
  for (const s of synthetic.INITIAL_SEGMENTS) engine.addSegment(store, s);
  engine.recompute(store, '基线');
  return store;
}

function findMeterRow(state, meterId, date) {
  const row = state.dailyUsage.find((r) => r.meterId === meterId && r.date === date);
  assert.ok(row, `应存在表 ${meterId} 在 ${date} 的日用量行`);
  return row;
}
function findUserRow(state, userId, date) {
  const row = state.userDailyUsage.find((r) => r.userId === userId && r.date === date);
  assert.ok(row, `应存在用户 ${userId} 在 ${date} 的日用量行`);
  return row;
}
function assertNoNegative(state) {
  for (const r of state.dailyUsage) assert.ok(r.usage >= 0, `表计用量不得为负：${r.meterId} ${r.date} = ${r.usage}`);
  for (const r of state.userDailyUsage) assert.ok(r.usage >= 0, `用户用量不得为负：${r.userId} ${r.date} = ${r.usage}`);
}

// ---------- 1. 正常路径：按表独立累计 ----------
describe('正常路径：按表号独立累计', () => {
  test('同表相邻读数做差，首读数用量为 0', () => {
    const store = demoStore();
    engine.ingestReadings(store, [
      { userId: 'U1002', meterId: 'M-RB-2', date: '2026-11-18', reading: 100, version: 1 },
      { userId: 'U1002', meterId: 'M-RB-2', date: '2026-11-19', reading: 120, version: 1 },
    ]);
    const state = engine.getState(store);
    assert.equal(findMeterRow(state, 'M-RB-2', '2026-11-18').usage, 0);
    assert.equal(findMeterRow(state, 'M-RB-2', '2026-11-19').usage, 20);
    assert.equal(findMeterRow(state, 'M-RB-2', '2026-11-19').basis, 'consecutive-delta');
    assertNoNegative(state);
  });

  test('新表从 0 开始，不与旧表读数跨表相减', () => {
    const store = demoStore();
    engine.ingestReadings(store, [
      { userId: 'U1001', meterId: 'M-OLD-1', date: '2026-11-19', reading: 112, version: 1 },
      { userId: 'U1001', meterId: 'M-NEW-1', date: '2026-11-20', reading: 0, version: 1 },
      { userId: 'U1001', meterId: 'M-NEW-1', date: '2026-11-21', reading: 7, version: 1 },
    ]);
    const state = engine.getState(store);
    // 新表首读数 0 用量为 0，而不是 0 - 112 = -112
    assert.equal(findMeterRow(state, 'M-NEW-1', '2026-11-20').usage, 0);
    assert.equal(findMeterRow(state, 'M-NEW-1', '2026-11-21').usage, 7);
    assertNoNegative(state);
  });
});

// ---------- 2. 异常路径：工单迟到，先误判掉零 ----------
describe('异常路径：换表工单迟到 -> 误判读数掉零', () => {
  test('工单未到时，新表读数无关系 -> SUSPECTED_DROP_ZERO 且用户归并挂起', () => {
    const store = demoStore();
    engine.ingestReadings(store, synthetic.BATCH_READINGS, '接入换表前后读数');
    const state = engine.getState(store);

    const dropAnomalies = state.anomalies.filter((a) => a.type === 'SUSPECTED_DROP_ZERO' && a.status === 'open');
    assert.ok(dropAnomalies.length >= 2, '新表两个读数日都应产生掉零误判');
    assert.deepEqual([...new Set(dropAnomalies.map((a) => a.meterId))], ['M-NEW-1']);
    // 误判的证据是“缺表计关系”，而不是读数对
    assert.equal(dropAnomalies[0].evidence.kind, 'missing-meter-link');

    const newRows = state.dailyUsage.filter((r) => r.meterId === 'M-NEW-1');
    assert.ok(newRows.every((r) => r.status === 'provisional'), '无关系期间新表用量应挂起');
    // 表号独立累计仍然保留真实差值 7（不是 0-120 的负值）
    assert.equal(findMeterRow(state, 'M-NEW-1', '2026-11-21').usage, 7);

    const u21 = findUserRow(state, 'U1001', '2026-11-21');
    assert.equal(u21.status, 'provisional');
    assertNoNegative(state);
  });

  test('旧表在关系有效期内正常累计，不受新表误判影响', () => {
    const store = demoStore();
    engine.ingestReadings(store, synthetic.BATCH_READINGS);
    const state = engine.getState(store);
    assert.equal(findMeterRow(state, 'M-OLD-1', '2026-11-19').usage, 12);
    assert.equal(findMeterRow(state, 'M-OLD-1', '2026-11-20').usage, 8);
    assert.equal(findMeterRow(state, 'M-OLD-1', '2026-11-20').status, 'final');
  });
});

// ---------- 3. 工单到达：撤回误判 + 两段重算 ----------
describe('工单证据：撤回旧解释并按两段重算', () => {
  test('补交工单后误判 withdrawn，关系拆两段，挂起转正式', () => {
    const store = demoStore();
    engine.ingestReadings(store, synthetic.BATCH_READINGS);
    const before = engine.getState(store);
    assert.ok(before.anomalies.some((a) => a.type === 'SUSPECTED_DROP_ZERO' && a.status === 'open'));

    const out = engine.ingestWorkOrder(store, { ...synthetic.REPLACEMENT_WORK_ORDER });
    assert.deepEqual(out.warnings, [], '工单表底与读数自洽时无告警');
    const state = engine.getState(store);

    // 误判全部撤回，且撤回证据指向工单（换表用工单自己的证据）
    const drops = state.anomalies.filter((a) => a.type === 'SUSPECTED_DROP_ZERO');
    assert.ok(drops.length >= 2);
    assert.ok(drops.every((a) => a.status === 'withdrawn'));
    assert.ok(drops.every((a) => a.evidence.kind === 'workOrder' && a.evidence.workOrderId === 'WO-20261120-001'));

    // 关系段：旧段封口 + 新段启用
    const oldSeg = store.segments.find((s) => s.meterId === 'M-OLD-1');
    const newSeg = store.segments.find((s) => s.meterId === 'M-NEW-1');
    assert.equal(oldSeg.endDate, '2026-11-20');
    assert.equal(oldSeg.kind, 'before-replace');
    assert.equal(newSeg.startDate, '2026-11-20');
    assert.equal(newSeg.kind, 'after-replace');

    // 新表挂起转正式，用量不变（重算只改解释与归属，不造负数）
    const n20 = findMeterRow(state, 'M-NEW-1', '2026-11-20');
    const n21 = findMeterRow(state, 'M-NEW-1', '2026-11-21');
    assert.equal(n20.status, 'final');
    assert.equal(n21.status, 'final');
    assert.equal(n20.usage, 0);
    assert.equal(n21.usage, 7);
    assert.equal(n21.basis, 'recomputed-after-work-order');

    // 用户级连续归并：换表日 11/20 = 旧表段 8 + 新表段 0
    const u20 = findUserRow(state, 'U1001', '2026-11-20');
    assert.equal(u20.usage, 8);
    assert.deepEqual(u20.meterIds, ['M-NEW-1', 'M-OLD-1']);
    const u21 = findUserRow(state, 'U1001', '2026-11-21');
    assert.equal(u21.usage, 7);
    assert.equal(u21.status, 'final');
    assertNoNegative(state);
  });

  test('修订记录包含“误判撤回”和“用量转正式”的前后对比', () => {
    const store = demoStore();
    engine.ingestReadings(store, synthetic.BATCH_READINGS);
    engine.ingestWorkOrder(store, { ...synthetic.REPLACEMENT_WORK_ORDER });
    const revisions = engine.getRevisions(store).flatMap((s) => s.revisions);
    assert.ok(revisions.some((c) => c.kind === 'anomaly-status-changed' && c.after.status === 'withdrawn'));
    assert.ok(revisions.some((c) => c.kind === 'usage-revised' && c.after.status === 'final' && c.before.status === 'provisional'));
  });

  test('重复工单被拒绝', () => {
    const store = demoStore();
    engine.ingestReadings(store, synthetic.BATCH_READINGS);
    engine.ingestWorkOrder(store, { ...synthetic.REPLACEMENT_WORK_ORDER });
    assert.throws(
      () => engine.ingestWorkOrder(store, { ...synthetic.REPLACEMENT_WORK_ORDER }),
      /已存在/
    );
  });

  test('工单表底与实际读数不一致 -> WORK_ORDER_MISMATCH 告警，但换表仍生效', () => {
    const store = demoStore();
    engine.ingestReadings(store, synthetic.BATCH_READINGS);
    const out = engine.ingestWorkOrder(store, { ...synthetic.MISMATCH_WORK_ORDER });
    assert.ok(out.warnings.some((w) => w.includes('不一致')));
    const state = engine.getState(store);
    assert.ok(state.anomalies.some((a) => a.type === 'WORK_ORDER_MISMATCH' && a.status === 'open'));
    // 换表生效不受影响
    assert.ok(state.anomalies.filter((a) => a.type === 'SUSPECTED_DROP_ZERO').every((a) => a.status === 'withdrawn'));
  });
});

// ---------- 4. 回拨 / 重传：读数对证据，非负 ----------
describe('读数回拨与重传：版本链 + 读数对证据', () => {
  test('重传订正（版本链）生效，回拨日用量钳 0，不产生负用量', () => {
    const store = demoStore();
    engine.ingestReadings(store, [
      { userId: 'U1002', meterId: 'M-RB-2', date: '2026-11-18', reading: 100, version: 1 },
      { userId: 'U1002', meterId: 'M-RB-2', date: '2026-11-19', reading: 120, version: 1 },
    ]);
    // 重传：120 订正为 118
    engine.ingestReading(store, { ...synthetic.RETRANSMISSION_READING }, '重传订正');
    const state = engine.getState(store);
    const eff = engine.effectiveReadingAt(store, 'M-RB-2', '2026-11-19');
    assert.equal(eff.reading, 118);
    assert.equal(eff.version, 2);
    // 旧版本仍保留在版本链中
    assert.ok(store.readings.some((r) => r.meterId === 'M-RB-2' && r.date === '2026-11-19' && r.version === 1));

    const row19 = findMeterRow(state, 'M-RB-2', '2026-11-19');
    assert.equal(row19.usage, 18); // 118 - 100，而非负
    assertNoNegative(state);
  });

  test('真实回拨（读数对证据）-> READING_ROLLBACK，用量钳 0', () => {
    const f = synthetic.ROLLBACK_FIXTURE;
    const store = engine.createStore();
    engine.registerUser(store, f.user);
    engine.registerMeter(store, f.meter);
    engine.addSegment(store, { userId: f.user.userId, meterId: f.meter.meterId, startDate: '2026-11-01', endDate: null, kind: 'single' });
    engine.ingestReadings(store, f.readings);
    const state = engine.getState(store);

    // v1=210 被 v2=65 的重传覆盖，20 日差值 = 65-60 = 5
    assert.equal(findMeterRow(state, f.meter.meterId, '2026-11-20').usage, 5);
    // 21 日 40 < 65：真实回拨
    const r21 = findMeterRow(state, f.meter.meterId, '2026-11-21');
    assert.equal(r21.usage, 0);
    assert.equal(r21.basis, 'rollback-clamped');
    const an = state.anomalies.find((a) => a.type === 'READING_ROLLBACK');
    assert.ok(an);
    assert.equal(an.status, 'open');
    assert.equal(an.evidence.kind, 'reading-pair');
    assert.equal(an.evidence.delta, -25);
    assertNoNegative(state);
  });

  test('回拨异常与掉零误判使用各自独立的证据类型，互不混淆', () => {
    const store = demoStore();
    engine.ingestReadings(store, synthetic.BATCH_READINGS);
    engine.ingestWorkOrder(store, { ...synthetic.REPLACEMENT_WORK_ORDER });
    engine.ingestReading(store, { ...synthetic.RETRANSMISSION_READING });
    const state = engine.getState(store);
    const drop = state.anomalies.find((a) => a.type === 'SUSPECTED_DROP_ZERO');
    assert.equal(drop.evidence.kind, 'workOrder'); // 换表 -> 工单证据
    // U1002 场景中 118 >= 100，不产生回拨异常；另造真实回拨验证
    engine.ingestReading(store, { userId: 'U1002', meterId: 'M-RB-2', date: '2026-11-20', reading: 50, version: 1 });
    const s2 = engine.getState(store);
    const rb = s2.anomalies.find((a) => a.type === 'READING_ROLLBACK');
    assert.ok(rb);
    assert.equal(rb.evidence.kind, 'reading-pair'); // 回拨 -> 读数对证据
    assertNoNegative(s2);
  });
});

// ---------- 5. HTTP 冒烟：页面与三个操作端点 ----------
describe('HTTP 服务（127.0.0.1，内置模块）', () => {
  let server;
  let base;

  before(async () => {
    process.env.PORT = '0';
    const mod = require('../src/server');
    server = mod.server;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function get(pathname) {
    const res = await fetch(base + pathname);
    assert.equal(res.status, 200);
    return res;
  }
  async function post(pathname) {
    const res = await fetch(base + pathname, { method: 'POST' });
    assert.equal(res.status, 200);
    return res.json();
  }

  test('首页包含 data-evidence-result 业务结果区与三个操作按钮', async () => {
    const res = await get('/');
    const html = await res.text();
    assert.ok(html.includes('data-evidence-result'));
    assert.ok(html.includes('接入换表前后读数'));
    assert.ok(html.includes('补交换表工单'));
    assert.ok(html.includes('打开用量修订') || html.includes('用量修订'));
  });

  test('三步操作依次处理，结果由接口实际得出且全程非负', async () => {
    await post('/api/reset');

    const r1 = await post('/api/demo/ingest-readings');
    assert.ok(r1.state.anomalies.some((a) => a.type === 'SUSPECTED_DROP_ZERO' && a.status === 'open'));
    assert.ok(r1.state.dailyUsage.every((r) => r.usage >= 0));

    const r2 = await post('/api/demo/ingest-work-order');
    assert.ok(r2.state.anomalies.filter((a) => a.type === 'SUSPECTED_DROP_ZERO').every((a) => a.status === 'withdrawn'));
    const u20 = r2.state.userDailyUsage.find((r) => r.userId === 'U1001' && r.date === '2026-11-20');
    assert.equal(u20.usage, 8);
    assert.ok(r2.state.dailyUsage.every((r) => r.usage >= 0));

    const r3 = await post('/api/demo/retransmission');
    const eff = r3.state.readings.filter((r) => r.meterId === 'M-RB-2' && r.date === '2026-11-19').sort((a, b) => b.version - a.version)[0];
    assert.equal(eff.reading, 118);
    assert.ok(r3.state.dailyUsage.every((r) => r.usage >= 0));

    const rev = await (await get('/api/revisions')).json();
    assert.ok(rev.revisions.some((s) => s.revisions.some((c) => c.kind === 'anomaly-status-changed')));
  });

  test('重复点击接入按钮不会重复写入读数', async () => {
    await post('/api/reset');
    const r1 = await post('/api/demo/ingest-readings');
    const count1 = r1.state.readings.length;
    const r2 = await post('/api/demo/ingest-readings');
    assert.equal(r2.state.readings.length, count1);
  });
});
