// dsh-session-monitor —— 独立于 dsh webui 的主机侧会话监控插件（自包含单文件）
// 桌面版适配（v1.1.0）：注册片段使用端口 8091（代码内置兜底仍为 3091，见 applyInner 的 PORT）；
// 桌面件路径不再写死，改为按本插件自身目录解析。
// 注册方式见同目录 desktop-cordis.patch.yml（**只注册 file:/// 一行**）。
//
// 背景：DSH 会话可能因 LLM 提供方 HTTP 429（rate limit）中断 agent 输出。该插件
// 运行在 dsh 主机进程内（dsh 后台运行即可，无需打开 webui），监听**所有**会话的
// agent/session 生命周期事件，维护每个会话的状态机，并在 429 中断时提醒、
// （由用户设定）自动继续。附独立 HTTP 仪表盘（默认 http://127.0.0.1:8091）。
//
// 状态机（用户定义的会话状态）：
//   空闲(idle) → 活动中(active) → { 等待回答(waiting-answer) / 等待批准(waiting-approval)
//                                  / 429错误(error429) / 报错(error) } → 工作完成(complete)
// 监控器成员资格：
//   - 会话进入「活动中」→ 加入监控器
//   - 工作完成 → **不立即退出**，停留「complete」，直到用户阅读（仪表盘「已读」）后移除
//   - 会话销毁 → 从监控器移除
//
// 事件源（与 unipet-dsh / dsh-desktop-pet 相同的主机侧接法）：
//   ctx.on('agent/created')  +  agent.ctx.on('agent/status'|'agent/error'|'agent/disposed')
//   ctx.on('session/event', (session, event), { global: true })
//     事件：turn/start / tool/call / approval/asked / llm/retry / turn/end / tool/result
//
// 429 判定（准确，只信数据层）：
//   - turn/end reason.kind==='error' 且 code==='RATE_LIMIT' / HTTP 429 / 文案命中 → 终止性 429 停止
//   - llm/retry failure.code==='RATE_LIMIT' → 宿主内部重试中（非终止，仅记录）
//
// 自动继续（按会话精确路由，修复跨会话误发）：
//   通过 agent.followup({role:'user', content:[{type:'text',text:'继续'}]}) 唤醒驱动，
//   只发给发生 429 的那个会话；同一 429 停止只发一次，连续上限 maxRetries。
//
// 落点：往 %DSH_HOME%/profiles/<profile>/cordis.patch.yml 追加（桌面版 = profiles/desktop）：
//   - insert:
//       - id: session-monitor-desktop
//         name: 'file:///D:/plugins/dsh-429-monitor-v1.1.0-dsh-desktop/dsh-429-monitor/host/session-monitor.mjs'
//         config: { port: 8091 }
// 注意：**只注册这一行**。file:/// 行经 nearestPackage 会解析到本插件自身的 package.json，
// 因此它同时提供宿主侧监控与客户端状态徽章；若再加一行 name: dsh-429-monitor，同一个包
// 会出现两个 active Loader source，dsh-client-modules 会抛 ClientPackageCompositionError。
// 环境变量：SM_PORT / SM_HOST / DSH_HOME(session-monitor 设置文件目录)

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// 服务依赖声明（cordis 必须 inject 才能访问 ctx.sessions / ctx.agents）：
//  - sessions：ctx.sessions.list()（全量对账折叠，标题 + fold 自动继续）
//  - agents：ctx.agents.get(id)（权威 agent 查询，自动继续兜底）
// webServer 为可选（设置页注入），用 ctx.inject(['webServer']) 单独等待，缺失不影响监控。
// 防御式外层 apply 保证任何初始化错误都不影响 dsh 启动。
export const name = 'dsh-session-monitor'
export const inject = ['sessions', 'agents']

// ==================== 纯逻辑（可单测） ====================

export const RATE_LIMIT_PATTERNS = [
  /\b429\b/, /rate\s*[-_]?limit/i, /too many requests/i, /request limit/i,
  /请求过于频繁/, /配额不足/, /超出.*配额/, /limit exceeded/i, /reached.*(?:limit|quota)/i,
]

export function isRateLimitCode(code) {
  if (typeof code !== 'string') return false
  const c = code.trim().toUpperCase()
  return c === 'RATE_LIMIT' || c === '429' || c === 'HTTP 429'
}

export function isRateLimitMessage(text) {
  return typeof text === 'string' && RATE_LIMIT_PATTERNS.some((p) => p.test(text))
}

/**
 * 429 精细化分类：token plan entitlement exhausted —— 5h 额度用尽。
 * 这种错误立即发送「继续」无意义（额度未恢复），应进入长间隔（默认 1h）定时重试。
 */
export function isTokenPlanExhausted(message) {
  return typeof message === 'string' && /token plan entitlement exhausted|entitlement exhausted|entitlement.*exhaust|额度耗尽|plan.*exhausted/i.test(message)
}

/** turn/end 错误负载 → { code, message } | null */
export function turnEndFailure(event) {
  const reason = event && event.data && event.data.reason
  if (!reason || reason.kind !== 'error') return null
  const err = reason.error && typeof reason.error === 'object' ? reason.error : {}
  return { code: err.code || '', message: err.message || '', status: err.status }
}

export function is429Failure(failure) {
  if (!failure || typeof failure !== 'object') return false
  return isRateLimitCode(failure.code) || failure.status === 429 || isRateLimitMessage(failure.message)
}

/** 工具是否等待用户回答（ask/question）。 */
export function isQuestionTool(name) {
  return /ask|question/i.test(String(name || ''))
}

/**
 * 从会话事件日志取「首条用户消息」作为可读标题（用于区分同工作目录的多个会话）。
 * 取前 60 字符；无消息则返回空串（回退到 cwd 基线名）。
 */
export function titleFromEvents(events) {
  const list = Array.isArray(events) ? events : []
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    if (!e || e.type !== 'user/message') continue
    const content = e.data && e.data.content
    if (!Array.isArray(content)) continue
    const text = content.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ').trim()
    if (text) return text.slice(0, 60)
  }
  return ''
}

/**
 * 从会话事件日志尾部折叠出「当前状态」（对账兜底，不依赖事件的实时到达）。
 * 任意时刻调用都能从持久日志还原最新状态——担保**全部**活动会话（含插件加载前
 * 已存在/恢复的会话，其构造回放不发事件）都被准确跟踪。
 *
 * 规则：从尾部向前找第一个决定性的状态边界事件：
 *   turn/end(429) → error429；turn/end(error) → error；turn/end(ok) → complete
 *   turn/start → active（未闭合的回合）
 *   approval/asked → waiting-approval；ask/question 工具 call → waiting-answer
 *   llm/retry(429) → 附带 retry 告警（非终止）
 * 没有事件 → idle。
 * @returns {{state, running, alert: object|null}}
 */
export function foldStateFromEvents(events) {
  const list = Array.isArray(events) ? events : []
  let running = false
  let retryAlert = null
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]
    if (!e || typeof e.type !== 'string') continue
    switch (e.type) {
      case 'turn/end': {
        const f = turnEndFailure(e)
        const is429 = f && is429Failure(f)
        running = false
        if (f) {
          return {
            state: is429 ? 'error429' : 'error',
            running,
            alert: { kind: is429 ? '429' : 'error', code: f.code || (is429 ? 'RATE_LIMIT' : 'ERROR'), message: f.message || '', seq: e.seq, time: e.time },
          }
        }
        return { state: 'complete', running, alert: null }
      }
      case 'turn/start':
        return { state: 'active', running: true, alert: null }
      case 'approval/asked':
        return { state: 'waiting-approval', running: true, alert: null }
      case 'tool/call': {
        const name = e.data && e.data.name || ''
        if (isQuestionTool(name)) return { state: 'waiting-answer', running: true, alert: null }
        break
      }
      case 'llm/retry': {
        const f = e.data && e.data.failure
        if (f && is429Failure(f) && !retryAlert) {
          retryAlert = { kind: 'retry', code: f.code || 'RATE_LIMIT', message: f.message || '', seq: e.seq, time: e.time }
        }
        break
      }
      default:
        break
    }
  }
  return { state: 'idle', running, alert: retryAlert }
}

const STATE_TEXT = {
  idle: '空闲',
  active: '活动中',
  'waiting-answer': '等待回答',
  'waiting-approval': '等待批准',
  error429: '429 错误',
  error: '报错',
  complete: '工作完成',
}

export function stateText(state) {
  return STATE_TEXT[state] || state || '未知'
}

export function createMonitorCore(options = {}) {
  const maxAlert = options.maxAlert || 8
  /** 权威 agent 解析器（0.1.2 用 ctx.agents.get(id)）：continueSession 回退来源，兼自愈 agents 映射。 */
  const agentResolver = typeof options.agentResolver === 'function' ? options.agentResolver : () => undefined
  /** 环境诊断（dsh 版本线索 + 服务可用性）；缺失时 snapshot.env 为 null。 */
  const envDiag = typeof options.envDiag === 'function' ? options.envDiag : () => null
  const records = new Map()  // sessionId -> record
  const agents = new Map()   // sessionId -> agent
  const archived = new Map() // sessionId -> last archived record (cap)
  const listeners = new Set()
  const autoSent = new Set() // `${sessionId}:${turnEndSeq}` 已自动继续的事件
  /** token-plan 额度用尽型 429 的长间隔定时重试器：sessionId -> timer（默认 1h 一次）。 */
  const tokenPlanTimers = new Map()
  const tokenPlanMs = options.tokenPlanRetryMs || 3600000

  function clearTokenPlanTimer(id) {
    const t = tokenPlanTimers.get(id)
    if (t) { clearInterval(t); tokenPlanTimers.delete(id) }
  }
  /**
   * 额度用尽型 429：不立即发送「继续」，按 tokenPlanMs 间隔定时重试，
   * 直到会话恢复（离开 error429）时清除。
   */
  function scheduleTokenPlanRetry(rec, settings) {
    if (tokenPlanTimers.has(rec.id)) return
    rec.statusText = '额度用尽（token plan），每 ' + Math.round(tokenPlanMs / 60000) + ' 分钟自动重试一次'
    const timer = setInterval(() => {
      const cur = records.get(rec.id)
      if (!cur || cur.state !== 'error429') { clearTokenPlanTimer(rec.id); return }
      // 仍卡在额度用尽 → 尝试发送「继续」（异步 followup，等待驱动处理）
      const r = continueSession(rec.id)
      if (r.ok) { cur.statusText = '额度用尽重试：已发送「继续」，等待额度恢复' }
      else { cur.statusText = '额度用尽重试失败: ' + (r.reason || 'unknown') }
    }, tokenPlanMs)
    tokenPlanTimers.set(rec.id, timer)
  }
  /** 插件卸载时清理全部定时器。 */
  function clearAllTokenPlanTimers() {
    for (const t of tokenPlanTimers.values()) { try { clearInterval(t) } catch (e) { /* ignore */ } }
    tokenPlanTimers.clear()
  }

  function notify() { for (const fn of [...listeners]) { try { fn() } catch (e) { /* ignore */ } } }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }

  function ensure(id, cwd) {
    let rec = records.get(id)
    if (!rec) {
      rec = {
        id,
        cwd: cwd || '',
        title: '',
        state: 'idle',
        monitored: false,
        running: false,
        read: false,
        activeSince: 0,
        stateSince: Date.now(),
        lastActivity: 0,
        retries: 0,
        autoSentAt: 0,
        lastAlertKey: null,
        lastAlertSeq: 0,
        alerts: [],
        statusText: '',
      }
      records.set(id, rec)
    }
    return rec
  }

  function titleOf(rec) {
    if (rec.title) return rec.title
    const cwd = rec.cwd || ''
    if (cwd) return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd
    return rec.id
  }

  function addToMonitor(rec) {
    const was = rec.monitored
    rec.monitored = true
    rec.read = false
    if (!was) { rec.activeSince = Date.now(); rec.stateSince = Date.now() }
  }

  function pushAlert(rec, kind, code, message, time, key) {
    rec.alerts = [{ ts: time || Date.now(), kind, code, message: String(message || '').slice(0, 400) }, ...rec.alerts].slice(0, maxAlert)
    rec.lastAlertKey = key || null
    rec.statusText = message ? String(message).slice(0, 200) : ''
  }

  /** 主机侧「发送继续」到精确会话（跨会话 bug 修复点：只按 id 路由）。 */
  function resolveAgent(id) {
    let agent = agents.get(id)
    if (!agent && agentResolver) { try { agent = agentResolver(id) } catch (e) { agent = undefined } }
    if (agent) agents.set(id, agent) // 自愈本地映射
    return agent
  }
  function errDetail(e) {
    if (!e) return 'unknown'
    const stack = e && e.stack ? String(e.stack).split('\n').slice(0, 6).join(' | ') : ''
    return String(e && e.message || e) + (stack ? '  [' + stack + ']' : '')
  }

  function continueSession(id, text = '继续') {
    // 0.1.2：agent/created 可能迟到/未达（尤其恢复会话），回退权威注册表 ctx.agents.get(id)
    const agent = resolveAgent(id)
    if (!agent || typeof agent.followup !== 'function') {
      const rec = records.get(id)
      if (rec) rec.statusText = '发送失败: 未找到该会话的活跃 agent（no-agent）'
      return { ok: false, reason: 'no-agent' }
    }
    try {
      const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
      const rec = records.get(id)
      // 关键修复（0.1.2 适配）：在 session/event 发布期间（如 turn/end 监听回调内）同步调用
      // agent.followup 会触发 session.append('agent/inbox/spliced')，与正在发布的 append 重入冲突
      // （"session append cannot reenter while another append is being published"）。
      // 将 followup 推迟到下一 tick，让当前 append 发布完成后再入队。
      if (typeof setImmediate === 'function') {
        setImmediate(() => {
          try {
            agent.followup(message)
            if (rec) { rec.statusText = '已发送「' + text + '」，等待驱动处理' }
          } catch (e) {
            const detail = errDetail(e)
            if (rec) rec.statusText = '异步发送失败: ' + detail
            try { process.stderr.write(`[dsh-session-monitor][continue] ${id} 异步发送失败: ${detail}\n`) } catch (e2) { /* ignore */ }
          }
        })
      } else {
        agent.followup(message)
        if (rec) rec.statusText = '已发送「' + text + '」，等待驱动处理'
      }
      if (rec) { rec.retries += 1; rec.autoSentAt = Date.now() }
      return { ok: true, queued: true }
    } catch (e) {
      const detail = errDetail(e)
      const rec = records.get(id)
      if (rec) rec.statusText = '发送失败: ' + detail
      try { process.stderr.write(`[dsh-session-monitor][continue] ${id} 发送失败: ${detail}\n`) } catch (e2) { /* ignore */ }
      return { ok: false, reason: detail }
    }
  }

  /** 429 停止后自动继续（用户设定开启时；同一停止只发一次）。 */
  function maybeAutoContinue(rec, stopKey, settings) {
    const tag = (rec ? rec.id : '?') + ':' + (stopKey || '?')
    const note = (m) => { try { process.stderr.write(`[dsh-session-monitor][autocontinue] ${m}\n`) } catch (e) { /* ignore */ } }
    if (!settings.autoRetry) { note(`${tag} 跳过: autoRetry=false`); return false }
    if (!rec || rec.state !== 'error429') { note(`${tag} 跳过: state=${rec ? rec.state : '(null)'}`); return false }
    // 额度用尽型（token plan entitlement exhausted，5h 额度用尽）：立即发送「继续」无意义，
    // 进入长间隔定时重试（默认 1h 一次），等待额度恢复。
    const last429 = (rec.alerts || []).find((a) => a.kind === '429')
    if (last429 && isTokenPlanExhausted(last429.message)) {
      scheduleTokenPlanRetry(rec, settings)
      note(`${tag} 额度用尽型 429，进入定时重试（${Math.round(tokenPlanMs / 60000)} 分钟/次）`)
      return false
    }
    if (rec.retries >= settings.maxRetries) { rec.statusText = '自动继续已达上限，请在仪表盘手动发送'; note(`${tag} 跳过: retries=${rec.retries} 达上限`); return false }
    const k = (rec.id || '') + ':' + (stopKey || rec.lastAlertKey || Date.now())
    if (autoSent.has(k)) { note(`${tag} 跳过: 已发送过(去重)`); return false }
    if (resolveAgent(rec.id)) autoSent.add(k) // resolver 感知，防对账循环重复发
    const r = continueSession(rec.id)
    if (!r.ok) { rec.statusText = '自动继续失败: ' + (r.reason || 'unknown'); note(`${tag} 失败: ${r.reason}`) }
    else { note(`${tag} 已发送「继续」`) }
    if (r.ok && autoSent.size > 1000) autoSent.clear()
    return r.ok
  }

  /** 处理一条会话事件（纯逻辑入口，便于单测）。 */
  function onSessionEvent(sessionId, event, extras = {}) {
    if (!event || typeof event.type !== 'string') return
    const now = Date.now()
    const rec = ensure(sessionId, extras.cwd)
    switch (event.type) {
      case 'turn/start':
        addToMonitor(rec)
        rec.state = 'active'; rec.running = true; rec.retries = 0
        clearTokenPlanTimer(sessionId) // 新回合开始 → 停止额度用尽定时重试
        rec.activeSince = now; rec.stateSince = now; rec.lastActivity = now
        break
      case 'tool/call': {
        const name = event.data && event.data.name || ''
        addToMonitor(rec)
        if (isQuestionTool(name)) rec.state = 'waiting-answer'
        else rec.state = 'active'
        rec.running = true; rec.stateSince = now; rec.lastActivity = now
        break
      }
      case 'tool/result': {
        const name = event.data && event.data.name || ''
        rec.lastActivity = now
        // 提问工具已返回（用户已回答）→ 恢复活动
        if (rec.state === 'waiting-answer' && isQuestionTool(name)) {
          rec.state = 'active'; rec.stateSince = now
        }
        break
      }
      case 'approval/asked':
        addToMonitor(rec)
        rec.state = 'waiting-approval'; rec.stateSince = now; rec.lastActivity = now
        break
      case 'llm/retry': {
        const f = event.data && event.data.failure
        if (f && is429Failure(f)) {
          // 宿主内部按 backoff 重试中：记录但不终止、不自动发（避免并发重复）
          pushAlert(rec, 'retry', f.code || 'RATE_LIMIT', f.message || '', event.time, `retry:${event.seq}`)
          rec.lastActivity = now
        }
        break
      }
      case 'turn/end': {
        const failure = turnEndFailure(event)
        rec.running = false
        if (failure && is429Failure(failure)) {
          rec.state = 'error429'; rec.stateSince = now; rec.lastActivity = now
          pushAlert(rec, '429', failure.code || 'RATE_LIMIT', failure.message || '', event.time, `turn:${event.seq}`)
          maybeAutoContinue(rec, `turn:${event.seq}`, extras.settings || { autoRetry: false, maxRetries: 3 })
        } else if (failure) {
          rec.state = 'error'; rec.stateSince = now; rec.lastActivity = now
          pushAlert(rec, 'error', failure.code || 'ERROR', failure.message || '', event.time, `turn:${event.seq}`)
        } else {
          // 正常结束：从活动/等待态 → 工作完成（保持监控，等待用户阅读）
          if (rec.state === 'active' || rec.state === 'waiting-answer' || rec.state === 'waiting-approval') {
            rec.state = 'complete'; rec.stateSince = now
          }
          rec.lastActivity = now
        }
        break
      }
      default:
        rec.lastActivity = now
        break
    }
    rec.title = (rec.title && rec.title !== rec.id) ? rec.title : titleOf(rec)
    notify()
  }

  /** agent 状态事件。 */
  function onAgentStatus(sessionId, status, extras = {}) {
    const rec = ensure(sessionId, extras.cwd)
    const now = Date.now()
    if (status === 'running') {
      addToMonitor(rec)
      // 不覆盖等待回答/等待批准/报错状态：仅从空闲/完成/未知进入活动
      if (rec.state === 'idle' || rec.state === 'complete' || rec.state === 'unknown') {
        rec.state = 'active'; rec.stateSince = now
      }
      rec.running = true; rec.activeSince = now; rec.lastActivity = now
    } else if (status === 'idle' && rec.running) {
      rec.running = false; rec.lastActivity = now
      if (rec.state !== 'error429' && rec.state !== 'error') {
        rec.state = 'complete'; rec.stateSince = now
      }
    }
    rec.title = (rec.title && rec.title !== rec.id) ? rec.title : titleOf(rec)
    notify()
  }

  function onAgentError(sessionId, message, extras = {}) {
    const rec = ensure(sessionId, extras.cwd)
    if (rec.state !== 'error429') { rec.state = 'error'; rec.stateSince = Date.now() }
    pushAlert(rec, 'error', 'AGENT_ERROR', message || 'agent error', Date.now(), `agent:${Date.now()}`)
    rec.lastActivity = Date.now()
    notify()
  }

  function onAgentDisposed(sessionId) {
    agents.delete(sessionId)
    const rec = records.get(sessionId)
    if (rec) {
      if (rec.monitored) { rec.state = 'complete'; rec.stateSince = Date.now() }
      rec.monitored = false
      archive(rec)
      records.delete(sessionId)
    }
    notify()
  }

  function archive(rec) {
    archived.set(rec.id, Object.assign({}, rec, { archivedAt: Date.now() }))
    if (archived.size > 100) {
      let oldest = null, oldestKey = null
      for (const [k, v] of archived) if (!oldest || v.archivedAt < oldest) { oldest = v.archivedAt; oldestKey = k }
      if (oldestKey) archived.delete(oldestKey)
    }
  }

  /**
   * 对账入口：把一次日志折叠结果合并进监控记录。
   * 主要用于定期 reconcile + session 创建/恢复时兜底，担保全部活动会话都被跟踪。
   * 规则：
   *  - 折叠状态为活动/等待/报错类 → 加入监控器（进入「活动中」即入监控）
   *  - 折叠出 429/retry 告警且 seq 未见过 → 追加告警（按 seq 去重）
   *  - 不覆盖实时事件已设定的完成/已读状态（仅当折叠状态更能反映「当前活动」时更新）
   */
  function resolveFromFold(id, folded, extras = {}) {
    if (!folded || !folded.state) return
    const rec = ensure(id, extras.cwd)
    const activeStates = ['active', 'waiting-answer', 'waiting-approval', 'error429', 'error']
    const now = Date.now()
    // 标题：优先首条用户消息，其次 cwd 基线名（便于区分同目录的多会话）
    const title = extras.events ? titleFromEvents(extras.events) : ''
    if (title) { rec.title = title; rec.cwd = rec.cwd || extras.cwd || '' }
    rec.running = !!folded.running
    const wasError429 = rec.state === 'error429'
    if (folded.state !== 'idle' && folded.state !== 'complete') {
      // 活动/等待/报错类：确保在监控器且状态最新
      const wasMonitored = rec.monitored
      addToMonitor(rec)
      if (!wasMonitored || rec.state !== folded.state) { rec.state = folded.state; rec.stateSince = now }
      if (folded.alert) {
        const seq = folded.alert.seq || 0
        if (seq && rec.lastAlertSeq !== seq) {
          pushAlert(rec, folded.alert.kind, folded.alert.code, folded.alert.message, folded.alert.time, `fold:${seq}`)
          rec.lastAlertSeq = seq
        } else if (!seq) {
          // 无 seq 的告警（如 retry）按内容+时间窗口去重
          const dup = rec.alerts.some((a) => a.kind === folded.alert.kind && a.code === folded.alert.code && now - (a.ts || 0) < 10000)
          if (!dup) pushAlert(rec, folded.alert.kind, folded.alert.code, folded.alert.message, folded.alert.time, `fold:${now}`)
        }
        // 关键修复：fold 对账出 429 停止也触发自动继续（0.1.2 下 live turn/end 事件可能未达监听）
        if (folded.state === 'error429' && folded.alert.kind === '429') {
          maybeAutoContinue(rec, `fold:${seq || folded.alert.time}`, extras.settings || { autoRetry: false, maxRetries: 3 })
        }
      }
    } else if (folded.state === 'complete') {
      // 正常结束：活动/等待/429 中断 → 工作完成（保持监控，等待用户阅读）
      if (rec.state === 'active' || rec.state === 'waiting-answer' || rec.state === 'waiting-approval' || rec.state === 'error429') {
        rec.state = 'complete'; rec.stateSince = now
      }
    }
    // 关键修复（0.1.2 适配）：会话「离开 error429」（恢复/完成）→ 重置自动发送状态。
    // 0.1.2 下 live turn/start 事件可能未达监听，retries/autoSent 不再被 turn/start 重置，
    // 会导致「首次 429 成功、后续 429 不再发送」（retries 累积到上限 / autoSent 残留）。
    // 这里在 fold 对账层兜底重置，发送逻辑本身不变。
    if (wasError429 && rec.state !== 'error429') {
      rec.retries = 0
      rec.autoSentAt = 0
      clearTokenPlanTimer(rec.id) // 会话恢复 → 停止额度用尽定时重试
      for (const key of [...autoSent]) if (key.startsWith(rec.id + ':')) autoSent.delete(key)
    }
    rec.lastActivity = Math.max(rec.lastActivity || 0, now)
    rec.title = (rec.title && rec.title !== rec.id) ? rec.title : titleOf(rec)
    notify()
  }

  /** 用户阅读完成结果 → 从监控器移除（保留在归档）。 */
  function markRead(id) {
    const rec = records.get(id)
    if (!rec) return { ok: false, reason: 'not-found' }
    rec.read = true
    rec.monitored = false
    rec.readAt = Date.now()
    rec.state = 'complete'
    notify()
    return { ok: true }
  }

  /** 从监控器移除（不保留）。 */
  function remove(id) {
    const rec = records.get(id)
    if (!rec) return { ok: false, reason: 'not-found' }
    rec.monitored = false
    archive(rec)
    records.delete(id)
    notify()
    return { ok: true }
  }

  function snapshot(settings) {
    const active = [...records.values()]
      .filter((r) => r.monitored)
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
      .map((r) => ({
        id: r.id, title: r.title, cwd: r.cwd, state: r.state, stateText: stateText(r.state),
        running: r.running, monitored: true, read: r.read,
        activeSince: r.activeSince, stateSince: r.stateSince, lastActivity: r.lastActivity,
        retries: r.retries, autoSentAt: r.autoSentAt,
        alerts: r.alerts.slice(0, 5),
      }))
    const archivedList = [...archived.values()].slice(-20).map((r) => ({
      id: r.id, title: r.title, state: r.state, stateText: stateText(r.state),
      archivedAt: r.archivedAt, alerts: (r.alerts || []).slice(0, 3),
    }))
    // 环境诊断：用于定位目标 PC 上 "Cannot read properties of undefined (reading 'prepare')"
    // 之类 dsh 内部错误——暴露 dsh 版本线索与插件依赖的服务可用性。
    let envDiagOut = null
    try {
      envDiagOut = envDiag()
    } catch (e) { envDiagOut = { error: String(e && e.message || e) } }
    return { settings, sessions: active, archived: archivedList, total: active.length, env: envDiagOut }
  }

  return {
    records, agents, autoSent, tokenPlanTimers,
    subscribe, ensure, titleOf, addToMonitor, pushAlert, continueSession, maybeAutoContinue,
    scheduleTokenPlanRetry, clearTokenPlanTimer, clearAllTokenPlanTimers,
    onSessionEvent, onAgentStatus, onAgentError, onAgentDisposed, resolveFromFold, markRead, remove, snapshot, notify,
  }
}

// ==================== 设置持久化 ====================

function settingsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'session-monitor', 'settings.json')
}

function loadSettings(defaults) {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const p = JSON.parse(raw)
    return Object.assign({}, defaults, p)
  } catch (e) {
    return Object.assign({}, defaults)
  }
}

function saveSettings(settings) {
  try {
    const file = settingsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(settings, null, 2))
  } catch (e) { /* ignore */ }
}

// ==================== 仪表盘 ====================

function dashboardHtml() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>DSH 会话监控</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #101216; color: #e6e6e6; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,.08); position: sticky; top: 0; background: rgba(16,18,22,.92); backdrop-filter: blur(6px); z-index: 5; }
  header h1 { font-size: 16px; margin: 0; font-weight: 700; }
  header .sub { color: #888; font-size: 12px; }
  .spacer { flex: 1; }
  .toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; user-select: none; padding: 6px 12px; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; background: rgba(255,255,255,.04); }
  .toggle input { accent-color: #ff5050; }
  .count { font-size: 12px; color: #888; }
  main { padding: 16px 20px 40px; max-width: 960px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.06); vertical-align: top; }
  th { color: #999; font-weight: 600; font-size: 12px; }
  td.title { font-weight: 600; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.id { color: #666; font-size: 11px; font-variant-numeric: tabular-nums; }
  .state { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b6b; flex-shrink: 0; }
  .s-active .dot { background: #ffb432; animation: blink 1.2s infinite; }
  .s-complete .dot { background: #4dd0a1; }
  .s-waiting-answer .dot, .s-waiting-approval .dot { background: #4da6ff; }
  .s-error429 .dot { background: #ff5050; animation: blink 1.2s infinite; }
  .s-error .dot { background: #ff785a; }
  .s-idle .dot { background: #555; }
  @keyframes blink { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
  .time { color: #999; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .alert { color: #ff9a9a; font-size: 12px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alert.retry { color: #d0b070; }
  button { font-family: inherit; font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.06); color: #ddd; cursor: pointer; }
  button:hover { background: rgba(255,255,255,.13); }
  button.primary { background: linear-gradient(90deg,#ff5050,#ff7a3c); border-color: transparent; color: #fff; font-weight: 700; }
  .empty { color: #888; padding: 40px 0; text-align: center; }
  .archived { margin-top: 24px; opacity: .7; }
  .archived h2 { font-size: 13px; color: #999; }
  .archived table td { padding: 4px 10px; font-size: 12px; }
  footer { padding: 12px 20px 20px; color: #666; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>🐙 DSH 会话监控</h1>
  <span class="sub">独立主机侧监控 · 全部会话 · 429 提醒</span>
  <div class="spacer"></div>
  <span class="count" id="count"></span>
  <label class="toggle"><input type="checkbox" id="autoRetry"> 自动继续（429 停止后发送「继续」）</label>
  <span id="health" class="sub"></span>
</header>
<main>
  <table>
    <thead><tr><th>状态</th><th>会话</th><th>活动</th><th>最近告警</th><th>自动继续</th><th>操作</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty" style="display:none">当前没有进行中的会话。新会话进入「活动中」后会自动出现在这里；工作完成后保留，等你阅读后「已读」移除。</div>
  <div class="archived" id="archived"></div>
</main>
<footer>自动继续仅发给发生 429 的那个会话（按会话精确路由）。数据来自 dsh 主机进程，与 webui 是否打开无关。</footer>
<script>
var API = '';
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function fmt(ts){ if(!ts) return ''; var d=new Date(ts); return d.toLocaleTimeString('zh-CN',{hour12:false}) }
function elapsed(since){ if(!since) return ''; var s=Math.max(0,Math.floor((Date.now()-since)/1000)); if(s<60) return s+'s'; var m=Math.floor(s/60); if(m<60) return m+'m'+s%60+'s'; return Math.floor(m/60)+'h'+(m%60)+'m' }
function stateRow(s){
  var alertHtml = s.alerts.length ? '<span class="alert '+(s.alerts[0].kind==='retry'?'retry':'')+'">'+esc((s.alerts[0].kind==='429'?'[429] ':(s.alerts[0].kind==='retry'?'[重试中] ':'[报错] '))+esc(s.alerts[0].code)+' '+esc(trunc(s.alerts[0].message,60))+'</span>' : '<span style="color:#555">—</span>'
  var act = s.state==='active' && s.activeSince ? elapsed(s.activeSince) : fmt(s.lastActivity)
  return '<tr class="s-'+esc(s.state)+'">'+
    '<td><span class="state"><span class="dot"></span>'+esc(s.stateText)+'</span></td>'+
    '<td class="title" title="'+esc(s.id)+'">'+esc(s.title)+'<br><span class="id">'+esc(cwdShort(s.cwd))+' · #'+esc(String(s.id).slice(0,8))+'</span></td>'+
    '<td class="time">'+(s.state==='active'?'已持续 '+act:act)+'</td>'+
    '<td>'+alertHtml+'</td>'+
    '<td class="time">'+(s.retries>0 ? s.retries+' 次'+(s.autoSentAt?(' @ '+fmt(s.autoSentAt)):'') : '—')+'</td>'+
    '<td>'+
      '<button class="primary" data-act="continue" data-id="'+esc(s.id)+'">继续</button> '+
      '<button data-act="read" data-id="'+esc(s.id)+'">已读</button> '+
      '<button data-act="remove" data-id="'+esc(s.id)+'">移除</button>'+
    '</td></tr>'
}
function trunc(s,n){ s=String(s==null?'':s); return s.length>n?s.slice(0,n)+'…':s }
function cwdShort(c){ c=String(c==null?'':c); if(!c) return ''; var p=c.replace(/[\\/]+$/,'').split(/[\\/]/); var last=p.pop()||''; var prev=p.pop(); return prev ? (prev+'\\'+last) : last }
function render(state){
  document.getElementById('autoRetry').checked = !!state.settings.autoRetry;
  document.getElementById('count').textContent = state.total + ' 个进行中会话';
  var rows = document.getElementById('rows');
  rows.innerHTML = state.sessions.map(stateRow).join('');
  document.getElementById('empty').style.display = state.sessions.length ? 'none' : 'block';
  var arch = document.getElementById('archived');
  if (state.archived && state.archived.length) {
    arch.innerHTML = '<h2>已结束 / 已读（最近 20 条）</h2><table><thead><tr><th>会话</th><th>状态</th><th>结束时间</th><th>最近告警</th></tr></thead><tbody>' +
      state.archived.map(function(a){ return '<tr><td>'+esc(a.title)+'</td><td>'+esc(a.stateText)+'</td><td class="time">'+fmt(a.archivedAt)+'</td><td>'+(a.alerts&&a.alerts[0]?esc(trunc(a.alerts[0].message,60)):'—')+'</td></tr>' }).join('') +
      '</tbody></table>'
  } else arch.innerHTML = '';
  document.getElementById('health').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN',{hour12:false});
}
async function refresh(){
  try { var r = await fetch(API+'/api/state'); render(await r.json()) } catch(e) { /* server down */ }
}
document.addEventListener('click', async function(e){
  var b = e.target.closest('button[data-act]'); if(!b) return;
  var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
  if(act==='continue'){ await fetch(API+'/api/session/'+encodeURIComponent(id)+'/continue',{method:'POST'}) }
  else if(act==='read'){ await fetch(API+'/api/session/'+encodeURIComponent(id)+'/read',{method:'POST'}) }
  else if(act==='remove'){ await fetch(API+'/api/session/'+encodeURIComponent(id)+'/remove',{method:'POST'}) }
  refresh();
});
document.getElementById('autoRetry').addEventListener('change', async function(e){
  await fetch(API+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoRetry:e.target.checked})});
});
refresh(); setInterval(refresh, 1000);
</script>
</body>
</html>`
}

// ==================== webui 设置页注入（会话监控设置面板） ====================
// 复用 lan-gate 模式：向 DSH「设置」对话框追加「会话监控」导航单元与设置面板，
// 控制监控开关 / ON AIR 桌面显示 / 自动继续等（数据读写 :8091/api/settings，CORS 已开放）。

function settingsScript(base) {
  const js = '(function(){'
    + 'var BASE=' + JSON.stringify(base) + ';'
    + 'var active=false,timer=null,panelNode=null,cell=null,opts=null;'
    + 'function esc(s){return String(s==null?\'\':s).replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/\'/g,\'&#39;\').replace(/"/g,\'&quot;\')}'
    + 'function get(){return fetch(BASE+\'/api/settings\').then(function(r){return r.json()}).catch(function(){return null})}'
    + 'function set(patch){return fetch(BASE+\'/api/settings\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify(patch)}).then(function(r){return r.json()}).catch(function(){return null})}'
    + 'function toggle(patch){set(patch).then(function(){refresh()})}'
    + 'function stateBadge(){return fetch(BASE+\'/api/state\').then(function(r){return r.json()}).catch(function(){return null})}'
    + 'function refresh(){'
    + '  if(!panelNode)return;'
    + '  Promise.all([get(),stateBadge()]).then(function(r){'
    + '    var s=(r[0]&&r[0].settings)||{};'
    + '    var st=r[1]||null;'
    + '    var n=st&&st.total?st.total:0;'
    + '    var statusText=st?(\'监控中 \'+n+\' 个活动会话\'):\'主机监控离线\';'
    + '    var h=\'<div style="padding:4px 2px 12px;font-size:13px">\';'
    + '    h+=\'<div style="font-size:14px;font-weight:700;margin-bottom:8px">🐙 DSH 会话监控</div>\';'
    + '    h+=\'<div style="color:#888;margin-bottom:10px">\'+esc(statusText)+\' · <a href="\'+BASE+\'/index.html" target="_blank" style="color:#4da6ff">独立仪表盘</a></div>\';'
    + '    h+=row(\'monitoring\',\'会话监控\',\'监听全部会话的活动/429 状态\',s.monitoring!==false);'
    + '    h+=row(\'autoRetry\',\'自动继续\',\'429 停止后自动发送「继续」（上限 3 次）\',s.autoRetry===true);'
    + '    h+=row(\'desktopDisplay\',\'ON AIR 桌面显示\',\'启动/关闭演播室 ON AIR 桌面件\',s.desktopDisplay!==false);'
    + '    h+=\'<div style="display:flex;align-items:center;gap:8px;margin:6px 0"><span style="color:#aaa;flex:0 0 96px">自动继续上限</span>\';'
    + '    h+=\'<input id="sm-maxretries" type="number" min="1" max="10" value="\'+esc(s.maxRetries||3)+\'" style="width:64px;padding:4px;border-radius:6px;border:1px solid #444;background:#1c1f27;color:#eee"/>\';'
    + '    h+=\'<button class="lg-btn" data-act="maxretries" style="padding:4px 10px;border-radius:6px;border:1px solid #444;background:#222;color:#ddd;cursor:pointer">应用</button></div>\';'
    + '    h+=\'<div style="color:#777;font-size:12px;margin-top:8px">数据由主机进程提供，与 webui 是否打开无关。自动继续按会话精确路由，不会误发到其他会话。</div>\';'
    + '    h+=\'</div>\';'
    + '    panelNode.innerHTML=h;'
    + '  });'
    + '}'
    + 'function row(id,label,desc,on){'
    + '  return \'<label style="display:flex;align-items:center;gap:10px;margin:8px 0;cursor:pointer"><input type="checkbox" data-smbool="\'+id+\'" \'+(on?\'checked\':\'\')+\' style="accent-color:#ff5050;width:16px;height:16px"/><span><span style="display:block">\'+esc(label)+\'</span><span style="display:block;color:#888;font-size:12px">\'+esc(desc)+\'</span></span></label>\';'
    + '}'
    + 'function styleActive(){var all=document.querySelectorAll(\'.sm-nav-cell\');for(var i=0;i<all.length;i++){if(all[i]===cell&&active)all[i].classList.add(\'lg-nav-active\');else all[i].classList.remove(\'lg-nav-active\')}}'
    + 'function attach(){'
    + '  var dialog=document.querySelector(\'[role="dialog"][aria-modal="true"]\');'
    + '  if(!dialog||dialog.getAttribute(\'data-sm-attached\'))return;'
    + '  var nav=dialog.querySelector(\'nav\');if(!nav)return;'
    + '  var kids=nav.children;var list=kids.length>1?kids[kids.length-1]:null;if(!list)return;'
    + '  var contentNode=dialog.children[dialog.children.length-1];if(!contentNode)return;'
    + '  opts=contentNode.children[contentNode.children.length-1];if(!opts)return;'
    + '  dialog.setAttribute(\'data-sm-attached\',\'1\');'
    + '  panelNode=document.createElement(\'div\');panelNode.className=\'lg-nav-holder\';panelNode.style.display=\'none\';'
    + '  contentNode.appendChild(panelNode);'
    + '  panelNode.addEventListener(\'click\',function(ev){'
    + '    var el=ev.target;if(!el||!el.getAttribute)return;'
    + '    var act=el.getAttribute(\'data-act\');if(act===\'maxretries\'){var v=parseInt(document.getElementById(\'sm-maxretries\').value,10)||3;toggle({maxRetries:Math.max(1,Math.min(10,v))});return}'
    + '  });'
    + '  panelNode.addEventListener(\'change\',function(ev){var el=ev.target;if(!el||!el.getAttribute)return;var bid=el.getAttribute(\'data-smbool\');if(bid){var patch={};patch[bid]=el.checked;toggle(patch)}});'
    + '  cell=document.createElement(\'button\');cell.type=\'button\';cell.className=\'lg-nav-cell sm-nav-cell\';'
    + '  cell.innerHTML=\'<span class="lg-nav-icon">🐙</span><span>会话监控</span>\';'
    + '  cell.addEventListener(\'click\',function(ev){ev.stopPropagation();active=true;opts.style.display=\'none\';panelNode.style.display=\'block\';styleActive();refresh();if(timer){clearInterval(timer)}timer=setInterval(function(){if(active)refresh()},3000)});'
    + '  list.appendChild(cell);'
    + '  list.addEventListener(\'click\',function(ev){if(!ev.target.closest(\'.sm-nav-cell\')){active=false;if(timer){clearInterval(timer);timer=null}opts.style.display=\'\';panelNode.style.display=\'none\';styleActive()}},true);'
    + '}'
    + 'var mo=new MutationObserver(function(muts){for(var i=0;i<muts.length;i++){var ns=muts[i].addedNodes;for(var j=0;j<ns.length;j++){var n=ns[j];if(n.nodeType===1&&(n.matches?n.matches(\'[role="dialog"][aria-modal="true"]\'):false)){attach();return}if(n.nodeType===1&&n.querySelector&&n.querySelector(\'[role="dialog"][aria-modal="true"]\')){attach();return}}}});'
    + 'mo.observe(document.body,{childList:true,subtree:true});'
    + 'attach();'
    + '})()'
  return '<scr' + 'ipt>' + js + '</scr' + 'ipt>'
}

// ==================== 插件主体 ====================

export function apply(ctx, config = {}) {
  // 防御式外层：任何初始化错误都只记录日志，绝不让 dsh 启动失败。
  try {
    return applyInner(ctx, config || {})
  } catch (e) {
    try {
      process.stderr.write('[dsh-session-monitor] 初始化失败（已捕获，不影响 dsh 启动）: ' + (e && e.stack || e) + '\n')
    } catch (e2) { /* ignore */ }
  }
}

function applyInner(ctx, config) {
  const PORT = Number(process.env.SM_PORT || config.port || 3091)
  const HOST = process.env.SM_HOST || config.host || '127.0.0.1'
  const defaults = {
    autoRetry: config.autoRetryDefault === true,
    maxRetries: config.maxRetries || 3,
    monitoring: config.monitoring !== false,
    desktopDisplay: config.desktopDisplay !== false,
    // token-plan 额度用尽型 429 的定时重试间隔（毫秒，默认 1 小时）
    tokenPlanRetryMs: config.tokenPlanRetryMs || 3600000,
  }
  const settings = loadSettings(defaults)
  // 0.1.2 兼容：Session.events 改为 snapshotEvents()；authority agent 查询用 ctx.agents.get(id)
  const eventsOf = (s) => {
    if (!s) return undefined
    if (typeof s.snapshotEvents === 'function') { try { return s.snapshotEvents() } catch (e) { return undefined } }
    return s.events
  }
  const core = createMonitorCore({
    maxAlert: 8,
    // token-plan 额度用尽型 429 的长间隔定时重试（默认 1 小时一次）
    tokenPlanRetryMs: settings.tokenPlanRetryMs || 3600000,
    // 环境诊断：暴露 dsh 服务可用性与版本线索，便于目标 PC 定位 dsh 内部 .prepare 报错
    envDiag: () => {
      const out = { services: {}, agentAPIs: {}, node: process.version || '' }
      try { out.services.sessions = typeof ctx.sessions !== 'undefined' && typeof ctx.sessions.list === 'function' } catch (e) { out.services.sessions = false }
      try { out.services.agents = typeof ctx.agents !== 'undefined' && typeof ctx.agents.get === 'function' } catch (e) { out.services.agents = false }
      try { out.services.tools = typeof ctx.tools !== 'undefined' && !!ctx.tools } catch (e) { out.services.tools = false }
      // dsh 版本线索：优先从运行中的 dsh 包版本解析；失败则留空（由控制台日志补足）
      try {
        const fs2 = fs, path2 = path
        const bases = [
          process.env.DSH_HOME ? path2.join(process.env.DSH_HOME, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : '',
          path2.join(os.homedir(), '.dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
          // 桌面版：profile 自身的 node_modules 里就有 @deepseek-ai/dsh
          process.env.DSH_PROFILE_DIR ? path2.join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : '',
        ]
        for (const b of bases) {
          if (!b || !fs2.existsSync(b)) continue
          try {
            const v = JSON.parse(fs2.readFileSync(b, 'utf8')).version
            if (v) { out.dshVersion = v; break }
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      // agent 实例上 followup/send 是否可用（0.1.5 与 0.1.2 均提供）
      try {
        const first = core.agents.size > 0 ? core.agents.values().next().value : null
        const sample = first || (() => {
          try {
            const reg = typeof ctx.agents !== 'undefined' ? ctx.agents : null
            if (!reg || typeof reg.get !== 'function') return null
            const sessions = typeof ctx.sessions !== 'undefined' && typeof ctx.sessions.list === 'function' ? ctx.sessions.list() : []
            for (const s of sessions) {
              const a = s && s.id !== undefined ? reg.get(s.id) : undefined
              if (a) return a
            }
            return null
          } catch (e) { return null }
        })()
        if (sample && typeof sample === 'object') {
          out.agentAPIs.followup = typeof sample.followup === 'function'
          out.agentAPIs.send = typeof sample.send === 'function'
          out.agentAPIs.ctx = typeof sample.ctx === 'object' && !!sample.ctx
        }
      } catch (e) { /* ignore */ }
      return out
    },
    agentResolver: (id) => {
      try {
        const reg = typeof ctx.agents !== 'undefined' ? ctx.agents : null
        return reg && typeof reg.get === 'function' ? reg.get(id) : undefined
      } catch (e) { return undefined }
    }
  })

  const log = (m) => { try { process.stderr.write(`[dsh-session-monitor] ${m}\n`) } catch (e) { /* ignore */ } }

  // ---- ON AIR 桌面件（独立进程）联动 ----
  // 优先使用编译后的原生 exe（无需 powershell）；找不到再回退 .bat。
  // 桌面版适配：原版把桌面件路径写死为 D:/Dsh_work/... 与 D:/Dsh_data/...（制作者机器的布局），
  // 换机器后既找不到 exe 也找不到 bat，WIDGET_BAT 更是连 config 覆盖都没有。
  // 这里改为**相对本插件自身**解析（fileURLToPath(import.meta.url)），任何安装位置都成立；
  // 显式 config.widgetPath / 环境变量 SM_WIDGET_EXE 优先级更高，且会先于探测被采用。
  const SELF_DIR = (() => {
    try { return path.dirname(fileURLToPath(import.meta.url)) } catch (e) { return '' }
  })()
  const PLUGIN_DIR = SELF_DIR ? path.dirname(SELF_DIR) : ''
  const WIDGET_FALLBACK = PLUGIN_DIR ? path.join(PLUGIN_DIR, 'widget', 'onair-widget.exe') : 'onair-widget.exe'
  const WIDGET_EXE = (() => {
    try {
      if (process.env.SM_WIDGET_EXE && fs.existsSync(process.env.SM_WIDGET_EXE)) return process.env.SM_WIDGET_EXE
      if (config.widgetPath && fs.existsSync(config.widgetPath)) return config.widgetPath
      const candidates = [
        WIDGET_FALLBACK,
        'D:/Dsh_work/dsh-429-monitor/widget/onair-widget.exe',
        'D:/Dsh_data/profiles/web/node_modules/dsh-429-monitor/widget/onair-widget.exe',
      ]
      for (const c of candidates) if (fs.existsSync(c)) return c
      return WIDGET_FALLBACK
    } catch (e) { return WIDGET_FALLBACK }
  })()
  const WIDGET_BAT = (() => {
    try {
      if (process.env.SM_WIDGET_BAT && fs.existsSync(process.env.SM_WIDGET_BAT)) return process.env.SM_WIDGET_BAT
      const self = PLUGIN_DIR ? path.join(PLUGIN_DIR, 'widget', 'onair-widget.bat') : ''
      if (self && fs.existsSync(self)) return self
      if (config.widgetPath && fs.existsSync(config.widgetPath)) return config.widgetPath
      return self || 'onair-widget.bat'
    } catch (e) { return 'onair-widget.bat' }
  })()
  let widgetProc = null
  const widgetRunning = () => widgetProc !== null && !widgetProc.killed
  const spawnWidget = () => {
    try {
      if (widgetRunning()) return
      const exeExists = fs.existsSync(WIDGET_EXE)
      if (exeExists) {
        // 直接启动原生 exe（无 powershell / cmd 窗口）
        widgetProc = spawn(WIDGET_EXE, [String(PORT)], { detached: true, stdio: 'ignore', windowsHide: true })
        widgetProc.on('error', (e) => { log('启动桌面件 exe 失败: ' + (e && e.message || e)) })
        widgetProc.unref()
        log(`已启动 ON AIR 桌面件（原生 exe: ${WIDGET_EXE}）`)
      } else {
        widgetProc = spawn('cmd.exe', ['/c', 'start', '', WIDGET_BAT, String(PORT)], {
          detached: true, stdio: 'ignore', windowsHide: true,
        })
        widgetProc.on('error', (e) => { log('启动桌面件 bat 失败: ' + (e && e.message || e)) })
        widgetProc.unref()
        log(`已启动 ON AIR 桌面件（回退 bat: ${WIDGET_BAT}）`)
      }
    } catch (e) { log('启动桌面件失败: ' + (e && e.message || e)) }
  }
  const killWidget = () => {
    try { if (widgetProc) { widgetProc.kill(); widgetProc = null } } catch (e) { /* ignore */ }
  }

  // ---- agent 生命周期 ----
  ctx.on('agent/created', ({ agent }) => {
    if (!agent || typeof agent.id !== 'string') return
    const id = agent.id
    const cwd = agent.session && agent.session.header && agent.session.header.cwd ? agent.session.header.cwd : ''
    core.agents.set(id, agent)
    core.ensure(id, cwd)
    let wasRunning = false
    agent.ctx.on('agent/status', ({ status }) => {
      if (!settings.monitoring) return
      if (status === 'running') { wasRunning = true; core.onAgentStatus(id, 'running', { cwd }) }
      else if (status === 'idle' && wasRunning) { wasRunning = false; core.onAgentStatus(id, 'idle', { cwd }) }
    })
    agent.ctx.on('agent/error', (payload) => {
      if (!settings.monitoring) return
      core.onAgentError(id, (payload && payload.message) || (payload && payload.error) || 'agent error', { cwd })
    })
    agent.ctx.on('agent/disposed', () => { core.onAgentDisposed(id) })
  })

  // ---- 会话事件流（所有会话；global 保证全收到） ----
  ctx.on('session/event', (session, event) => {
    if (!settings.monitoring) return
    if (!event || typeof event.type !== 'string') return
    const id = session && session.id !== undefined ? session.id : undefined
    if (id === undefined || id === null) return
    const cwd = session && session.header && session.header.cwd ? session.header.cwd : ''
    core.onSessionEvent(id, event, { cwd, settings })
  }, { global: true })

  // ---- 全量对账：从每个会话的持久日志折叠当前状态，担保「全部活动会话」都被监控 ----
  // 覆盖场景：插件加载前已存在/恢复的会话（构造回放不发事件）、新建会话、
  // 或任何原因漏掉的实时事件——每 3 秒对 ctx.sessions.list() 全量折叠一次。
  const reconcileAll = () => {
    if (!settings.monitoring) return
    try {
      const sessions = typeof ctx.sessions !== 'undefined' && typeof ctx.sessions.list === 'function' ? ctx.sessions.list() : []
      for (const s of sessions) {
        if (!s || s.id === undefined || s.id === null) continue
        const cwd = s.header && s.header.cwd ? s.header.cwd : ''
        const ev = eventsOf(s)
        const folded = foldStateFromEvents(ev)
        core.resolveFromFold(s.id, folded, { cwd, settings, events: ev })
      }
    } catch (e) { /* ignore */ }
  }
  // 新建/恢复会话时立即对账一次
  ctx.on('session/created', (session) => {
    if (!settings.monitoring) return
    if (!session || session.id === undefined || session.id === null) return
    const cwd = session.header && session.header.cwd ? session.header.cwd : ''
    const ev = eventsOf(session)
    const folded = foldStateFromEvents(ev)
    core.resolveFromFold(session.id, folded, { cwd, settings, events: ev })
  })
  // 启动后立即一次 + 周期对账
  setTimeout(reconcileAll, 500)
  const reconcileTimer = setInterval(reconcileAll, 3000)
  ctx.on('dispose', () => { try { clearInterval(reconcileTimer) } catch (e) { /* ignore */ } })

  // ==================== lh-harness run 事件桥（阶段1C） ====================
  // 订阅 lh runs-root：把 lh 角色层（dsh 桥）的 429/失败纳入本监控仪表盘，
  // 可选自动 resume（SM_LH_AUTORESUME=1 时对 429 证据的 failed run 自动调
  // lh web 的 /api/runs/<id>/resume，受 SM_LH_MAX_RESUME 上限保护）。
  // 默认不指向任何机器专有路径：只有显式设置 SM_LH_RUNS_ROOT 时才扫描 lh runs。
  // 未设置时 readdir 返回空，本桥静默无数据，不影响核心监控。
  const LH_RUNS_ROOT = process.env.SM_LH_RUNS_ROOT || ''
  const LH_WEB_URL = process.env.SM_LH_WEB_URL || 'http://127.0.0.1:8799'
  const LH_AUTORESUME = process.env.SM_LH_AUTORESUME === '1'
  const LH_MAX_RESUME = Math.max(0, Number(process.env.SM_LH_MAX_RESUME || 2))
  const lhRuns = new Map() // run_id -> record
  const lhAlerts = []      // 最近 lh 层 429/失败告警（新在前）
  const lh429Re = /429|rate\s?limit|RATE_LIMIT|too many requests|tpm limit/i

  function postJson(url, payload) {
    return new Promise((resolve, reject) => {
      const u = new URL(url)
      const data = JSON.stringify(payload || {})
      const req = http.request({
        hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          let parsed = null
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (e) { /* ignore */ }
          resolve({ status: res.statusCode, body: parsed })
        })
      })
      req.on('error', reject)
      req.write(data)
      req.end()
    })
  }

  function lhRunDirs() {
    try {
      if (!fs.existsSync(LH_RUNS_ROOT)) return []
      return fs.readdirSync(LH_RUNS_ROOT).filter((n) => n.startsWith('20') || n.startsWith('idem-'))
    } catch (e) { return [] }
  }

  function lhResumeEvidence(runDir) {
    // 优先：runner 检查点 tmp/prompts/*.resume.json（retryable=true 且非 0 退出）
    try {
      const dir = path.join(runDir, 'tmp', 'prompts')
      if (!fs.existsSync(dir)) return { retryable: false, evidence: '' }
      const files = fs.readdirSync(dir).filter((n) => n.endsWith('.resume.json'))
      for (const f of files) {
        try {
          const cp = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
          if (cp && cp.retryable === true && cp.exit_code !== 0) {
            return { retryable: true, evidence: `resume:${(cp.model || '')}:exit${cp.exit_code}` }
          }
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    // 兜底：worker.log / 角色 episode 日志含 429 文案
    try {
      const wl = fs.readFileSync(path.join(runDir, 'worker.log'), 'utf8')
      if (lh429Re.test(wl)) return { retryable: true, evidence: 'worker.log' }
    } catch (e) { /* ignore */ }
    try {
      for (const sub of ['manager_episodes', 'cli_executor_episodes', 'cli_auditor_episodes', 'final_response_episodes']) {
        const root = path.join(runDir, 'lh_harness', sub)
        if (!fs.existsSync(root)) continue
        for (const ep of fs.readdirSync(root)) {
          const f = path.join(root, ep, 'agent.log')
          if (fs.existsSync(f) && lh429Re.test(fs.readFileSync(f, 'utf8'))) {
            return { retryable: true, evidence: `${sub}/${ep}` }
          }
        }
      }
    } catch (e) { /* ignore */ }
    return { retryable: false, evidence: '' }
  }

  let lhSummary = { root: LH_RUNS_ROOT, watched: 0, failed429: 0, autoResume: LH_AUTORESUME, maxResume: LH_MAX_RESUME, runs: [], alerts: [] }

  function lhScanOnce() {
    try {
      const now = Date.now()
      let failed429 = 0
      for (const name of lhRunDirs()) {
        const runDir = path.join(LH_RUNS_ROOT, name)
        let rec = lhRuns.get(name)
        if (!rec) { rec = { id: name, task: '', state: 'idle', retryable: false, resumed: 0, alertKeys: new Set(), firstSeen: now }; lhRuns.set(name, rec) }
        let state = 'idle'
        try {
          const st = JSON.parse(fs.readFileSync(path.join(runDir, 'control', 'status.json'), 'utf8'))
          state = (st && st.status) || 'idle'
        } catch (e) { /* missing status */ }
        if (!rec.task) {
          try {
            const owner = JSON.parse(fs.readFileSync(path.join(runDir, 'control', 'owner.json'), 'utf8'))
            rec.task = String(owner.task || '').slice(0, 120)
          } catch (e) { /* ignore */ }
        }
        const ev = lhResumeEvidence(runDir)
        rec.state = state
        rec.retryable = ev.retryable
        if (ev.retryable && state === 'failed') failed429 += 1
        const key = ev.retryable ? ('429:' + name + ':' + ev.evidence) : ('state:' + name + ':' + state)
        if (ev.retryable && !rec.alertKeys.has(key)) {
          rec.alertKeys.add(key)
          lhAlerts.unshift({ ts: now, kind: 'lh-429', run: name, task: rec.task || '', detail: ev.evidence, state })
          log(`lh run ${name} 429 证据: ${ev.evidence} (state=${state})`)
        }
        if (LH_AUTORESUME && ev.retryable && state === 'failed' && rec.resumed < LH_MAX_RESUME) {
          rec.resumed += 1
          log(`lh run ${name} 自动 resume (${rec.resumed}/${LH_MAX_RESUME})`)
          postJson(LH_WEB_URL + '/api/runs/' + encodeURIComponent(name) + '/resume', {})
            .then((r) => log(`lh resume ${name}: HTTP ${r.status}`))
            .catch((e) => log(`lh resume ${name} 失败: ${e && e.message || e}`))
        }
        if (rec.lastState !== state) { rec.lastState = state; log(`lh run ${name} -> ${state}${ev.retryable ? ' (含429证据)' : ''}`) }
      }
      // 清理超过 24h 且完全闲置的记录
      for (const [k, v] of [...lhRuns.entries()]) {
        if (now - (v.firstSeen || 0) > 24 * 3600 * 1000 && v.state === 'idle' && !v.retryable) lhRuns.delete(k)
      }
      while (lhAlerts.length > 10) lhAlerts.pop()
      lhSummary = {
        root: LH_RUNS_ROOT, watched: lhRuns.size, failed429, autoResume: LH_AUTORESUME, maxResume: LH_MAX_RESUME,
        runs: [...lhRuns.entries()].sort((a, b) => (b[1].firstSeen || 0) - (a[1].firstSeen || 0)).slice(0, 20)
          .map(([id, r]) => ({ id, state: r.state, retryable: !!r.retryable, task: r.task, resumed: r.resumed })),
        alerts: lhAlerts.slice(0, 10),
      }
    } catch (e) { log('lh 扫描失败: ' + (e && e.message || e)) }
  }
  const lhTimer = setInterval(lhScanOnce, 15000)
  setTimeout(lhScanOnce, 800)
  ctx.on('dispose', () => { try { clearInterval(lhTimer) } catch (e) { /* ignore */ } })

  // 把 lh 摘要并入 /api/state 快照
  const rawSnapshot = core.snapshot.bind(core)
  core.snapshot = (settingsArg) => {
    const snap = rawSnapshot(settingsArg)
    snap.lh = lhSummary
    return snap
  }

  // ---- 事件处理读取最新 settings：包装 onSessionEvent ----
  const rawOnSessionEvent = core.onSessionEvent.bind(core)
  core.onSessionEvent = (id, event, extras) => {
    rawOnSessionEvent(id, event, Object.assign({}, extras, { settings: settings }))
  }

  // ==================== HTTP 服务（独立端口，独立于 webui） ====================

  function json(res, code, value, extraHeaders = {}) {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, extraHeaders))
    res.end(JSON.stringify(value))
  }

  function body(req) {
    return new Promise((resolve, reject) => {
      let chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch (e) { reject(e) } })
      req.on('error', reject)
    })
  }

  function corsPreflight(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '3600' })
      res.end()
      return true
    }
    return false
  }

  // ---- HTTP 服务（独立端口；绑定失败自动回退候选端口，规避 Windows 排除段） ----
  let server = null
  let boundPort = 0
  const FALLBACK_PORTS = [8091, 8092, 8093, 8094, 8095, 8096, 8097, 8098, 8099, 8100]
  const portCandidates = [PORT].concat(FALLBACK_PORTS.filter((p) => p !== PORT))
    .filter((p, i, a) => a.indexOf(p) === i)
  let portIdx = 0

  function startServer() {
    const handler = async (req, res) => {
      if (corsPreflight(req, res)) return
      const url = req.url || '/'
      try {
        if (url === '/' || url === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(dashboardHtml())
          return
        }
        if (url === '/api/state') { json(res, 200, core.snapshot(settings)); return }
        if (url === '/api/settings' && req.method === 'GET') { json(res, 200, { settings }); return }
        if (url === '/api/settings' && req.method === 'POST') {
          const b = await body(req)
          if (typeof b.autoRetry === 'boolean') settings.autoRetry = b.autoRetry
          if (typeof b.maxRetries === 'number') settings.maxRetries = Math.max(1, Math.floor(b.maxRetries))
          if (typeof b.monitoring === 'boolean') settings.monitoring = b.monitoring
          // token-plan 额度用尽型定时重试间隔（分钟，最小 1）
          if (typeof b.tokenPlanRetryMin === 'number') {
            settings.tokenPlanRetryMs = Math.max(1, Math.floor(b.tokenPlanRetryMin)) * 60000
          }
          if (typeof b.desktopDisplay === 'boolean' && settings.desktopDisplay !== b.desktopDisplay) {
            settings.desktopDisplay = b.desktopDisplay
            if (b.desktopDisplay) spawnWidget()
            else killWidget()
          }
          saveSettings(settings)
          json(res, 200, { ok: true, settings })
          return
        }
        if (url === '/api/lh/scan' && req.method === 'POST') { lhScanOnce(); json(res, 200, { ok: true, lh: lhSummary }); return }
        const lm = url.match(/^\/api\/lh\/resume\/([^/]+)$/)
        if (lm && req.method === 'POST') {
          const rid = decodeURIComponent(lm[1])
          try {
            const r = await postJson(LH_WEB_URL + '/api/runs/' + encodeURIComponent(rid) + '/resume', {})
            json(res, r.status === 200 ? 200 : 500, { ok: r.status === 200, run: rid, ...(r.body || {}) })
          } catch (e) { json(res, 502, { ok: false, error: String(e && e.message || e) }) }
          return
        }
        const m = url.match(/^\/api\/session\/([^/]+)\/(continue|read|remove)$/)
        if (m) {
          const id = decodeURIComponent(m[1])
          const op = m[2]
          if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'post-only' }); return }
          if (op === 'continue') {
            // 支持自定义文本（测试模式发「你好」走同一权威链路）；缺省发「继续」
            const b = await body(req).catch(() => ({}))
            const text = b && typeof b.text === 'string' && b.text.trim() !== '' ? b.text : '继续'
            const r = core.continueSession(id, text)
            json(res, r.ok ? 200 : 500, r)
          }
          else if (op === 'read') { const r = core.markRead(id); json(res, r.ok ? 200 : 404, r) }
          else { const r = core.remove(id); json(res, r.ok ? 200 : 404, r) }
          return
        }
        if (url === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' })
          res.write('retry: 2000\n\n')
          const unsub = core.subscribe(() => {
            try { res.write('data: ' + JSON.stringify(core.snapshot(settings)) + '\n\n') } catch (e) { unsub() }
          })
          req.on('close', () => unsub())
          return
        }
        json(res, 404, { ok: false, reason: 'not-found' })
      } catch (e) {
        json(res, 500, { ok: false, error: String(e && e.message || e) })
      }
    }
    const srv = http.createServer(handler)
    srv.on('error', (e) => {
      const code = e && e.code
      if ((code === 'EACCES' || code === 'EADDRINUSE' || code === 'EPERM') && portIdx + 1 < portCandidates.length) {
        const failed = portCandidates[portIdx]
        portIdx += 1
        log(`端口 ${HOST}:${failed} ${code === 'EACCES' || code === 'EPERM' ? '无权限(可能为 Windows 排除段)' : '被占用'}，回退到 ${portCandidates[portIdx]}`)
        try { srv.close() } catch (err) { /* ignore */ }
        startServer()
        return
      }
      log('HTTP 服务错误: ' + (e && e.message || e))
    })
    srv.listen(portCandidates[portIdx], HOST, () => {
      boundPort = portCandidates[portIdx]
      server = srv
      log(`监控仪表盘: http://${HOST}:${boundPort}（独立于 webui，全部会话监控）`)
    })
  }
  startServer()

  ctx.on('dispose', () => {
    try { server && server.close() } catch (e) { /* ignore */ }
    try { core.clearAllTokenPlanTimers() } catch (e) { /* ignore */ }
    killWidget()
  })

  // ---- webui 设置页注入：会话监控 / ON AIR 桌面显示 开关 ----
  // webServer 为可选依赖：通过 ctx.inject 等待；缺失时仅跳过设置页注入，不影响其他功能。
  try {
    const injectSettingsPanel = (html) => {
      const base = 'http://127.0.0.1:' + (boundPort || PORT)
      return (typeof html === 'string' ? html : '') + settingsScript(base)
    }
    if (ctx.inject && typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scope) => {
        if (scope && typeof scope.tapIndex === 'function') {
          ctx.effect(() => scope.tapIndex(injectSettingsPanel), 'session-monitor: settings panel injection')
        }
      })
    } else if (ctx.webServer && typeof ctx.webServer.tapIndex === 'function') {
      ctx.effect(() => ctx.webServer.tapIndex(injectSettingsPanel), 'session-monitor: settings panel injection')
    }
  } catch (e) { log('设置页注入跳过: ' + (e && e.message || e)) }

  // 桌面件默认随启动（若开启且已安装）
  if (settings.desktopDisplay) {
    setTimeout(spawnWidget, 2000)
  }

  log(`已加载：${recordsCount()} 个已知会话，自动继续=${settings.autoRetry ? '开' : '关'}`)
  function recordsCount() { try { return [...core.records.values()].filter((r) => r.monitored).length } catch (e) { return 0 } }
}

// 兼容：default 导出也暴露 apply（便于 cordis 加载器）
export default { name, apply }