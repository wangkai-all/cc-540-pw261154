'use strict';

// 合成数据：可复现题述全部情形
//
// 场景 A（居民 U1001 / 机械表 M-OLD-1 -> M-NEW-1）：
//   - 11/18~11/19 旧表正常读数
//   - 11/20 换表，新表从 0 开始；换表工单“迟到”，仓储端先只收到新表读数
//     -> 新表读数找不到表计关系，被误判 SUSPECTED_DROP_ZERO（读数掉零），用户归并挂起
//   - 11/21 补交换表工单 -> 误判撤回，表计关系更新为两段，日用量按两段重算
//
// 场景 B（居民 U1002 / 机械表 M-RB-2，无换表）：
//   - 11/19 读数 120，重传样例 v2 回拨为 118（抄表多抄订正）
//   - 同表相邻读数对是“读数回拨”的自有证据：日用量钳 0，绝不出现负用量

const USERS = [
  { userId: 'U1001', name: '居民 1001' },
  { userId: 'U1002', name: '居民 1002' },
];

const METERS = [
  { meterId: 'M-OLD-1', meterNo: 'OLD-0001' },
  { meterId: 'M-NEW-1', meterNo: 'NEW-0001' },
  { meterId: 'M-RB-2', meterNo: 'RB-0002' },
];

// 初始表计关系：只登记旧表；新表关系要等工单到达
const INITIAL_SEGMENTS = [
  { userId: 'U1001', meterId: 'M-OLD-1', startDate: '2026-11-01', endDate: null, kind: 'single' },
  { userId: 'U1002', meterId: 'M-RB-2', startDate: '2026-11-01', endDate: null, kind: 'single' },
];

// 第一批接入：换表前后读数（工单尚未到达）
const BATCH_READINGS = [
  // 旧表 M-OLD-1
  { userId: 'U1001', meterId: 'M-OLD-1', date: '2026-11-18', reading: 100, version: 1 },
  { userId: 'U1001', meterId: 'M-OLD-1', date: '2026-11-19', reading: 112, version: 1 },
  { userId: 'U1001', meterId: 'M-OLD-1', date: '2026-11-20', reading: 120, version: 1 },
  // 新表 M-NEW-1：从零开始，工单迟到 -> 先被误判掉零
  { userId: 'U1001', meterId: 'M-NEW-1', date: '2026-11-20', reading: 0, version: 1 },
  { userId: 'U1001', meterId: 'M-NEW-1', date: '2026-11-21', reading: 7, version: 1 },
  // 居民 U1002：正常抄表
  { userId: 'U1002', meterId: 'M-RB-2', date: '2026-11-18', reading: 100, version: 1 },
  { userId: 'U1002', meterId: 'M-RB-2', date: '2026-11-19', reading: 120, version: 1 },
];

// 迟到的换表工单
const REPLACEMENT_WORK_ORDER = {
  id: 'WO-20261120-001',
  userId: 'U1001',
  oldMeterId: 'M-OLD-1',
  newMeterId: 'M-NEW-1',
  replaceDate: '2026-11-20',
  oldFinalReading: 120,
  newInitialReading: 0,
};

// 重传样例：11/19 抄表员多抄 2，订正重传 118（版本号 +1）
const RETRANSMISSION_READING = {
  userId: 'U1002',
  meterId: 'M-RB-2',
  date: '2026-11-19',
  reading: 118,
  version: 2,
};

// 异常路径合成样例（测试用，不在网页演示数据中）：
// 回拨发生在已有历史序列之后，验证不会变成负用量
const ROLLBACK_FIXTURE = {
  user: { userId: 'U2001', name: '居民 2001' },
  meter: { meterId: 'M-RB-9', meterNo: 'RB-0009' },
  readings: [
    { userId: 'U2001', meterId: 'M-RB-9', date: '2026-11-18', reading: 50, version: 1 },
    { userId: 'U2001', meterId: 'M-RB-9', date: '2026-11-19', reading: 60, version: 1 },
    // 210 为明显异常大值，重传订正为 65：版本链证据
    { userId: 'U2001', meterId: 'M-RB-9', date: '2026-11-20', reading: 210, version: 1 },
    { userId: 'U2001', meterId: 'M-RB-9', date: '2026-11-20', reading: 65, version: 2 },
    // 真回拨：次日读数低于前值，读数对证据，用量钳 0
    { userId: 'U2001', meterId: 'M-RB-9', date: '2026-11-21', reading: 40, version: 1 },
  ],
};

// 工单与表底不一致的异常样例（测试用）
const MISMATCH_WORK_ORDER = {
  ...REPLACEMENT_WORK_ORDER,
  id: 'WO-MISMATCH-001',
  oldFinalReading: 999,
};

module.exports = {
  USERS,
  METERS,
  INITIAL_SEGMENTS,
  BATCH_READINGS,
  REPLACEMENT_WORK_ORDER,
  RETRANSMISSION_READING,
  ROLLBACK_FIXTURE,
  MISMATCH_WORK_ORDER,
};
