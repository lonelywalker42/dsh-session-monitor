# dsh-429-monitor

**DeepSeek Harness 会话监控 + 429 限流提醒 + 自动继续 + ON AIR 桌面指示标。**

DSH 会话可能因 LLM 提供方的 HTTP 429（rate limit）中断。本插件在 **dsh 主机进程内**
监听**所有会话**的生命周期事件，维护状态机，在 429 中断时提醒、（由你设定后）自动继续，
并提供一个独立的 HTTP 仪表盘与一个桌宠式 ON AIR 小窗。

同时兼容 **DeepSeek Harness 桌面版**与 **webui 版**——两者共用同一套 web 客户端，
本插件在两端行为一致。

```
状态机：空闲(idle) → 活动中(active) → { 等待回答 / 等待批准 / 429错误 / 报错 } → 工作完成(complete)
```

---

## 功能

| 组件 | 位置 | 作用 |
|------|------|------|
| **宿主侧监控** | `lib/index.js` → `host/session-monitor.mjs` | 主监控：监听全部会话、状态机、429 判定、自动继续、`http://127.0.0.1:8091` 仪表盘 |
| **客户端插件** | `client.js` | 输入栏状态徽章（🟢 空闲 / 🟠 运行中 / 🔴 429 中断）+ 429 弹窗 + 手动「继续」 |
| **ON AIR 桌面件** | `widget/onair-widget.exe` | 桌宠式无边框置顶小窗：`ON AIR` / `WAITING` / `429` / `DONE` / `STANDBY` |

- **429 判定只信数据层**：`turn/end` 的 `reason.kind==='error'` 且 `code==='RATE_LIMIT'` /
  `HTTP 429` / 文案命中才算终止性 429；`llm/retry` 只记录（宿主自己在重试）。
- **自动继续按会话精确路由**：经 `agent.followup(...)` 只发给**发生 429 的那个会话**，
  不会串到别的会话；同一 429 只发一次，连续上限默认 3 次，新回合自动重置。
- **不做 DOM 文本扫描**：不会把输入框或消息里的 "429" 误判成错误。
- **只检测最新状态**：仅当会话未运行、最后一次 `turn-error` 属于最新回合、且在
  `stopWindowMs`（默认 10 分钟）内才提醒；多轮前的历史 429 一律忽略。
- **全量监控**：每 3 秒对 `ctx.sessions.list()` 的每个会话日志做一次折叠，
  即使插件在会话活跃后才加载、或漏掉实时事件，也能保证所有活动会话被纳入。

---

## 安装

### 前置条件

- DeepSeek Harness **0.2.0-rc.2**（`dsh.client` 客户端插件机制与版本检查的实测基线）
- Node.js `^22.19.0 || >=24.0.0`
- 本插件**没有第三方运行时依赖**，宿主侧只用 `node:` 内置模块，**不需要编译/构建**

### 方式 A：用插件管理器（推荐）

在 DSH 的对话里让 agent 安装，或直接用 CLI：

```bash
# 桌面版 profile
dsh plugin --profile desktop add github:lonelywalker42/dsh-session-monitor

# webui profile
dsh plugin --profile web add github:lonelywalker42/dsh-session-monitor
```

安装后本包会作为 profile 层自动合入（`dsh.bundle.patch`），**无需手工编辑任何配置文件**。

> ⚠️ **`dsh plugin` 会写 profile，必须完全退出桌面应用后再运行**——
> 桌面应用独占 `profiles\desktop`。若在应用运行时执行，会得到：
> `error: profile "desktop" is managed exclusively by the Electron application`
>
> 也可以让 agent 通过插件管理工具安装（`install_bundle`），
> 目标填 `github:lonelywalker42/dsh-session-monitor`。
>
> 官方仓库是公开的，`install_bundle` 会在安装前用 `git ls-remote` 做一次连通性检查
> （默认 5 秒超时），因此需要能访问 github.com。

**安装后必须重启 DSH**（桌面版重启应用，webui 重启 `dsh web`）才生效。

### 方式 B：直接用 `file:///` 注册（不想走 pnpm / 想用本地副本）

把仓库克隆到任意位置，然后在对应 profile 的 `cordis.patch.yml`
（`%DSH_HOME%\profiles\<profile>\cordis.patch.yml`）追加：

```yaml
- insert:
    - id: session-monitor
      name: 'file:///绝对路径/dsh-session-monitor/lib/index.js'
      config:
        port: 8091
        desktopDisplay: false
```

> **只注册这一行。** `file:///` 形式会经 nearestPackage 向上找到本包的 `package.json`，
> 因此它同时提供宿主侧监控与客户端状态徽章。
>
> ⚠️ 同一个包**只能有一个** active Loader source。若再额外加一行
> （例如另一行 `name: dsh-429-monitor`，或指向 `host/session-monitor.mjs`），
> `dsh-client-modules` 会抛
> `ClientPackageCompositionError: package dsh-429-monitor resolves from multiple active Loader sources`，
> **最坏情况导致整个客户端插件图谱（含官方插件）无法组成**。二选一即可。
>
> 也**不要**把 `name` 指向 `client.js`：它是浏览器 bundle（顶层就调用
> `window.__ModuleLoader__.load`），在 Node 宿主里导入会因 `window is not defined` 崩溃。

### 配置项

写在上面 patch 行的 `config:` 下，或经环境变量覆盖：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `port` | 注册配置 8091；代码兜底 3091 | 独立仪表盘端口；被占用或在 Windows 排除段时自动回退 `8091~8100` |
| `host` | `127.0.0.1` | 监听地址（环境变量 `SM_HOST`） |
| `autoRetryDefault` | `false` | 自动继续的初始开关 |
| `maxRetries` | `3` | 连续自动继续上限 |
| `monitoring` | `true` | 是否启用会话监控 |
| `desktopDisplay` | `true` | 是否随监控拉起 ON AIR 桌面件 |
| `widgetPath` | 自动探测 | 桌面件 exe 路径（默认按插件自身目录解析） |
| `tokenPlanRetryMs` | `3600000` | token-plan 额度用尽型 429 的定时重试间隔 |

环境变量：`SM_PORT`、`SM_HOST`、`SM_WIDGET_EXE`、`SM_WIDGET_BAT`。

---

## 使用

### 仪表盘

重启后打开 **<http://127.0.0.1:8091>**，或在 PowerShell 里：

```powershell
Invoke-RestMethod http://127.0.0.1:8091/api/state
```

- 表格：状态（彩色圆点）/ 会话标题与 id / 活动时间 / 最近告警 / 自动继续次数 / 操作
- 操作：`继续`（手动恢复）/ `已读`（工作完成后移除）/ `移除`
- 左上角「自动继续」开关，持久化到 `%DSH_HOME%\storages\session-monitor\profiles\profile-<编码profile>\settings.json`
- 1 秒自动刷新；接口：`/api/state`（JSON）、`/api/events`（SSE）、`/api/settings`（读写）

### 自动继续

默认**只提醒不自动继续**。在仪表盘打开「自动继续」开关后，插件会在 429 终止时自动发送「继续」。

浮窗、设置页、仪表盘和桌面件共享当前宿主的设置，自动继续只在宿主执行。旧客户端 localStorage 中的开启意图会显示迁移提示，不会静默开启宿主。

### ON AIR 桌面件

`widget/onair-widget.exe` 是一个 WPF 无边框置顶小窗，只消费 `:8091` 的 API：

- 任一会话「活动中」→ 红色 `ON AIR`；等待回答/批准 → 蓝色 `WAITING`；
  429 → 红色闪烁 `429`；全部完成 → 琥珀 `DONE`；无会话 → 灰 `STANDBY`
- 全部会话列表 + 最近 429 告警横幅 + 「自动继续」开关
- 主机监控离线时显示 `OFFLINE`

默认由监控在启动 2 秒后自动拉起（`desktopDisplay: true`）。
想手动启动或不想让它弹窗：

```bat
widget\onair-widget.bat            :: 默认端口 8091
widget\onair-widget.bat 8092       :: 指定端口
```

把 `onair-widget.bat` 的快捷方式放进 `shell:startup` 可开机自启。

> 仅 Windows 提供预编译 exe。源码见 `widget/onair-widget.cs`；
> `widget/onair-widget.ps1` 是 PowerShell 版回退实现，**必须保持 UTF-8 with BOM 编码**
> （Windows PowerShell 5.1 按 ANSI 读取无 BOM 文件会导致中文解析失败）。

---

## 兼容性

**实测基线：DeepSeek Harness 0.2.0-rc.2（桌面版与 webui 版共用同一套 web 客户端）。**

依赖的宿主侧事件与服务（均已在 0.2.0-rc.2 中确认存在）：

- 事件：`agent/created`、`agent/status`、`agent/error`、`agent/disposed`、
  `session/event`（`turn/start`、`tool/call`、`tool/result`、`approval/asked`、`llm/retry`、`turn/end`）、
  `agent/inbox/spliced`
- 服务：`ctx.sessions.list()`、`ctx.agents.get(id)`、`ctx.tools`、`ctx.webServer.tapIndex`、
  `agent.followup(...)`
- 客户端：`window.__ModuleLoader__.load`、`slots.register('conversation.input.left')`、
  `ctx.locale.register`

### 客户端插件的两条硬性要求

1. `package.json` 的 `dsh.client.platform` **必须是字符串 `"web"`**。
   它不是枚举，但 DSH 只比较 `=== "web"`；写成 `"desktop"` 语法合法却会被**静默跳过**，
   两端都加载不到。桌面版的「客户端」就是 web 客户端。
2. `exports["./client"]` **必须存在**（字符串或 `{ default: string }`），否则是硬启动错误。

### 版本检查

本包声明 `engines.dsh: "^0.2.0-rc.2"`。宿主侧只用 Node 内置模块，
不为任何 DSH 内部包声明 peerDependencies，因此**不会**被 0.2.x 的 peer 兼容检查拒绝。

---

## 开发与自测

```bash
node test/smoke.mjs        # 客户端插件断言
node test/load-sim.mjs     # 客户端加载/注册/渲染链路模拟（需要 React）
node host/test-core.mjs    # 宿主侧状态机断言
node test/endpoint-routing.mjs # 桌面 / web 双实例端口路由
node test/dashboard.mjs    # 生成页面脚本、状态统计与离线提示
node widget/build.mjs      # Windows 桌面件：编译源码并内嵌共享 XAML
node dev/preview.mjs       # 隔离的 Glass UI 预览（模拟会话数据）
```

Glass 预览默认运行在 <http://127.0.0.1:18091>，会话浮窗见 <http://127.0.0.1:18091/popup>；
预览操作不会发送到真实 DSH 会话。Windows 桌面件的前景离屏布局检查可运行 `node dev/render-widget.mjs`，
该检查需要能够运行 .NET Framework/WPF 的 Windows 环境；系统背景模糊仍需实机验收。
双实例端口核查、已实现变更及后续优先级见 [优化方案](docs/optimization-plan.md)。

`test/load-sim.mjs` 需要一个可解析的 React/ReactDOM。脚本会依次尝试
`DSH_REACT_ROOT` → `DSH_CHECKOUT` → 常规 Node 解析（插件目录、逐级向上、
`~/.dsh/profiles/{desktop,web}`）→ 本机已知的 dsh 检出目录。都找不到时可显式指定：

```powershell
$env:DSH_REACT_ROOT = 'D:\Deepseek_Harness\deepseek-harness\apps\web\node_modules'
node test/load-sim.mjs
```

---

## 故障排查

| 现象 | 原因与处理 |
|------|-----------|
| `profile "desktop" is managed exclusively by the Electron application` | 桌面应用正在运行并独占 profile。完全退出桌面应用后再执行 `dsh plugin` |
| `skipping profile bundle "dsh-429-monitor": Plugin ... is incompatible with dsh X` | 你的 DSH 版本与本包声明的版本不符。升级 DSH，或（明确知晓风险时）用 `dsh plugin allow-version` 放行 |
| 仪表盘打不开 | 端口被占用会自动回退；看 dsh 主机日志里的 `监控仪表盘: http://127.0.0.1:<port>`。也可设 `SM_PORT` |
| 输入栏没有状态徽章 | ① 是否已重启 DSH；② `package.json` 的 `dsh.client.platform` 是否为 `"web"`；③ 浏览器控制台是否有 `ClientPackageCompositionError`（同包多 source） |
| `ClientPackageCompositionError: ... multiple active Loader sources` | 同一个包被注册了两行。删掉多余的那一行，只保留一行 |
| ON AIR 小窗不出现 | 确认 `widget/onair-widget.exe` 存在；`desktopDisplay` 是否为 `true`；或手动跑 `widget\onair-widget.bat` |

---

## 许可证

MIT

## 1.2.0 实例绑定与暂存消息

宿主在页面脚本加载前注入 API 地址、稳定实例 ID 和 profile；缺少注入或身份不一致时客户端显示“未绑定宿主”，禁止发送。端口选择优先级为 SM_PORT > config.port > 3091，绑定失败回退 8091–8100；桌面件启动参数使用实际绑定端口。当前机器 desktop 为 8091、web 为 8092，二者独立。

设置使用版本 2 文件按 profile 保存，实例 ID 随重启保留。首次从旧全局 settings.json 迁移，保留原文件；损坏文件会报错而非覆盖。自定义安装可配置 profileId 或 SM_PROFILE，避免依赖端口推断。

暂存队列按实例保存在浏览器 localStorage，状态包括待发送、发送中、已发送、失败、结果未知。浏览器关闭时计时暂停。发送使用 requestId 去重，只有宿主确认 followup 成功后才标记已发送；回执丢失会查询宿主，无法确认时需要核实后手动重发。回执仅保留在宿主内存，重启后不可查询；这不是持久化后台调度。旧队列保留为可复制草稿，需重新选择目标。

连接中断保留上次会话列表并禁用消息操作；活动时间来自实际事件。完成、空闲、普通错误和限流有独立状态。Glass 界面采用青绿活动、淡蓝等待、淡紫完成和珊瑚红异常；Windows 原生模糊不可用时使用实色回退。

## 可选 LH bridge

默认不扫描 LH。显式设置 SM_LH_RUNS_ROOT 后读取其 run 日志；SM_LH_WEB_URL 默认 http://127.0.0.1:8799。SM_LH_AUTORESUME=1 允许对有 429 证据的失败 run 自动 resume，SM_LH_MAX_RESUME 默认 2。此桥接独立于 DSH 会话自动继续，不保证跨宿主重启去重。

开发检查：npm install --ignore-scripts 后运行 npm test；Windows 运行 npm run build:widget。构建会生成 widget/build-manifest.json，记录每个源码及 exe 的 SHA256 和基础提交，未提交改动以源码摘要为准。CI 覆盖 Node 22/24 逻辑与 Windows 编译、前景布局渲染；系统模糊与 DPI 仍需实机检查。
