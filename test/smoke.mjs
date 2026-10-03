/**
 * dsh-429-monitor 冒烟测试 — 在 Node 下模拟浏览器模块加载器，验证纯逻辑函数。
 *
 * 运行：node test/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ---- 模拟 window.__ModuleLoader__.load ----
let registration = null;
globalThis.window = {
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  },
  __ModuleLoader__: {
    load(reg) { registration = reg; },
  },
};

// ---- 加载 client.js（经典脚本） ----
const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
vm.runInThisContext(code);
if (!registration) {
  console.error('client.js 未调用 window.__ModuleLoader__.load ✘');
  process.exit(1);
}
console.log('✔ client.js 已注册模块:', registration.id);

// ---- 执行 factory（require 桩） ----
const mockReact = {
  createElement: () => ({}),
  useState: () => [0, () => {}],
  useRef: () => ({}),
  useEffect: () => {},
  useSyncExternalStore: (sub, get) => get(),
};
const mod = registration.factory((name) => {
  if (name === 'react') return mockReact;
  throw new Error('unexpected require: ' + name);
});
console.log('✔ factory 执行 OK，导出:', Object.keys(mod).join(', '));
if (typeof mod.apply !== 'function' || !Array.isArray(mod.inject)) {
  console.error('缺少 apply / inject 导出 ✘');
  process.exit(1);
}

const { is429Message, isRateLimitCode, deriveSessionStatus, activityInfo, latest429Stop, pushDetection, subscribe, getState, clearDetections, toggleRetry, resetRetryCount, sendToSession } = mod;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; console.error(`  ✘ ${name} ${extra}`); }
}

console.log('\n[dsh-429-monitor] smoke test\n');

console.log('-- is429Message --');
check('命中 "429"', is429Message('本运行失败429 请求过于频繁'), is429Message('x'));
check('命中 "rate limit"（大小写不敏感）', is429Message('Rate Limit exceeded'));
check('命中 "too many requests"', is429Message('Too Many Requests'));
check('命中 "请求过于频繁"', is429Message('请求过于频繁，请稍后重试'));
check('命中 "配额不足"', is429Message('配额不足'));
check('不误报普通错误', !is429Message('connection timeout'));
check('空串不命中', !is429Message(''));
check('非字符串不命中', !is429Message(undefined) && !is429Message(null));

console.log('-- isRateLimitCode --');
check('RATE_LIMIT', isRateLimitCode('RATE_LIMIT'));
check('429', isRateLimitCode('429'));
check('HTTP 429', isRateLimitCode('HTTP 429'));
check('大小写不敏感', isRateLimitCode('rate_limit'));
check('非限流码不命中', !isRateLimitCode('AUTH'));
check('非字符串不命中', !isRateLimitCode(429));

console.log('-- deriveSessionStatus --');
check('running', deriveSessionStatus({ running: true }) === 'running');
check('idle', deriveSessionStatus({ running: false }) === 'idle');
check('openState error', deriveSessionStatus({ openState: 'error', running: false }) === 'error');
check('promptError', deriveSessionStatus({ running: false, promptError: { op: 'send' } }) === 'error');
check('blank', deriveSessionStatus({ running: false, blank: true }) === 'blank');
check('lastAgentError', deriveSessionStatus({ running: false, lastAgentError: 'boom' }) === 'error');
check('undefined 会话', deriveSessionStatus(undefined) === 'unknown');

console.log('-- activityInfo --');
const actNow = Date.now();
const actInfo = activityInfo({
  nodes: [{ kind: 'assistant', seq: 1, time: actNow }],
  turnTimings: new Map([[1, { startTime: actNow - 5000 }]]),
});
check('latestTurn 识别', actInfo.latestTurn === 1);
check('runningSince 识别', actInfo.runningSince === actNow - 5000);
check('lastTime 识别', actInfo.lastTime === actNow);

console.log('-- latest429Stop（只取最新状态，忽略历史） --');
const now = Date.now();
const mkSession = (nodes, extra = {}) => ({
  running: false,
  nodes,
  turnTimings: new Map([[3, { startTime: now - 1000 }]]),
  ...extra,
});
// 1. 最新回合 turn-error 429 → 命中
const s1 = mkSession([
  { kind: 'assistant', seq: 1 },
  { kind: 'turn-error', seq: 2, code: 'RATE_LIMIT', message: '429 Too Many Requests', time: now - 5000, turn: 3 },
]);
const r1 = latest429Stop(s1);
check('最新回合 429 停止 → 命中', !!r1 && r1.key === 'turn-error:2', JSON.stringify(r1));
check('命中返回 code', r1 && r1.code === 'RATE_LIMIT');
check('命中返回 message', r1 && typeof r1.message === 'string');

// 2. 历史错误：429 发生在旧回合（turn 1 < 最新 turn 3），后面已有新对话 → 忽略
const s2 = mkSession([
  { kind: 'turn-error', seq: 1, code: 'RATE_LIMIT', message: '429', time: now - 60000, turn: 1 },
  { kind: 'assistant', seq: 2 },
  { kind: 'assistant', seq: 3, time: now - 1000 },
]);
check('多轮前的历史 429 → 忽略', latest429Stop(s2) === null);

// 3. 会话正在运行 → 忽略
const s3 = mkSession([{ kind: 'turn-error', seq: 2, code: 'RATE_LIMIT', message: '429', time: now - 5000, turn: 3 }], { running: true });
check('会话运行中 → 忽略', latest429Stop(s3) === null);

// 4. 过期错误（超过 stopWindowMs）→ 忽略
mod.__setStopWindow(60000);
const s4 = mkSession([{ kind: 'turn-error', seq: 2, code: 'RATE_LIMIT', message: '429', time: now - 120000, turn: 3 }]);
check('过期（>stopWindowMs）→ 忽略', latest429Stop(s4) === null);

// 5. 最新回合结束但错误不是 429 → 忽略
const s5 = mkSession([{ kind: 'turn-error', seq: 2, code: 'AUTH', message: 'bad key', time: now - 5000, turn: 3 }]);
check('最新回合非 429 错误 → 忽略', latest429Stop(s5) === null);

// 6. 只有 model-retry（宿主内部重试）→ 忽略
const s6 = mkSession([{ kind: 'model-retry', seq: 2, failure: { code: 'RATE_LIMIT', status: 429 }, provider: 'deepseek', time: now - 5000, turn: 3 }]);
check('仅有 model-retry → 忽略（宿主在重试）', latest429Stop(s6) === null);

// 7. 无节点 → null
check('空会话 → null', latest429Stop({ nodes: [] }) === null);
check('undefined → null', latest429Stop(undefined) === null);

console.log('-- pushDetection / store --');
clearDetections();
pushDetection({ message: 'rate limit', code: 'RATE_LIMIT', source: 'turn-error', sessionId: 's1' });
let st = getState();
check('记录条数为 1', st.detections.length === 1, JSON.stringify(st.detections));
check('弹出小窗（popupVisible）', st.popupVisible === true);
check('状态被置为 interrupted', st.status === 'interrupted');

pushDetection({ message: 'rate limit', code: 'RATE_LIMIT', source: 'turn-error', sessionId: 's1' });
check('同签名去重后仍为 1 条', getState().detections.length === 1);

let notified = 0;
const unsub = subscribe(() => { notified += 1; });
pushDetection({ message: 'too many requests', code: '429', source: 'turn-error', sessionId: 's1' });
check('订阅收到通知', notified > 0);
unsub();
const before = notified;
pushDetection({ message: 'quota', code: 'RATE_LIMIT', source: 'turn-error', sessionId: 's1' });
check('退订后不再通知', notified === before);

clearDetections();
check('清空记录', getState().detections.length === 0);

console.log('-- 未绑定宿主时禁止消息与设置 --');
check('自动继续默认关闭', getState().retryEnabled === false);
check('没有客户端自动投递', getState().connection === 'unbound');
check('不能暂存到未验证宿主', mod.stageMessage('test', 's1', 0).ok === false);
console.log(`结果: ${passed} 通过, ${failed} 失败`);
if (failed) process.exit(1);
