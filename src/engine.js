'use strict';

// 采集/仓储核心引擎（内存实现，零依赖）
//
// 证据分离原则：
//   1) 换表      -> 换表工单 workOrder 是唯一证据，生效后改写表计关系段(segments)
//   2) 读数回拨  -> 同表相邻读数对 (prevReading -> reading) 是证据
//   3) 重传      -> 同一 (meterId, date) 的版本链 version 是证据
//
// 累计口径：
//   - 按表号独立累计：同一 meterId 内相邻读数做差，新表从 0 开始，绝不跨表相减
//   - 按用户连续归并：依据关系段把各表各日用量挂到用户，换表日前后两段相加
//
// 不变式：任何日用量 usage >= 0（回拨/误判场景钳为 0 并生成异常）。

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

function createStore() {
  return {
    users: new Map(),          // userId -> { userId, name }
    meters: new Map(),         // meterId -> { meterId, meterNo }
    segments: [],              // 表计关系段 { id, userId, meterId, startDate, endDate, kind, workOrderId? }
    readings: [],              // 读数（含历史版本）{ id, userId, meterId, date, reading, version, receivedAt }
    workOrders: [],            // 换表工单 { id, userId, oldMeterId, newMeterId, replaceDate, oldFinalReading, newInitialReading, receivedAt }
    anomalies: [],             // 异常台账（持久，跨重算保留状态）
    snapshots: [],             // 每次处理后的全量快照（修订前后对比用）
    pendingAnomalySeq: 0,
  };
}

// ---------- 基础数据 ----------

function registerUser(store, user) {
  if (!store.users.has(user.userId)) {
    store.users.set(user.userId, { userId: user.userId, name: user.name });
  }
  return store.users.get(user.userId);
}

function registerMeter(store, meter) {
  if (!store.meters.has(meter.meterId)) {
    store.meters.set(meter.meterId, { meterId: meter.meterId, meterNo: meter.meterNo });
  }
  return store.meters.get(meter.meterId);
}

function addSegment(store, segment) {
  store.segments.push({
    id: segment.id || nextId('seg'),
    userId: segment.userId,
    meterId: segment.meterId,
    startDate: segment.startDate,
    endDate: segment.endDate ?? null,
    kind: segment.kind || 'single', // single | before-replace | after-replace
    workOrderId: segment.workOrderId ?? null,
  });
}

// ---------- 读数接入（含重传） ----------
// reading: { userId, meterId, date, reading, version }
function ingestReading(store, reading, label) {
  const existing = store.readings
    .filter((r) => r.meterId === reading.meterId && r.date === reading.date)
    .sort((a, b) => b.version - a.version)[0];

  const version = reading.version ?? (existing ? existing.version + 1 : 1);
  const record = {
    id: nextId('rdg'),
    userId: reading.userId,
    meterId: reading.meterId,
    date: reading.date,
    reading: reading.reading,
    version,
    receivedAt: reading.receivedAt || new Date().toISOString(),
  };
  store.readings.push(record);
  recompute(store, label);
  return { record: clone(record), snapshot: clone(store.snapshots[store.snapshots.length - 1]) };
}

function ingestReadings(store, list, label) {
  const out = [];
  for (const reading of list) {
    const existing = store.readings
      .filter((r) => r.meterId === reading.meterId && r.date === reading.date)
      .sort((a, b) => b.version - a.version)[0];
    const version = reading.version ?? (existing ? existing.version + 1 : 1);
    out.push({
      id: nextId('rdg'),
      userId: reading.userId,
      meterId: reading.meterId,
      date: reading.date,
      reading: reading.reading,
      version,
      receivedAt: reading.receivedAt || new Date().toISOString(),
    });
  }
  store.readings.push(...out);
  recompute(store, label);
  return out;
}

// 取某表某日的生效读数（版本号最大者）
function effectiveReadingAt(store, meterId, date) {
  return store.readings
    .filter((r) => r.meterId === meterId && r.date === date)
    .sort((a, b) => b.version - a.version)[0] || null;
}

// ---------- 换表工单接入 ----------
function ingestWorkOrder(store, wo) {
  if (store.workOrders.some((w) => w.id === wo.id)) {
    throw new Error(`工单 ${wo.id} 已存在，重复接入被拒绝`);
  }
  const record = {
    id: wo.id,
    userId: wo.userId,
    oldMeterId: wo.oldMeterId,
    newMeterId: wo.newMeterId,
    replaceDate: wo.replaceDate,
    oldFinalReading: wo.oldFinalReading,
    newInitialReading: wo.newInitialReading,
    receivedAt: wo.receivedAt || new Date().toISOString(),
  };
  store.workOrders.push(record);

  // 工单是换表的唯一证据：更新表计关系（旧段封口，新段启用）
  const openSeg = store.segments.find(
    (s) => s.userId === wo.userId && s.meterId === wo.oldMeterId && s.endDate === null
  );
  if (openSeg) {
    openSeg.endDate = wo.replaceDate;
    openSeg.kind = 'before-replace';
    openSeg.workOrderId = wo.id;
  }
  addSegment(store, {
    userId: wo.userId,
    meterId: wo.newMeterId,
    startDate: wo.replaceDate,
    endDate: null,
    kind: 'after-replace',
    workOrderId: wo.id,
  });

  recompute(store, `换表工单 ${wo.id} 到达：撤回掉零误判，两段重算`);

  // 工单与表底自洽性校验（自身证据内部一致性，不影响换表生效）
  const warnings = [];
  const oldFinal = effectiveReadingAt(store, wo.oldMeterId, wo.replaceDate);
  if (oldFinal && typeof wo.oldFinalReading === 'number' && oldFinal.reading !== wo.oldFinalReading) {
    warnings.push(`旧表 ${wo.oldMeterId} 换表日读数 ${oldFinal.reading} 与工单旧表底 ${wo.oldFinalReading} 不一致`);
  }
  const newFirst = store.readings
    .filter((r) => r.meterId === wo.newMeterId)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (newFirst && typeof wo.newInitialReading === 'number' && newFirst.reading < wo.newInitialReading) {
    warnings.push(`新表 ${wo.newMeterId} 首读数 ${newFirst.reading} 小于工单新表底 ${wo.newInitialReading}`);
  }
  for (const msg of warnings) {
    upsertAnomaly(store, {
      key: `WORK_ORDER_MISMATCH|${wo.id}|${msg}`,
      type: 'WORK_ORDER_MISMATCH',
      status: 'open',
      meterId: wo.oldMeterId,
      userId: wo.userId,
      date: wo.replaceDate,
      message: msg,
      evidence: { kind: 'workOrder', workOrderId: wo.id },
    });
  }
  if (warnings.length) recompute(store, `工单 ${wo.id} 自洽性校验告警`);
  return { record: clone(record), warnings, snapshot: clone(store.snapshots[store.snapshots.length - 1]) };
}

// ---------- 异常台账 ----------
function upsertAnomaly(store, a) {
  const found = store.anomalies.find((x) => x.key === a.key);
  if (found) {
    Object.assign(found, a, { id: found.id });
    return found;
  }
  store.pendingAnomalySeq += 1;
  const rec = { id: nextId('anm'), ...a };
  store.anomalies.push(rec);
  return rec;
}

function ownerAt(store, meterId, date) {
  const seg = store.segments.find(
    (s) => s.meterId === meterId && s.startDate <= date && (s.endDate === null || date <= s.endDate)
  );
  return seg || null;
}

// ---------- 全量重算 ----------
// 每次读数/工单处理后执行：按表独立累计 -> 按关系段归并用户 -> 生成日用量与异常
function recompute(store, label) {
  // 上一轮快照：用于识别“挂起 -> 正式”的重算转正行
  const prevSnap = store.snapshots[store.snapshots.length - 1] || null;
  const prevProvisional = new Set(
    (prevSnap ? prevSnap.dailyUsage : []).filter((r) => r.status === 'provisional').map((r) => `${r.meterId}|${r.date}`)
  );

  // 异常台账贯穿重算：先载入持久历史（含已撤回），再用本轮证据刷新状态
  const anomalies = store.anomalies.map((a) => ({ ...a }));
  const indexByKey = new Map(anomalies.map((a, i) => [a.key, i]));

  const ledger = (a) => {
    const idx = indexByKey.get(a.key);
    if (idx !== undefined) {
      const persisted = anomalies[idx];
      // 已被工单撤回的历史误判保持撤回；其余用本轮证据刷新
      if (persisted.status === 'withdrawn') return persisted;
      Object.assign(persisted, a, { id: persisted.id });
      return persisted;
    }
    const rec = { id: nextId('anm'), ...a };
    indexByKey.set(a.key, anomalies.length);
    anomalies.push(rec);
    return rec;
  };

  const meterIds = [...new Set(store.readings.map((r) => r.meterId))].sort();
  const dailyUsage = [];

  for (const meterId of meterIds) {
    // 版本链：每个日期只取最大版本（重传证据），再按日期排序
    const byDate = new Map();
    for (const r of store.readings.filter((x) => x.meterId === meterId)) {
      const cur = byDate.get(r.date);
      if (!cur || r.version > cur.version) byDate.set(r.date, r);
    }
    const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    let prev = null;
    for (const point of series) {
      const seg = ownerAt(store, meterId, point.date);
      const base = {
        id: nextId('use'),
        userId: seg ? seg.userId : point.userId,
        meterId,
        date: point.date,
        reading: point.reading,
        version: point.version,
        workOrderId: seg ? seg.workOrderId : null,
        segmentKind: seg ? seg.kind : 'unlinked',
      };

      if (!prev) {
        // 表计首个生效读数：无前置证据，用量置 0（新表从零开始）
        if (!seg) {
          // 新表首读数（通常为 0）先于工单到达：同样构成“读数掉零”误判并挂起
          ledger({
            key: `SUSPECTED_DROP_ZERO|${meterId}|${point.date}`,
            type: 'SUSPECTED_DROP_ZERO',
            status: 'open',
            meterId,
            userId: point.userId,
            date: point.date,
            message: `表 ${meterId} 在 ${point.date} 的首读数 ${point.reading} 无有效表计关系，疑似读数掉零（待换表工单证实）`,
            evidence: { kind: 'missing-meter-link', meterId, date: point.date },
          });
          dailyUsage.push({
            ...base,
            usage: 0,
            status: 'provisional',
            basis: 'unlinked-meter-delta',
            evidence: { kind: 'missing-meter-link', meterId, date: point.date },
          });
          prev = point;
          continue;
        }
        dailyUsage.push({ ...base, usage: 0, status: 'final', basis: 'first-reading', evidence: { kind: 'first-reading' } });
        prev = point;
        continue;
      }

      const delta = point.reading - prev.reading;

      if (delta < 0) {
        // 同表相邻读数对构成“读数回拨”证据：用量钳为 0，绝不产生负用量
        ledger({
          key: `READING_ROLLBACK|${meterId}|${point.date}`,
          type: 'READING_ROLLBACK',
          status: 'open',
          meterId,
          userId: base.userId,
          date: point.date,
          message: `表 ${meterId} 读数由 ${prev.reading} 回拨至 ${point.reading}（差值 ${delta}），日用量按 0 处理`,
          evidence: {
            kind: 'reading-pair',
            meterId,
            fromDate: prev.date,
            fromReading: prev.reading,
            toDate: point.date,
            toReading: point.reading,
            delta,
          },
        });
        dailyUsage.push({
          ...base,
          usage: 0,
          status: 'final',
          basis: 'rollback-clamped',
          evidence: { kind: 'reading-pair', fromDate: prev.date, fromReading: prev.reading, delta },
        });
        prev = point;
        continue;
      }

      if (!seg) {
        // 读数找不到有效表计关系：工单后到时，仓储端先误判为“读数掉零”
        // 按表独立累计仍保留真实差值；用户归并挂起为 provisional，绝不跨表相减
        ledger({
          key: `SUSPECTED_DROP_ZERO|${meterId}|${point.date}`,
          type: 'SUSPECTED_DROP_ZERO',
          status: 'open',
          meterId,
          userId: point.userId,
          date: point.date,
          message: `表 ${meterId} 在 ${point.date} 的读数 ${point.reading} 无有效表计关系，疑似读数掉零（待换表工单证实）`,
          evidence: { kind: 'missing-meter-link', meterId, date: point.date },
        });
        dailyUsage.push({
          ...base,
          usage: delta,
          status: 'provisional',
          basis: 'unlinked-meter-delta',
          evidence: { kind: 'missing-meter-link', meterId, date: point.date },
        });
        prev = point;
        continue;
      }

      dailyUsage.push({
        ...base,
        usage: delta,
        status: 'final',
        basis: seg ? 'consecutive-delta' : 'unlinked-meter-delta',
        evidence: { kind: seg ? 'reading-pair' : 'missing-meter-link', fromDate: prev.date, fromReading: prev.reading, delta, meterId, date: point.date },
      });
      prev = point;
    }
  }

  // 换表工单到达后：撤回它能解释的“掉零”误判（工单证据覆盖缺关系证据）
  for (const wo of store.workOrders) {
    for (const an of anomalies) {
      if (an.type !== 'SUSPECTED_DROP_ZERO' || an.status !== 'open') continue;
      if (an.meterId !== wo.newMeterId) continue;
      if (an.date < wo.replaceDate) continue;
      an.status = 'withdrawn';
      an.message = `${an.message}；已由换表工单 ${wo.id} 证实为新表启用，误判撤回`;
      an.evidence = { kind: 'workOrder', workOrderId: wo.id, replaceDate: wo.replaceDate };
      an.withdrawnAt = new Date().toISOString();
    }
  }

  // 挂起记录随关系补齐而转正式（撤回旧解释 -> 两段重算的行级标记）
  for (const row of dailyUsage) {
    const wasProvisional = prevProvisional.has(`${row.meterId}|${row.date}`);
    if (row.segmentKind !== 'unlinked' && (row.status === 'provisional' || wasProvisional)) {
      row.status = 'final';
      row.basis = 'recomputed-after-work-order';
    }
  }

  // 持久台账与本轮结果对齐：本轮证据不再支持的 open 异常转为 withdrawn（保留轨迹）
  const liveKeys = new Set(
    anomalies.filter((a) => a.status !== 'withdrawn').map((a) => a.key)
  );
  for (const a of anomalies) {
    if (a.status === 'open' && !liveKeys.has(a.key)) a.status = 'withdrawn';
  }
  store.anomalies = anomalies.map((a) => ({ ...a }));

  dailyUsage.sort((a, b) =>
    a.userId.localeCompare(b.userId) || a.date.localeCompare(b.date) || a.meterId.localeCompare(b.meterId)
  );

  // 用户级连续归并：同一用户同日各表用量求和（换表日 = 旧表尾段 + 新表首段）
  const userDaily = new Map();
  for (const row of dailyUsage) {
    const key = `${row.userId}|${row.date}`;
    const agg = userDaily.get(key) || {
      userId: row.userId,
      date: row.date,
      usage: 0,
      meterIds: [],
      provisional: false,
      workOrderId: null,
    };
    agg.usage += row.usage;
    if (!agg.meterIds.includes(row.meterId)) agg.meterIds.push(row.meterId);
    if (row.status === 'provisional') agg.provisional = true;
    if (row.workOrderId) agg.workOrderId = row.workOrderId;
    userDaily.set(key, agg);
  }
  const userDailyUsage = [...userDaily.values()].map((x) => ({
    ...x,
    meterIds: [...x.meterIds].sort(),
    status: x.provisional ? 'provisional' : 'final',
  })).sort((a, b) => a.userId.localeCompare(b.userId) || a.date.localeCompare(b.date));

  // 不变式守卫：任何口径下都不允许负用量
  for (const row of dailyUsage) {
    if (row.usage < 0 || !Number.isFinite(row.usage)) {
      throw new Error(`不变式被破坏：表 ${row.meterId} 在 ${row.date} 出现负用量 ${row.usage}`);
    }
  }
  for (const row of userDailyUsage) {
    if (row.usage < 0 || !Number.isFinite(row.usage)) {
      throw new Error(`不变式被破坏：用户 ${row.userId} 在 ${row.date} 出现负用量 ${row.usage}`);
    }
  }

  const snapshot = buildSnapshot(store, dailyUsage, userDailyUsage, anomalies, label);
  store.snapshots.push(snapshot);
  return snapshot;
}

function buildSnapshot(store, dailyUsage, userDailyUsage, anomalies, label) {
  const prev = store.snapshots[store.snapshots.length - 1] || null;
  const revisions = prev ? diffSnapshots(prev, { dailyUsage, userDailyUsage, anomalies }) : [];
  return {
    id: nextId('snap'),
    label: label || (store.snapshots.length === 0 ? '初始状态' : `处理 #${store.snapshots.length + 1}`),
    at: new Date().toISOString(),
    readings: clone(store.readings),
    workOrders: clone(store.workOrders),
    segments: clone(store.segments),
    dailyUsage: clone(dailyUsage),
    userDailyUsage: clone(userDailyUsage),
    anomalies: clone(anomalies),
    revisions,
  };
}

// ---------- 用量修订：撤回旧解释 + 按两段重算的前后对比 ----------
function diffSnapshots(before, afterState) {
  const changes = [];
  const keyOf = (r) => `${r.userId}|${r.meterId}|${r.date}`;
  const beforeMap = new Map(before.dailyUsage.map((r) => [keyOf(r), r]));
  const afterMap = new Map(afterState.dailyUsage.map((r) => [keyOf(r), r]));

  for (const [key, after] of afterMap) {
    const beforeRow = beforeMap.get(key);
    if (!beforeRow) {
      changes.push({ kind: 'usage-added', key, before: null, after: clone(after) });
    } else if (beforeRow.usage !== after.usage || beforeRow.status !== after.status || beforeRow.basis !== after.basis) {
      changes.push({
        kind: 'usage-revised',
        key,
        before: { usage: beforeRow.usage, status: beforeRow.status, basis: beforeRow.basis, segmentKind: beforeRow.segmentKind },
        after: { usage: after.usage, status: after.status, basis: after.basis, segmentKind: after.segmentKind },
      });
    }
  }
  for (const [key, beforeRow] of beforeMap) {
    if (!afterMap.has(key)) changes.push({ kind: 'usage-removed', key, before: clone(beforeRow), after: null });
  }

  const beforeAn = new Map(before.anomalies.map((a) => [a.key, a]));
  const afterAn = new Map(afterState.anomalies.map((a) => [a.key, a]));
  for (const [key, after] of afterAn) {
    const b = beforeAn.get(key);
    if (!b) changes.push({ kind: 'anomaly-opened', key, after: clone(after) });
    else if (b.status !== after.status) {
      changes.push({ kind: 'anomaly-status-changed', key, before: { status: b.status }, after: { status: after.status, evidence: clone(after.evidence) } });
    }
  }
  return changes;
}

// ---------- 查询视图 ----------
function getState(store) {
  const snap = store.snapshots[store.snapshots.length - 1] || null;
  return snap
    ? clone(snap)
    : { readings: [], workOrders: [], segments: clone(store.segments), dailyUsage: [], userDailyUsage: [], anomalies: [], revisions: [] };
}

function getRevisions(store) {
  return store.snapshots.map((s, i) => ({
    index: i,
    label: s.label,
    at: s.at,
    revisions: s.revisions,
  }));
}

module.exports = {
  createStore,
  registerUser,
  registerMeter,
  addSegment,
  ingestReading,
  ingestReadings,
  ingestWorkOrder,
  recompute,
  getState,
  getRevisions,
  effectiveReadingAt,
  ownerAt,
  clone,
};
