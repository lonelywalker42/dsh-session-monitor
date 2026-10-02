// dsh-session-monitor 主机侧核心逻辑单测
// 运行：node host/test-core.mjs
import { createMonitorCore, foldStateFromEvents, isRateLimitCode, isRateLimitMessage, is429Failure, turnEndFailure, isQuestionTool, isTokenPlanExhausted } from './session-monitor.mjs'

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log('  ✔ ' + name) }
  else { failed += 1; console.error('  ✘ ' + name + ' ' + extra) }
}
// continueSession 采用异步 followup（setImmediate 防 session append 重入），断言前需等一个 tick
const tick = () => new Promise((r) => setImmediate(r))

console.log('\n[dsh-session-monitor] core test\n')

console.log('-- 429 判定 --')
check('RATE_LIMIT 码', isRateLimitCode('RATE_LIMIT'))
check('HTTP 429 码', isRateLimitCode('HTTP 429'))
check('429 文案', isRateLimitMessage('本运行失败429 请求过于频繁'))
check('rate limit 文案', isRateLimitMessage('Rate limit exceeded'))
check('非 429 码', !isRateLimitCode('AUTH'))
check('is429Failure 组合', is429Failure({ code: 'RATE_LIMIT', status: 429, message: 'x' }))
check('is429Failure status', is429Failure({ status: 429 }))
check('is429Failure 非429', !is429Failure({ code: 'SERVER' }))
const te = turnEndFailure({ data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429' } } } })
check('turnEndFailure 解析', te && te.code === 'RATE_LIMIT')
check('turnEndFailure 非错误', turnEndFailure({ data: { reason: { kind: 'ok' } } }) === null)
check('isQuestionTool', isQuestionTool('ask_user_question') && !isQuestionTool('pwsh'))

console.log('-- 状态机：加入监控器与状态流转 --')
const core = createMonitorCore()
let sid = 'session-a'
// turn/start → active + monitored
core.onSessionEvent(sid, { type: 'turn/start', seq: 1 })
let rec = core.records.get(sid)
check('turn/start → 加入监控器', rec.monitored === true)
check('turn/start → 活动中', rec.state === 'active')

// approval/asked → waiting-approval
core.onSessionEvent(sid, { type: 'approval/asked', seq: 2 })
check('approval/asked → 等待批准', core.records.get(sid).state === 'waiting-approval')

// question tool → waiting-answer
core.onSessionEvent(sid, { type: 'tool/call', data: { name: 'ask_user_question' }, seq: 3 })
check('提问工具 → 等待回答', core.records.get(sid).state === 'waiting-answer')

// llm/retry 429 → 记录重试，状态保持，不自动发
const alertsBefore = core.records.get(sid).alerts.length
core.onSessionEvent(sid, { type: 'llm/retry', data: { failure: { code: 'RATE_LIMIT', message: 'rate limit' } }, seq: 4 })
check('llm/retry → 记录重试告警', core.records.get(sid).alerts.length === alertsBefore + 1)
check('llm/retry → 状态仍等待回答', core.records.get(sid).state === 'waiting-answer')

// turn/end 正常 → complete，保持在监控器（等待用户阅读）
core.onSessionEvent(sid, { type: 'turn/end', data: { reason: { kind: 'ok' } }, seq: 5 })
rec = core.records.get(sid)
check('turn/end 成功 → 工作完成', rec.state === 'complete')
check('工作完成不立即退出监控器', rec.monitored === true)

// markRead → 移出监控器
const mr = core.markRead(sid)
check('markRead → ok', mr.ok === true)
check('markRead → 移出监控器', core.records.get(sid).monitored === false)

console.log('-- 429 停止 + 自动继续（按会话精确路由） --')
const core2 = createMonitorCore()
const sent = []
function fakeAgent() {
  return { followup(msg) { sent.push(msg) } }
}
// 会话 A 与 B 的 agent
core2.agents.set('session-a', fakeAgent())
core2.agents.set('session-b', fakeAgent())

const settings = { autoRetry: true, maxRetries: 3 }
// 会话 A 进入活动 → 429 停止（应自动继续，且只发给 A）
core2.onSessionEvent('session-a', { type: 'turn/start', seq: 1 }, { settings })
core2.onSessionEvent('session-a', { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 Too Many Requests' } } }, seq: 2 }, { settings })
let recA = core2.records.get('session-a')
check('A: turn/end RATE_LIMIT → 429 错误', recA.state === 'error429')
check('A: 429 告警已记录', recA.alerts.some((a) => a.kind === '429'))
await tick() // 等待异步 followup 执行
check('A: 自动继续已发送（1 次）', sent.length === 1, 'sent=' + sent.length)
check('A: 发送内容是继续', sent[0] && sent[0].content && sent[0].content[0] && sent[0].content[0].text === '继续')
check('A: retries 计数 1', recA.retries === 1)

// 同一 429 停止重复事件 → 不再发（同一事件不会重复，但手动重放同 seq 由 autoSent 去重）
core2.onSessionEvent('session-a', { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 Too Many Requests' } } }, seq: 2 }, { settings })
await tick()
check('A: 同 key 去重不重复发', sent.length === 1, 'sent=' + sent.length)

// 跨会话：B 完全独立，A 的自动继续绝不发给 B
check('B: 无收到任何继续', core2.records.get('session-b') === undefined || core2.records.get('session-b').retries === 0)

// maxRetries 上限：手动把 retries 推到上限再触发新停止 → 不发
recA.retries = 3
core2.onSessionEvent('session-a', { type: 'turn/start', seq: 10 }, { settings })
core2.onSessionEvent('session-a', { type: 'turn/end', data: { reason: { kind: 'error', error: { code: '429', message: 'rate' } } }, seq: 11 }, { settings })
const before = sent.length
check('A: 达到 maxRetries 后不再自动发', sent.length === before)

// 关闭自动继续 → 不发
const before3 = sent.length
const core3 = createMonitorCore()
core3.agents.set('session-a2', fakeAgent())
core3.onSessionEvent('session-a2', { type: 'turn/start', seq: 1 }, { settings: { autoRetry: false, maxRetries: 3 } })
core3.onSessionEvent('session-a2', { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }, seq: 2 }, { settings: { autoRetry: false, maxRetries: 3 } })
check('关闭自动继续 → 不发送', sent.length === before3)

// 手动继续（无 agent 时失败）
const core4 = createMonitorCore()
core4.onSessionEvent('session-x', { type: 'turn/start', seq: 1 })
const r = core4.continueSession('session-x')
check('无 agent 时手动继续 → 失败', r.ok === false && r.reason === 'no-agent')

console.log('-- 多会话快照 --')
const core5 = createMonitorCore()
core5.agents.set('s1', fakeAgent())
core5.agents.set('s2', fakeAgent())
core5.onSessionEvent('s1', { type: 'turn/start', seq: 1 })
core5.onSessionEvent('s2', { type: 'turn/start', seq: 1 })
core5.onSessionEvent('s1', { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }, seq: 2 }, { settings: { autoRetry: false, maxRetries: 3 } })
const snap = core5.snapshot({ autoRetry: false })
check('快照包含 2 个会话', snap.sessions.length === 2)
check('快照按活动时间排序', snap.sessions[0].state !== undefined)

console.log('-- 日志折叠（全量对账兜底，覆盖全部会话） --')
check('空日志 → idle', foldStateFromEvents([]).state === 'idle')
const f429 = foldStateFromEvents([
  { type: 'turn/start', seq: 1 },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 too many' } } }, seq: 2 },
])
check('折叠: turn/end RATE_LIMIT → 429 错误', f429.state === 'error429' && f429.alert.kind === '429')
const fOk = foldStateFromEvents([
  { type: 'turn/start', seq: 1 },
  { type: 'turn/end', data: { reason: { kind: 'ok' } }, seq: 2 },
])
check('折叠: turn/end 成功 → 工作完成', fOk.state === 'complete')
const fOpen = foldStateFromEvents([{ type: 'turn/start', seq: 1 }])
check('折叠: 未闭合回合 → 活动中', fOpen.state === 'active' && fOpen.running === true)
const fApproval = foldStateFromEvents([{ type: 'approval/asked', seq: 5 }])
check('折叠: approval/asked → 等待批准', fApproval.state === 'waiting-approval')
const fAsk = foldStateFromEvents([{ type: 'tool/call', data: { name: 'ask_user_question' }, seq: 6 }])
check('折叠: 提问工具 → 等待回答', fAsk.state === 'waiting-answer')
const fRetry = foldStateFromEvents([{ type: 'llm/retry', data: { failure: { code: 'RATE_LIMIT' } }, seq: 7 }])
check('折叠: 仅 retry → idle + retry 告警', fRetry.state === 'idle' && fRetry.alert && fRetry.alert.kind === 'retry')
// 最新边界优先（历史 429 之后有新回合）
const fNewer = foldStateFromEvents([
  { type: 'turn/start', seq: 1 },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }, seq: 2 },
  { type: 'turn/start', seq: 3 },
  { type: 'assistant/chunk', seq: 4 },
])
check('折叠: 历史 429 后有新回合 → 活动中', fNewer.state === 'active')

console.log('-- resolveFromFold（对账入口） --')
const core6 = createMonitorCore()
core6.resolveFromFold('s-fold', foldStateFromEvents([
  { type: 'turn/start', seq: 1 },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 quota' } } }, seq: 2 },
]))
let recF = core6.records.get('s-fold')
check('对账: 加入监控器', recF !== undefined && recF.monitored === true)
check('对账: 状态为 429 错误', recF.state === 'error429')
check('对账: 告警已记录', recF.alerts.some((a) => a.kind === '429'))
// 重复对账（同 seq）不重复告警
core6.resolveFromFold('s-fold', foldStateFromEvents([
  { type: 'turn/start', seq: 1 },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 quota' } } }, seq: 2 },
]))
check('对账: 同 seq 告警去重', core6.records.get('s-fold').alerts.filter((a) => a.kind === '429').length === 1)
// idle 折叠不加入监控
const core7 = createMonitorCore()
core7.resolveFromFold('s-void', foldStateFromEvents([]))
check('对账: idle 不加入监控', core7.records.get('s-void') === undefined || core7.records.get('s-void').monitored === false)

console.log('-- agentResolver 回退（0.1.2 权威注册表兜底） --')
const sent2 = []
const fakeAgent2 = () => ({ followup(m) { sent2.push(m) } })
// 本地 agents 映射为空，但 agentResolver 能查到 → continueSession 应成功
const core8 = createMonitorCore({ agentResolver: (id) => (id === 's-resolved' ? fakeAgent2() : undefined) })
core8.onSessionEvent('s-resolved', { type: 'turn/start', seq: 1 })
const r8 = core8.continueSession('s-resolved')
await tick()
check('resolver 兜底: 发送成功', r8.ok === true && sent2.length === 1)
check('resolver 兜底: 自愈本地映射', core8.agents.has('s-resolved') === true)
check('resolver 兜底: retries 计数', core8.records.get('s-resolved').retries === 1)
// resolver 也查不到 → 仍失败
const core9 = createMonitorCore({ agentResolver: () => undefined })
core9.onSessionEvent('s-none', { type: 'turn/start', seq: 1 })
const r9 = core9.continueSession('s-none')
check('resolver 查不到 → no-agent', r9.ok === false && r9.reason === 'no-agent')

console.log('-- 首次 429 成功、恢复后再次 429 也成功（0.1.2 fold 重置适配） --')
const sent3 = []
const coreA = createMonitorCore({ agentResolver: () => ({ followup(m) { sent3.push(m) } }) })
const settings3 = { autoRetry: true, maxRetries: 3 }
// 首次 429 → fold 触发自动发送
coreA.resolveFromFold('s-r', foldStateFromEvents([
  { type: 'turn/start', seq: 1 },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 a' } } }, seq: 2 },
]), { settings: settings3 })
await tick()
check('首次 429 自动发送成功', sent3.length === 1 && coreA.records.get('s-r').retries === 1, 'sent=' + sent3.length)
// 会话恢复（fold 折叠出 active，turn/start 事件可能未达 live 监听）→ 应重置发送状态
coreA.resolveFromFold('s-r', foldStateFromEvents([
  { type: 'turn/start', seq: 3 },
  { type: 'assistant/chunk', seq: 4 },
]), { settings: settings3 })
check('恢复后 retries 重置为 0', coreA.records.get('s-r').retries === 0)
// 再次 429（新 seq）→ 应再次自动发送
coreA.resolveFromFold('s-r', foldStateFromEvents([
  { type: 'turn/start', seq: 5 },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 b' } } }, seq: 6 },
]), { settings: settings3 })
await tick()
check('再次 429 也自动发送', sent3.length === 2, 'sent=' + sent3.length)
// 同一 429 不重复发（autoSent 去重仍有效）
coreA.resolveFromFold('s-r', foldStateFromEvents([
  { type: 'turn/start', seq: 7 },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 b' } } }, seq: 6 },
]), { settings: settings3 })
await tick()
check('同一 429 去重不重复发', sent3.length === 2, 'sent=' + sent3.length)

console.log('-- 429 精细化：token plan 额度用尽 → 定时重试（不立即发） --')
check('isTokenPlanExhausted 判定', isTokenPlanExhausted('token plan entitlement exhausted') && !isTokenPlanExhausted('inference tpm exhausted'))
const sent4 = []
const coreT = createMonitorCore({
  agentResolver: () => ({ followup(m) { sent4.push(m) } }),
  tokenPlanRetryMs: 120, // 测试用短间隔
})
const settings4 = { autoRetry: true, maxRetries: 3 }
// token-plan 429 → 不立即发送
coreT.resolveFromFold('s-tp', foldStateFromEvents([
  { type: 'turn/start', seq: 1 },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429: token plan entitlement exhausted' } } }, seq: 2 },
]), { settings: settings4 })
await tick()
check('额度用尽不立即发送', sent4.length === 0, 'sent=' + sent4.length)
check('进入定时重试（建立定时器）', coreT.tokenPlanTimers.has('s-tp'))
check('statusText 标注额度用尽', (coreT.records.get('s-tp').statusText || '').includes('额度用尽'))
// 定时触发（120ms 后第一次发送）
await new Promise((r) => setTimeout(r, 150))
check('定时器触发发送「继续」', sent4.length === 1, 'sent=' + sent4.length)
// 会话恢复 → 清除定时器
coreT.resolveFromFold('s-tp', foldStateFromEvents([
  { type: 'turn/start', seq: 3 },
  { type: 'assistant/chunk', seq: 4 },
]), { settings: settings4 })
check('恢复后清除定时器', coreT.tokenPlanTimers.has('s-tp') === false)
// 普通 429（非额度用尽）仍立即发送
const sent5 = []
const coreN = createMonitorCore({ agentResolver: () => ({ followup(m) { sent5.push(m) } }) })
coreN.resolveFromFold('s-n', foldStateFromEvents([
  { type: 'turn/start', seq: 1 },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429: inference tpm exhausted' } } }, seq: 2 },
]), { settings: settings4 })
await tick()
check('普通 429 仍立即发送', sent5.length === 1, 'sent=' + sent5.length)

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
if (failed > 0) process.exit(1)
console.log('OK')