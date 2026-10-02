/**
 * dsh-429-monitor, browser half.
 *
 * DSH 会话状态监测 + 429 错误提醒 +（可选）自动继续。
 *
 * 设计要点（v2）：
 *  - 只信会话数据层 ConversationSnapshot，不做 DOM 文本扫描——避免把用户输入/
 *    消息文本中的 "429" 误判为错误。
 *  - 只检测「最新状态」：会话当前未运行、最后一次 turn-error 属于最新一回合、
 *    且在 stopWindowMs 判定窗口内、且为 429/限流——多轮对话前的历史 429 一律忽略。
 *  - 仿照 codex 关注当前活动会话：状态徽章随当前会话渲染，显示其标题与活动情况。
 *  - 出现 429 时弹出小窗提醒；自动继续「继续」为用户开关（默认关闭，持久化到
 *    localStorage），开启后经 session.prompt 自动发送，无需手动介入。
 *
 * This file IS the shipped client bundle: a classic script that registers
 * one module factory with the shell's module loader (same shape as every
 * built dsh client bundle — no build step, no external dependency beyond
 * the React instance the shell provides via require("react")).
 *
 * 桌面版（desktop profile）说明 —— 本文件无需任何改动即可在桌面版生效：
 *  - 桌面版是 Electron 外壳，内部加载的是**同一套** web 客户端（dsh-app://app/），
 *    window.__DSH_BOOT__ / window.__ModuleLoader__ 协议与 webui 版完全一致。
 *  - 两项要求写在 package.json：dsh.client.platform 须为 "web"，
 *    且 exports["./client"] 必须指向本文件；缺任一项本 bundle 都不会下发
 *    （此外该行还需未被 disabled、且已建立 fiber）。
 *  - 因此请勿把 platform 改成 "desktop"：该值无人读取，会导致插件在两端都加载不到。
 */
window.__ModuleLoader__.load({
	id: "dsh-429-monitor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		// ==================== 配置 ====================
		var CONFIG = {
			/** 检测到 429 会话停止后延迟多久自动发送「继续」（毫秒）。 */
			retryDelayMs: 4000,
			/** 连续自动发送最大次数（达到后自动关闭；会话恢复运行即重置）。 */
			maxRetries: 3,
			/** 自动继续默认开关（false = 默认只提醒；用户在小窗开启后持久化）。 */
			autoRetryDefault: false,
			/** 检测列表最多保留条数。 */
			maxDetections: 8,
			/** 同一条错误（签名相同）的提醒去重窗口（毫秒）。 */
			dedupeWindowMs: 10000,
			/**
			 * 「最新停止」判定窗口（毫秒）：一次 429 终止必须发生在这个时间窗内、
			 * 且属于最新一回合，才算「当前状态」；更早的（含多轮对话前的历史）
			 * 一律忽略，避免重新打开旧会话时对陈旧中断反复提醒。
			 */
			stopWindowMs: 600000,
			/** 状态徽章显示「429 中断」的时间窗口（毫秒）。 */
			interruptedWindowMs: 90000,
			/** 会话恢复运行（agent 有输出）后视为一次成功的自动继续。 */
			resumeWatchMs: 20000
		};

		/** 429 / rate limit 文案匹配模式（仅用于 turn-error 的 message 兜底判定）。 */
		var RATE_LIMIT_PATTERNS = [
			/\b429\b/,
			/rate\s*[-_]?limit/i,
			/too many requests/i,
			/request limit/i,
			/请求过于频繁/,
			/配额不足/,
			/超出.*配额/,
			/limit exceeded/i,
			/reached.*(?:limit|quota)/i
		];

		// ==================== 样式（模块求值时注入一次） ====================
		var CSS = [
			"/* ---- 状态徽章（输入栏左侧） ---- */",
			".dsh429-badge{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:5px;font-size:12px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap;flex-shrink:0;border:1px solid var(--dsw-border-color, rgba(128,128,128,.35));background:color-mix(in srgb, var(--dsw-bg-color, #1c1c1c) 70%, transparent);color:var(--dsw-text-color-secondary, #aaa);font-family:inherit;line-height:1;transition:border-color .15s,color .15s,transform .1s;}",
			".dsh429-badge:hover{filter:brightness(1.15);}",
			".dsh429-badge:active{transform:scale(.96);}",
			".dsh429-badge[data-status=\"running\"]{border-color:rgba(255,180,50,.55);color:#ffb432;}",
			".dsh429-badge[data-status=\"waiting\"]{border-color:rgba(77,166,255,.55);color:#4da6ff;}",
			".dsh429-badge[data-status=\"interrupted\"],.dsh429-badge[data-alert=\"true\"]{border-color:rgba(255,80,80,.7);color:#ff5050;animation:dsh429-pulse 1.2s ease-in-out infinite;}",
			".dsh429-badge[data-status=\"error\"]{border-color:rgba(255,120,90,.6);color:#ff785a;}",
			".dsh429-badge-dot{width:7px;height:7px;border-radius:50%;background:#6b6b6b;flex-shrink:0;}",
			".dsh429-badge[data-status=\"running\"] .dsh429-badge-dot{background:#ffb432;animation:dsh429-blink 1.2s ease-in-out infinite;}",
			".dsh429-badge[data-status=\"waiting\"] .dsh429-badge-dot{background:#4da6ff;animation:dsh429-blink 1.6s ease-in-out infinite;}",
			".dsh429-badge[data-status=\"interrupted\"] .dsh429-badge-dot,.dsh429-badge[data-status=\"error\"] .dsh429-badge-dot{background:#ff5050;}",
			".dsh429-badge[data-status=\"idle\"] .dsh429-badge-dot{background:#50c850;}",
			".dsh429-badge-count{padding:1px 6px;border-radius:8px;background:rgba(255,80,80,.18);color:#ff5050;font-size:11px;font-weight:700;}",
			".dsh429-badge-activity{font-size:10px;color:var(--dsw-text-color-secondary, #888);font-variant-numeric:tabular-nums;}",
			".dsh429-badge-retry{font-size:11px;color:#ffb432;}",
			"@keyframes dsh429-pulse{0%,100%{opacity:.85}50%{opacity:1}}",
			"@keyframes dsh429-blink{0%,100%{opacity:.4}50%{opacity:1}}",
			"/* ---- 小窗（右下角浮层） ---- */",
			".dsh429-root{position:fixed;right:24px;bottom:24px;z-index:2147483000;font-family:var(--dsw-font-ui, system-ui, -apple-system, \"Segoe UI\", sans-serif);color-scheme:dark;}",
			".dsh429-popup{width:360px;max-width:calc(100vw - 32px);border-radius:12px;border:1px solid rgba(255,255,255,.12);background:#1b1e25;color:#e6e6e6;box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden;display:none;font-size:13px;line-height:1.5;}",
			".dsh429-popup[data-open=\"true\"]{display:block;}",
			".dsh429-popup[data-collapsed=\"true\"] .dsh429-body,.dsh429-popup[data-collapsed=\"true\"] .dsh429-foot{display:none;}",
			".dsh429-popup[data-collapsed=\"true\"]{width:auto;min-width:200px;}",
			".dsh429-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:linear-gradient(90deg, rgba(255,80,80,.22), rgba(255,160,50,.12));cursor:grab;border-bottom:1px solid rgba(255,255,255,.08);user-select:none;}",
			".dsh429-head:active{cursor:grabbing;}",
			".dsh429-title{font-weight:700;font-size:13px;color:#ffd0d0;}",
			".dsh429-title[data-status=\"running\"]{color:#ffd0a0;}",
			".dsh429-title[data-status=\"waiting\"]{color:#a8d0ff;}",
			".dsh429-title[data-status=\"idle\"]{color:#b8e0c8;}",
			".dsh429-head-actions{display:flex;gap:4px;}",
			".dsh429-btn{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#d8d8d8;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit;line-height:1.4;}",
			".dsh429-btn:hover{background:rgba(255,255,255,.14);}",
			".dsh429-btn-mini{width:22px;height:22px;padding:0;line-height:1;font-size:12px;}",
			".dsh429-close{color:#ff9a9a;}",
			".dsh429-body{padding:8px 10px;}",
			".dsh429-session-row{display:flex;align-items:center;gap:6px;margin-bottom:2px;}",
			".dsh429-session-name{font-weight:700;font-size:13px;color:#e8e8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}",
			".dsh429-session-id{color:#777;font-size:11px;flex-shrink:0;font-variant-numeric:tabular-nums;}",
			".dsh429-status-row{display:flex;align-items:center;gap:6px;margin-bottom:6px;}",
			".dsh429-status-dot{width:8px;height:8px;border-radius:50%;background:#6b6b6b;}",
			".dsh429-status-dot[data-status=\"running\"]{background:#ffb432;animation:dsh429-blink 1.2s infinite;}",
			".dsh429-status-dot[data-status=\"waiting\"]{background:#4da6ff;animation:dsh429-blink 1.6s infinite;}",
			".dsh429-status-dot[data-status=\"interrupted\"],.dsh429-status-dot[data-status=\"error\"]{background:#ff5050;}",
			".dsh429-status-dot[data-status=\"idle\"]{background:#50c850;}",
			".dsh429-status-text{font-weight:600;}",
			".dsh429-activity-text{color:#999;font-size:11px;margin-left:auto;font-variant-numeric:tabular-nums;}",
			".dsh429-list{list-style:none;margin:0;padding:0;max-height:200px;overflow-y:auto;}",
			".dsh429-item{display:flex;align-items:baseline;gap:6px;padding:5px 4px;border-top:1px solid rgba(255,255,255,.06);font-size:12px;}",
			".dsh429-item-alert{background:rgba(255,80,80,.10);border-radius:6px;}",
			".dsh429-item-time{color:#888;flex-shrink:0;font-variant-numeric:tabular-nums;}",
			".dsh429-item-code{flex-shrink:0;color:#ff8080;font-weight:700;background:rgba(255,80,80,.14);border-radius:4px;padding:0 4px;}",
			".dsh429-item-msg{color:#d8d8d8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}",
			".dsh429-empty{color:#888;padding:6px 4px;font-size:12px;}",
			".dsh429-stage{margin-top:6px;border-top:1px solid rgba(255,255,255,.08);padding:6px 4px 2px;}",
			".dsh429-stage-head{display:flex;align-items:center;justify-content:space-between;cursor:pointer;}",
			".dsh429-stage-title{font-size:12px;font-weight:700;color:#c8d8ff;}",
			".dsh429-stage-body{padding-top:6px;}",
			".dsh429-stage-input{width:100%;min-height:38px;box-sizing:border-box;padding:5px 7px;border-radius:6px;border:1px solid #444;background:#1c1f27;color:#eee;font-family:inherit;font-size:12px;resize:vertical;}",
			".dsh429-stage-row{display:flex;align-items:center;gap:6px;margin:5px 0;}",
			".dsh429-stage-label{color:#aaa;font-size:11px;flex:none;}",
			".dsh429-stage-list{list-style:none;margin:2px 0 0;padding:0;max-height:120px;overflow-y:auto;}",
			".dsh429-stage-item{display:flex;align-items:center;gap:6px;padding:3px 2px;border-top:1px solid rgba(255,255,255,.05);font-size:11px;}",
			".dsh429-stage-text{color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;}",
			".dsh429-stage-meta{color:#888;font-size:10px;flex:none;}",
			".dsh429-stage-empty{color:#777;padding:4px 2px;font-size:11px;}",
			".dsh429-foot{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid rgba(255,255,255,.08);}",
			".dsh429-btn-primary{background:linear-gradient(90deg, #ff5050, #ff7a3c);border-color:transparent;color:#fff;font-weight:700;}",
			".dsh429-btn-primary:hover{filter:brightness(1.1);}",
			".dsh429-btn-primary:disabled{opacity:.55;cursor:not-allowed;}",
			".dsh429-retry-state{color:#999;font-size:11px;margin-left:auto;}"
		].join("\n");
		var cssTagId = "dsh-429-monitor/plugin.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + cssTagId + "\"]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-429-monitor";
			tag.dataset.pluginCss = cssTagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ==================== 纯逻辑函数 ====================

		/** 判断错误文案是否命中 429 / rate limit（仅作 turn-error message 兜底）。 */
		function is429Message(text) {
			return typeof text === "string" && RATE_LIMIT_PATTERNS.some(function (p) { return p.test(text); });
		}

		/** 判断错误码是否为限流（RATE_LIMIT 或裸 429）。 */
		function isRateLimitCode(code) {
			if (typeof code !== "string") return false;
			var c = code.trim().toUpperCase();
			return c === "RATE_LIMIT" || c === "429" || c === "HTTP 429";
		}

		/**
		 * 由会话快照派生会话状态。
		 * @returns 'running' | 'idle' | 'error' | 'blank' | 'unknown'
		 */
		function deriveSessionStatus(session) {
			if (!session || typeof session !== "object") return "unknown";
			if (session.openState === "error") return "error";
			if (session.running) return "running";
			if (session.promptError) return "error";
			if (session.lastAgentError) return "error";
			if (session.blank) return "blank";
			return "idle";
		}

		/**
		 * 会话活动信息（仅最新状态）：最新回合号、最新回合开始时间、最后一条事件时间。
		 */
		function activityInfo(session) {
			var info = { latestTurn: 0, runningSince: 0, lastTime: 0 };
			if (!session) return info;
			var nodes = session.nodes;
			if (Array.isArray(nodes)) {
				for (var i = nodes.length - 1; i >= 0; i--) {
					if (nodes[i] && nodes[i].time) { info.lastTime = nodes[i].time; break; }
				}
			}
			if (session.turnTimings && typeof session.turnTimings.forEach === "function") {
				session.turnTimings.forEach(function (v, k) { if (k > info.latestTurn) info.latestTurn = k; });
				if (info.latestTurn > 0 && typeof session.turnTimings.get === "function") {
					var t = session.turnTimings.get(info.latestTurn);
					if (t && t.startTime) info.runningSince = t.startTime;
				}
			}
			return info;
		}

		/**
		 * 只取「最新状态」的 429 停止信号——不扫描多轮对话前的历史错误：
		 *  - 会话当前未在运行（turn 已结束）；
		 *  - 最后一次 turn-error 属于最新一回合（turn === 最新 turn）；
		 *  - 该错误发生在 stopWindowMs 之内（避免重新打开旧会话时对陈旧中断反复提醒）；
		 *  - 错误是 429/限流。
		 * @param {object} session - ConversationSnapshot。
		 * @returns {object|null} { key, code, message, time, turn, seq } 或 null。
		 */
		function latest429Stop(session) {
			if (!session || session.running) return null;
			var nodes = session.nodes;
			if (!Array.isArray(nodes) || nodes.length === 0) return null;

			// 最新回合号：turnTimings 最大 key
			var latestTurn = 0;
			if (session.turnTimings && typeof session.turnTimings.forEach === "function") {
				session.turnTimings.forEach(function (v, k) { if (k > latestTurn) latestTurn = k; });
			}
			var now = Date.now();
			// 从尾向前找最后一次 turn-error（nodes 按 seq 有序）
			for (var i = nodes.length - 1; i >= 0; i--) {
				var node = nodes[i];
				if (!node || node.kind !== "turn-error") continue;
				// 该失败属于最新回合才算「当前状态」；否则说明后面已有多轮对话，是历史错误
				if (latestTurn > 0 && node.turn !== latestTurn) return null;
				// 过期（重新打开旧会话等场景）一律忽略
				if (typeof node.time === "number" && now - node.time > CONFIG.stopWindowMs) return null;
				if (isRateLimitCode(node.code) || is429Message(node.message)) {
					return {
						key: "turn-error:" + node.seq,
						code: node.code || "",
						message: node.message || "",
						time: node.time || now,
						turn: node.turn,
						seq: node.seq
					};
				}
				return null; // 最新回合结束但错误不是 429
			}
			return null;
		}

		// ==================== 设置持久化（自动继续开关） ====================

		var SETTINGS_KEY = "dsh:429-monitor.settings";

		function loadSettings() {
			try {
				if (typeof window !== "undefined" && window.localStorage) {
					var raw = window.localStorage.getItem(SETTINGS_KEY);
					if (raw) {
						var p = JSON.parse(raw);
						return { autoRetry: p.autoRetry === true };
					}
				}
			} catch (e) { /* ignore */ }
			return { autoRetry: CONFIG.autoRetryDefault };
		}

		function saveSettings() {
			try {
				if (typeof window !== "undefined" && window.localStorage) {
					window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ autoRetry: state.retryEnabled }));
				}
			} catch (e) { /* ignore */ }
		}

		// ==================== 模块级 store（pub/sub） ====================

		var listeners = new Set();
		var state = {
			enabled: true,
			status: "unknown",
			sessionId: null,
			sessionTitle: "",
			running: false,
			runningSince: 0,
			lastActivityAt: 0,
			detections: [],
			hostSessions: [],
			stagedMessages: loadStaged(),  // 消息暂存区 [{id, text, sessionId, sent, sendAt, createdAt}]
			stagedText: "",
			stagedSessionId: "",
			stagedDelayMin: 0,              // 延迟发送（分钟；0 = 立即）
			retryEnabled: loadSettings().autoRetry,
			retryCount: 0,
			retryPending: false,
			testResult: null,
			popupVisible: false,
			collapsed: false
		};

		function setState(patch) {
			state = Object.assign({}, state, patch);
			listeners.forEach(function (l) {
				try { l(state); } catch (e) { console.error("[dsh-429-monitor] listener error", e); }
			});
		}

		/** 订阅 store，返回退订函数（供 react.useSyncExternalStore 使用）。 */
		function subscribe(fn) {
			listeners.add(fn);
			return function () { listeners.delete(fn); };
		}

		/** 读取 store 快照。 */
		function getState() {
			return state;
		}

		// ==================== 429 事件入口 ====================

		/**
		 * 记录一次 429 检测并弹出小窗（仅由 latest429Stop 触发的当前停止事件调用）。
		 * @param {object} info - { message, code, source, sessionId, autoSend, autoKey }
		 *  autoSend: 当用户开启了自动继续时为 true。
		 */
		function pushDetection(info) {
			info = info || {};
			var now = Date.now();
			var time = info.time || now;
			var message = String(info.message == null ? "" : info.message).slice(0, 400);
			var code = String(info.code == null ? "" : info.code);
			var source = String(info.source == null ? "turn-error" : info.source);
			var signature = source + "|" + code + "|" + message;
			var recent = state.detections.some(function (d) {
				return d.signature === signature && now - d.time < CONFIG.dedupeWindowMs;
			});
			if (recent) return;

			var det = {
				id: time + "-" + Math.random().toString(36).slice(2, 7),
				time: time,
				message: message,
				code: code,
				source: source,
				signature: signature,
				sessionId: info.sessionId == null ? state.sessionId : info.sessionId
			};
			var detections = [det].concat(state.detections).slice(0, CONFIG.maxDetections);
			var patch = { detections: detections, popupVisible: true };
			if (isRateLimitCode(code)) patch.status = "interrupted";
			setState(patch);
			console.warn("[dsh-429-monitor] 会话因 429 中断: [" + code + "] " + message.slice(0, 120));

			// 用户开启了自动继续 → 延迟自动发送「继续」
			if (info.autoSend === true && state.retryEnabled) {
				scheduleAutoContinue(det.sessionId, info.autoKey || null);
			}
		}

		/** 清空检测记录（保留状态）。 */
		function clearDetections() {
			setState({ detections: [] });
		}

		/** 切换小窗可见性。 */
		function togglePopup() {
			setState({ popupVisible: !state.popupVisible, collapsed: false });
		}

		/** 切换折叠/展开（小窗最小化）。 */
		function toggleCollapsed() {
			setState({ collapsed: !state.collapsed });
		}

		// ==================== 发送「继续」 ====================

		/** 模块级座位引用（组件渲染时更新；自动继续的降级发送路径）。 */
		var currentSeat = null;
		/** 模块级 sessions 服务引用（apply 时通过 ctx.inject 捕获；用于按会话作用域直接发送）。 */
		var sessionsService = null;

		/**
		 * 按会话作用域直接发送文本（最可靠的无手动介入路径）。
		 * 通过 ctx.sessions.binding(sessionId).session.prompt([{type:"text",text}], "queue")
		 * 发送——与 conversation.send 内部完全一致，不依赖输入框/合成器状态。
		 * @param {string|null} sessionId - 目标会话 id。
		 * @param {string} text - 要发送的文本。
		 * @returns {Promise<boolean>}
		 */
		function sendToSession(sessionId, text) {
			if (!sessionId || !sessionsService) return Promise.resolve(false);
			var binding;
			try { binding = sessionsService.binding(sessionId); } catch (e) { binding = void 0; }
			var session = binding && binding.session;
			if (!session || typeof session.prompt !== "function") return Promise.resolve(false);
			try {
				return Promise.resolve(session.prompt([{ type: "text", text: text }], "queue"))
					.then(function (result) {
						return !!(result && result.ok);
					})
					.catch(function (e) {
						console.error("[dsh-429-monitor] session.prompt 发送失败:", e);
						return false;
					});
			} catch (e) {
				console.error("[dsh-429-monitor] session.prompt 调用失败:", e);
				return Promise.resolve(false);
			}
		}

		/**
		 * 通过插槽座位发送（降级：conversation.send 或 inputActions.setDraft+submit）。
		 */
		function sendMessage(seat, text) {
			if (!seat) return Promise.resolve(false);
			try {
				if (seat.conversation && typeof seat.conversation.send === "function") {
					return Promise.resolve(seat.conversation.send(text)).then(function () { return true; });
				}
			} catch (e) {
				console.error("[dsh-429-monitor] conversation.send 失败:", e);
			}
			try {
				if (seat.inputActions && typeof seat.inputActions.setDraft === "function") {
					seat.inputActions.setDraft(text);
					if (typeof seat.inputActions.submit === "function") seat.inputActions.submit();
					return Promise.resolve(true);
				}
			} catch (e) {
				console.error("[dsh-429-monitor] 降级发送失败:", e);
			}
			return Promise.resolve(false);
		}

		/**
		 * 发送任意文本到指定会话（「继续」「你好」共用同一链路）。
		 * 优先级：主机监控 continue 端点（权威 + agentResolver 兜底）→ session.prompt → 合成器座位。
		 * 合成器座位兜底仅在目标会话 === 当前聚焦会话时启用（修复跨会话误发）。
		 * @param {string|null} sessionId - 目标会话 id。
		 * @param {string} text - 要发送的文本。
		 */
		function sendText(sessionId, text) {
			var sid = sessionId || state.sessionId;
			var attempts = [];
			if (typeof window !== "undefined" && typeof window.fetch === "function") {
				attempts.push(function () {
					// 必须读 body.ok：主机端点即使发送失败也返回 HTTP 200（{ok:false}），
					// 只看 HTTP 状态会误报「已发送」
					return window.fetch(HOST_API + "/session/" + encodeURIComponent(sid) + "/continue", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ text: text })
					}).then(function (r) {
						return r.json().then(function (j) { return !!(j && j.ok === true); }).catch(function () { return false; });
					}).catch(function () { return false; });
				});
			}
			attempts.push(function () { return sendToSession(sid, text); });
			// 关键修复：只有目标会话 === 当前聚焦会话时，才允许用合成器座位兜底
			if (sid === state.sessionId && currentSeat) {
				attempts.push(function () { return sendMessage(currentSeat, text); });
			}
			var idx = 0;
			var next = function () {
				if (idx >= attempts.length) return Promise.resolve(false);
				return attempts[idx++]().then(function (ok) { return ok ? true : next(); });
			};
			return next().then(function (ok) {
				if (ok) setState({ retryCount: state.retryCount + 1, retryPending: false });
				return ok;
			});
		}

		/** 发送「继续」（恢复 429 中断）。 */
		function sendContinue(sessionId) {
			return sendText(sessionId, "继续");
		}

		/** 测试模式：发送「你好」验证发送链路（与「继续」同一路径）。 */
		function sendTest(sessionId) {
			return sendText(sessionId, "你好");
		}

		// ==================== 自动继续 ====================

		var retryTimer = null;
		/** 已自动发送「继续」的事件键（sessionId + node seq），避免对同一节点重复发送。 */
		var autoSentKeys = new Set();

		/**
		 * 检测到 429 会话中断后，延迟自动发送「继续」。
		 * @param {string} sessionId - 目标会话 id。
		 * @param {string|null} key - 事件去重键。
		 */
		function scheduleAutoContinue(sessionId, key) {
			if (retryTimer) return; // 已有一次待发送，避免叠加
			if (key) {
				var sentKey = (sessionId || "") + ":" + key;
				if (autoSentKeys.has(sentKey)) return;
			}
			retryTimer = setTimeout(function () {
				retryTimer = null;
				if (!state.retryEnabled) return;
				if (state.retryCount >= CONFIG.maxRetries) {
					console.warn("[dsh-429-monitor] 连续自动发送已达上限，已关闭自动继续");
					setState({ retryEnabled: false, retryPending: false });
					saveSettings();
					return;
				}
				setState({ retryPending: true });
				sendContinue(sessionId).then(function (ok) {
					if (ok && key) {
						autoSentKeys.add((sessionId || "") + ":" + key);
						if (autoSentKeys.size > 500) autoSentKeys.clear();
					}
				}).catch(function () { setState({ retryPending: false }); });
			}, CONFIG.retryDelayMs);
		}

		function cancelRetryTimer() {
			if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
			setState({ retryPending: false });
		}

		/** 会话恢复运行（agent 有输出）时重置自动发送计数。 */
		function resetRetryCount() {
			if (state.retryCount !== 0 || state.retryPending) {
				cancelRetryTimer();
				setState({ retryCount: 0, retryPending: false });
			}
		}

		/** 切换自动继续开关（用户设定，持久化）。 */
		function toggleRetry() {
			var next = !state.retryEnabled;
			if (next) {
				setState({ retryEnabled: true, retryCount: 0, retryPending: false });
				// 若当前已有未发送的 429 停止检测，立即按新开关排程
				var latest = state.detections[0];
				if (latest) scheduleAutoContinue(latest.sessionId, latest.id);
			} else {
				cancelRetryTimer();
				setState({ retryEnabled: false });
			}
			saveSettings();
		}

		// ==================== 小窗（纯 DOM） ====================

		var popupRoot = null;
		var popupEl = null;

		function esc(text) {
			return String(text == null ? "" : text)
				.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
		}

		function fmtTime(ts) {
			try { return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }); }
			catch (e) { return ""; }
		}

		function fmtElapsed(since) {
			var s = Math.max(0, Math.floor((Date.now() - since) / 1000));
			if (s < 60) return s + "s";
			var m = Math.floor(s / 60);
			if (m < 60) return m + "m" + (s % 60) + "s";
			return Math.floor(m / 60) + "h" + (m % 60) + "m";
		}

		function truncate(text, n) {
			var s = String(text == null ? "" : text);
			return s.length > n ? s.slice(0, n) + "…" : s;
		}

		function statusLabel(status) {
			var map = {
				running: "运行中",
				idle: "空闲",
				waiting: "等待中",
				error: "报错",
				interrupted: "429 中断",
				blank: "未开始",
				unknown: "未知"
			};
			return map[status] || status || "未知";
		}

		// ==================== 主机状态同步（0.1.2：客户端快照不再含 nodes，改为读主机权威源） ====================

		/** 主机侧监控 API（独立于 webui；与 dsh-429-monitor 主机插件同源）。 */
		var HOST_API = "http://127.0.0.1:8091/api";

		/** 主机会话状态 → 本地状态映射。 */
		function mapHostState(hostState) {
			switch (hostState) {
				case "error429": return "interrupted";
				case "active": return "running";
				case "waiting-answer":
				case "waiting-approval": return "waiting";
				case "error": return "error";
				case "complete": return "idle";
				case "blank": return "blank";
				default: return "unknown";
			}
		}

		/**
		 * 从主机监控 /api/state 同步「全部会话」的聚合状态（权威源）。
		 * 0.1.2 重构后插槽组件拿不到当前会话 id（ownerProps 空、standard kit 无 sessionId），
		 * 因此小窗/徽章改为聚合模式（与 ON AIR 胶囊一致）：不再依赖当前聚焦会话。
		 */
		function syncFromHost(hostState) {
			if (!hostState || !hostState.sessions) return;
			var list = hostState.sessions || [];
			var any429 = list.some(function (s) { return s.state === "error429"; });
			var anyWait = list.some(function (s) { return s.state === "waiting-answer" || s.state === "waiting-approval"; });
			var anyAct = list.some(function (s) { return s.state === "active"; });
			var anyComplete = list.some(function (s) { return s.state === "complete"; });
			var agg = "idle";
			if (any429) agg = "interrupted";
			else if (anyWait) agg = "waiting";
			else if (anyAct) agg = "running";
			else if (anyComplete) agg = "idle";
			var hostSessions = list.map(function (s) {
				return {
					id: s.id,
					title: s.title,
					cwd: s.cwd,
					state: mapHostState(s.state),
					stateText: s.stateText,
					running: !!s.running,
					lastActivity: s.lastActivity,
					retries: s.retries || 0,
					alerts: (s.alerts || []).filter(function (a) { return a.kind === "429"; }).slice(0, 3)
				};
			});
			setState({
				status: agg,
				hostSessions: hostSessions,
				running: anyAct,
				sessionTitle: list.length > 0 ? list.length + " 个会话" : "",
				lastActivityAt: Date.now()
			});
			// 全部会话的 429 告警去重进小窗记录
			for (var i = 0; i < list.length; i++) {
				var alerts = list[i].alerts || [];
				for (var a = 0; a < alerts.length; a++) {
					var al = alerts[a];
					if (al.kind !== "429") continue;
					var dup = state.detections.some(function (d) { return d.time === al.ts && d.code === al.code; });
					if (dup) continue;
					pushDetection({ message: al.message, code: al.code, source: "host", sessionId: list[i].id, time: al.ts });
				}
			}
		}

		/** 轮询主机监控并同步（客户端权威源；失败静默）。 */
		function startHostPoller() {
			if (typeof window === "undefined" || typeof window.fetch !== "function") return;
			var poll = function () {
				window.fetch(HOST_API + "/state", { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (j) { syncFromHost(j); })
					.catch(function () { /* 主机监控离线，静默 */ });
			};
			poll();
			var t = setInterval(poll, 2500);
			if (t && typeof t.unref === "function") t.unref();
			return t;
		}

		// ==================== 消息暂存区（暂存 + 定时发送） ====================

		var STAGED_KEY = "dsh:429-monitor.staged";

		function loadStaged() {
			try {
				if (typeof window !== "undefined" && window.localStorage) {
					var raw = window.localStorage.getItem(STAGED_KEY);
					if (raw) {
						var arr = JSON.parse(raw);
						if (Array.isArray(arr)) return arr.filter(function (m) { return m && typeof m.text === "string" && m.text.trim() !== ""; });
					}
				}
			} catch (e) { /* ignore */ }
			return [];
		}
		function saveStaged() {
			try {
				if (typeof window !== "undefined" && window.localStorage) {
					window.localStorage.setItem(STAGED_KEY, JSON.stringify(state.stagedMessages));
				}
			} catch (e) { /* ignore */ }
		}
		/** 暂存一条消息（目标会话必须手动指定；delayMin 分钟后自动发送一次，0 = 立即）。 */
		function stageMessage(text, sessionId, delayMin) {
			text = String(text || "").trim();
			if (!text) return { ok: false, reason: "empty" };
			if (!sessionId) return { ok: false, reason: "no-session" };
			var d = Math.max(0, Math.floor(delayMin || 0));
			var item = {
				id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
				text: text,
				sessionId: sessionId,
				delayMin: d,
				sendAt: Date.now() + d * 60000,
				sent: false,
				sentAt: 0,
				createdAt: Date.now()
			};
			setState({ stagedMessages: [item].concat(state.stagedMessages).slice(0, 20), stagedText: "" });
			saveStaged();
			return { ok: true, id: item.id, sendAt: item.sendAt };
		}
		/** 发送一条暂存消息（只发送一次，成功后标记已发送，不自动重发）。 */
		function fireStaged(id) {
			var list = state.stagedMessages;
			for (var i = 0; i < list.length; i++) {
				if (list[i].id === id) {
					var item = list[i];
					if (item.sent) return false; // 已发送过，不再重复发
					sendText(item.sessionId, item.text).then(function (ok) {
						var next = state.stagedMessages.map(function (m) {
							if (m.id !== id) return m;
							return Object.assign({}, m, { sent: ok === true, sentAt: ok === true ? Date.now() : 0 });
						});
						setState({ stagedMessages: next, testResult: ok ? "已发送「" + truncate(item.text, 20) + "」✓" : "发送失败 ✘" });
						saveStaged();
						setTimeout(function () { if (state.testResult) setState({ testResult: null }); }, 4000);
					});
					return true;
				}
			}
			return false;
		}
		/** 删除一条暂存消息。 */
		function removeStaged(id) {
			setState({ stagedMessages: state.stagedMessages.filter(function (m) { return m.id !== id; }) });
			saveStaged();
		}
		/** 延迟定时器：每 10s 检查「到点且未发送」的暂存消息，自动发送一次（单次，不重发）。 */
		var stagedTimer = null;
		function startStagedTimer() {
			if (typeof window === "undefined" || typeof window.fetch !== "function") return; // 非浏览器环境跳过
			if (stagedTimer) clearInterval(stagedTimer);
			stagedTimer = setInterval(function () {
				var now = Date.now();
				var due = state.stagedMessages.filter(function (m) { return !m.sent && m.sendAt <= now; });
				if (due.length === 0) return;
				due.forEach(function (m) { fireStaged(m.id); });
			}, 10000);
			if (stagedTimer && typeof stagedTimer.unref === "function") stagedTimer.unref();
		}

		function ensurePopup() {
			if (popupRoot && popupEl && document.body.contains(popupRoot)) return popupEl;
			popupRoot = document.createElement("div");
			popupRoot.className = "dsh429-root";
			popupRoot.setAttribute("data-plugin", "dsh-429-monitor");
			popupRoot.innerHTML =
				"<div class=\"dsh429-popup\" data-open=\"false\" data-collapsed=\"false\">" +
					"<div class=\"dsh429-head\" data-drag=\"true\">" +
						"<span class=\"dsh429-title\">⚠️ 429 请求过频</span>" +
						"<div class=\"dsh429-head-actions\">" +
							"<button data-act=\"toggle-retry\" class=\"dsh429-btn dsh429-btn-mini\" title=\"自动继续 开/关\">♻</button>" +
							"<button data-act=\"clear\" class=\"dsh429-btn dsh429-btn-mini\" title=\"清空记录\">🗑</button>" +
							"<button data-act=\"collapse\" class=\"dsh429-btn dsh429-btn-mini\" title=\"收起/展开\">–</button>" +
							"<button data-act=\"close\" class=\"dsh429-btn dsh429-btn-mini dsh429-close\" title=\"关闭\">×</button>" +
						"</div>" +
					"</div>" +
					"<div class=\"dsh429-body\">" +
						"<div class=\"dsh429-session-row\">" +
							"<span class=\"dsh429-session-name\"></span>" +
							"<span class=\"dsh429-session-id\"></span>" +
						"</div>" +
						"<div class=\"dsh429-status-row\">" +
							"<span class=\"dsh429-status-dot\"></span>" +
							"<span class=\"dsh429-status-text\"></span>" +
							"<span class=\"dsh429-activity-text\"></span>" +
						"</div>" +
						"<ul class=\"dsh429-list\"></ul>" +
						"<div class=\"dsh429-stage\">" +
							"<div class=\"dsh429-stage-head\">" +
								"<span class=\"dsh429-stage-title\">📥 消息暂存</span>" +
								"<button data-act=\"stage-toggle\" class=\"dsh429-btn dsh429-btn-mini\" title=\"展开/收起\">▾</button>" +
							"</div>" +
							"<div class=\"dsh429-stage-body\">" +
								"<textarea class=\"dsh429-stage-input\" placeholder=\"暂存要发送的消息…\"></textarea>" +
								"<div class=\"dsh429-stage-row\">" +
									"<span class=\"dsh429-stage-label\">发送到</span>" +
									"<select class=\"dsh429-stage-session\" style=\"flex:1;min-width:0;padding:3px;border-radius:6px;border:1px solid #444;background:#1c1f27;color:#eee;font-size:11px;\"><option value=\"\">选择会话…</option></select>" +
									"<button data-act=\"stage-add\" class=\"dsh429-btn dsh429-btn-mini\" title=\"暂存消息\">＋</button>" +
								"</div>" +
								"<div class=\"dsh429-stage-row\">" +
									"<span class=\"dsh429-stage-label\">延迟(分)</span>" +
									"<input class=\"dsh429-stage-delay\" type=\"number\" min=\"0\" max=\"1440\" value=\"0\" style=\"width:56px;padding:3px;border-radius:6px;border:1px solid #444;background:#1c1f27;color:#eee\"/>" +
									"<span class=\"dsh429-stage-label\" style=\"color:#888;font-size:10px\">0=立即发送</span>" +
								"</div>" +
								"<ul class=\"dsh429-stage-list\"></ul>" +
							"</div>" +
						"</div>" +
					"</div>" +
					"<div class=\"dsh429-foot\">" +
						"<button data-act=\"continue\" class=\"dsh429-btn dsh429-btn-primary\">发送「继续」</button>" +
						"<button data-act=\"test\" class=\"dsh429-btn\" title=\"测试模式：向当前会话发送「你好」验证发送链路\">🧪 测试</button>" +
						"<span class=\"dsh429-retry-state\"></span>" +
					"</div>" +
				"</div>";
			document.body.appendChild(popupRoot);
			popupEl = popupRoot.querySelector(".dsh429-popup");
			popupRoot.addEventListener("click", onPopupClick);
			attachDrag(popupRoot);
			return popupEl;
		}

		/** 目标会话：优先第一个 429 中断的会话，其次第一个会话（聚合模式）。 */
		function targetSessionId() {
			for (var i = 0; i < state.hostSessions.length; i++) {
				if (state.hostSessions[i].state === "interrupted") return state.hostSessions[i].id;
			}
			return state.hostSessions.length > 0 ? state.hostSessions[0].id : state.sessionId;
		}

		function onPopupClick(e) {
			var btn = e.target.closest ? e.target.closest("[data-act]") : null;
			if (!btn) return;
			var act = btn.getAttribute("data-act");
			if (act === "close") setState({ popupVisible: false, collapsed: false });
			else if (act === "collapse") toggleCollapsed();
			else if (act === "clear") clearDetections();
			else if (act === "continue-row") {
				// 行内「继续」：精确发送到该 429 会话
				var rid = btn.getAttribute("data-id");
				if (!rid) return;
				setState({ retryPending: true });
				sendContinue(rid).then(function (ok) {
					setState({ retryPending: false, testResult: ok ? "已向该会话发送「继续」✓" : "发送失败 ✘" });
					setTimeout(function () { if (state.testResult) setState({ testResult: null }); }, 4000);
				}).catch(function () {
					setState({ retryPending: false, testResult: "发送失败 ✘" });
					setTimeout(function () { if (state.testResult) setState({ testResult: null }); }, 4000);
				});
			}
			else if (act === "continue") {
				// 全局「继续」：批量发送给所有 429 中断会话（多会话都响应）
				var targets = state.hostSessions.filter(function (h) { return h.state === "interrupted"; }).map(function (h) { return h.id; });
				if (targets.length === 0) {
					var t = state.hostSessions.length > 0 ? state.hostSessions[0].id : state.sessionId;
					if (t) targets = [t];
				}
				if (targets.length === 0) return;
				setState({ retryPending: true });
				var chain = Promise.resolve(true);
				targets.forEach(function (id) {
					chain = chain.then(function (prev) { return prev && sendContinue(id); });
				});
				chain.then(function (ok) {
					setState({ retryPending: false, testResult: ok ? "已向 " + targets.length + " 个 429 会话发送「继续」✓" : "发送失败 ✘" });
					setTimeout(function () { if (state.testResult) setState({ testResult: null }); }, 4000);
				}).catch(function () {
					setState({ retryPending: false, testResult: "发送失败 ✘" });
					setTimeout(function () { if (state.testResult) setState({ testResult: null }); }, 4000);
				});
			}
			else if (act === "test") {
				// 测试模式：发送「你好」验证链路（与「继续」同一路径），结果显示在 foot
				setState({ retryPending: true });
				sendTest(targetSessionId()).then(function (ok) {
					setState({ retryPending: false, testResult: ok ? "已发送「你好」✓" : "发送失败 ✘" });
					setTimeout(function () { if (state.testResult) setState({ testResult: null }); }, 4000);
				}).catch(function () {
					setState({ retryPending: false, testResult: "发送失败 ✘" });
					setTimeout(function () { if (state.testResult) setState({ testResult: null }); }, 4000);
				});
			}
			else if (act === "toggle-retry") toggleRetry();
			else if (act === "stage-toggle") {
				var stageBody = popupEl && popupEl.querySelector(".dsh429-stage-body");
				if (stageBody) {
					var open = stageBody.style.display !== "none";
					stageBody.style.display = open ? "none" : "";
					var tb = btn.querySelector ? btn : btn;
					if (tb) tb.textContent = open ? "▸" : "▾";
				}
			}
			else if (act === "stage-add") {
				var input = popupEl && popupEl.querySelector(".dsh429-stage-input");
				var sel = popupEl && popupEl.querySelector(".dsh429-stage-session");
				var delayEl = popupEl && popupEl.querySelector(".dsh429-stage-delay");
				var text = input ? input.value : "";
				var sid = sel ? sel.value : "";
				var d = delayEl ? (parseInt(delayEl.value, 10) || 0) : 0;
				if (!sid) {
					setState({ testResult: "请先选择目标会话 ✘" });
					setTimeout(function () { if (state.testResult) setState({ testResult: null }); }, 4000);
					return;
				}
				var r = stageMessage(text, sid, d);
				if (r.ok) {
					if (input) input.value = "";
					setState({ testResult: d > 0 ? "已暂存，「" + truncate(text, 16) + "」将在 " + d + " 分钟后自动发送 ✓" : "已暂存，立即发送 ✓" });
					setTimeout(function () { if (state.testResult) setState({ testResult: null }); }, 4000);
				}
			}
			else if (act === "stage-send") {
				var sid2 = btn.getAttribute("data-id");
				if (sid2) fireStaged(sid2);
			}
			else if (act === "stage-del") {
				var did = btn.getAttribute("data-id");
				if (did) removeStaged(did);
			}
		}

		function renderPopup() {
			if (!popupEl) return;
			popupEl.setAttribute("data-open", state.popupVisible ? "true" : "false");
			popupEl.setAttribute("data-collapsed", state.collapsed ? "true" : "false");

			var name = popupEl.querySelector(".dsh429-session-name");
			var sidEl = popupEl.querySelector(".dsh429-session-id");
			var titleEl = popupEl.querySelector(".dsh429-title");
			var dot = popupEl.querySelector(".dsh429-status-dot");
			var stext = popupEl.querySelector(".dsh429-status-text");
			var atext = popupEl.querySelector(".dsh429-activity-text");
			if (titleEl) {
				// 标题随聚合状态动态变化：仅在真正 429 中断时显示 429，其余用中性标题
				var t = state.status === "interrupted" ? "⚠️ 429 中断"
					: state.status === "waiting" ? "⏳ 等待中"
					: state.status === "running" ? "🎙 会话活动中"
					: "🐙 会话监控";
				titleEl.textContent = t;
				titleEl.setAttribute("data-status", state.status);
			}
			if (name) name.textContent = state.sessionTitle ? truncate(state.sessionTitle, 40) : (state.hostSessions.length > 0 ? state.hostSessions.length + " 个会话" : "当前会话");
			if (sidEl) sidEl.textContent = state.sessionId ? "#" + String(state.sessionId).slice(0, 8) : "";
			if (dot) dot.setAttribute("data-status", state.status);
			if (stext) stext.textContent = statusLabel(state.status);
			if (atext) {
				if (state.status === "running" && state.runningSince) atext.textContent = "已持续 " + fmtElapsed(state.runningSince);
				else if (state.lastActivityAt) atext.textContent = "最后活动 " + fmtTime(state.lastActivityAt);
				else atext.textContent = "";
			}

			var list = popupEl.querySelector(".dsh429-list");
			if (list) {
				var hosts = state.hostSessions || [];
				if (hosts.length === 0) {
					list.innerHTML = "<li class=\"dsh429-empty\">暂无会话（主机监控离线或无活动会话）</li>";
				} else {
					var items = [];
					for (var i = 0; i < hosts.length; i++) {
						var hs = hosts[i];
						var cwdShort = hs.cwd ? hs.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2).join("\\") : "";
						var t = (hs.title || "会话") + (cwdShort ? " - " + cwdShort : "");
						var is429 = hs.state === "interrupted";
						items.push(
							"<li class=\"dsh429-item" + (is429 ? " dsh429-item-alert" : "") + "\" title=\"" + esc(hs.id) + "\">" +
								"<span class=\"dsh429-item-code\">" + esc(hs.stateText || hs.state) + "</span>" +
								"<span class=\"dsh429-item-msg\">" + esc(truncate(t, 46)) + "</span>" +
								(hs.alerts && hs.alerts.length > 0 ? "<span class=\"dsh429-item-time\">429×" + hs.alerts.length + "</span>" : "") +
								(is429 ? "<button class=\"dsh429-btn dsh429-btn-mini\" data-act=\"continue-row\" data-id=\"" + esc(hs.id) + "\" title=\"向该会话发送「继续」\">继续</button>" : "") +
							"</li>"
						);
					}
					list.innerHTML = items.join("");
				}
			}

			// 消息暂存列表
			var sList = popupEl.querySelector(".dsh429-stage-list");
			if (sList) {
				var sms = state.stagedMessages || [];
				// 填充目标会话下拉（保留当前选择）
				var sel = popupEl.querySelector(".dsh429-stage-session");
				if (sel) {
					var cur = sel.value;
					var opts = ["<option value=\"\">选择会话…</option>"];
					for (var oi = 0; oi < state.hostSessions.length; oi++) {
						var hs = state.hostSessions[oi];
						var nm = (hs.title || hs.id || "会话") + " · " + (hs.stateText || hs.state || "");
						opts.push("<option value=\"" + esc(hs.id) + "\">" + esc(truncate(nm, 26)) + "</option>");
					}
					sel.innerHTML = opts.join("");
					if (cur) sel.value = cur; // 保持用户已选
				}
				if (sms.length === 0) {
					sList.innerHTML = "<li class=\"dsh429-stage-empty\">暂无暂存消息</li>";
				} else {
					var now = Date.now();
					var rows = [];
					for (var si = 0; si < sms.length; si++) {
						var m = sms[si];
						// 目标会话短名
						var tName = m.sessionId || "";
						for (var ti = 0; ti < state.hostSessions.length; ti++) {
							if (state.hostSessions[ti].id === m.sessionId) { tName = state.hostSessions[ti].title || m.sessionId; break; }
						}
						var metaText;
						if (m.sent) metaText = "已发送";
						else if (m.sendAt > now) {
							var secs = Math.ceil((m.sendAt - now) / 1000);
							metaText = secs >= 60 ? (Math.ceil(secs / 60) + " 分后自动发送") : (secs + " 秒后自动发送");
						} else metaText = "待发送";
						rows.push(
							"<li class=\"dsh429-stage-item\" title=\"" + esc(m.text) + " → " + esc(m.sessionId) + "\">" +
								"<span class=\"dsh429-stage-text\">" + esc(truncate(m.text, 26)) + "</span>" +
								"<span class=\"dsh429-stage-meta\" style=\"color:" + (m.sent ? "#7cc87c" : "#ffc860") + "\">" + metaText + " · " + esc(truncate(tName, 12)) + "</span>" +
								(m.sent ? "" : "<button class=\"dsh429-btn dsh429-btn-mini\" data-act=\"stage-send\" data-id=\"" + esc(m.id) + "\" title=\"立即发送\">▶</button>") +
								"<button class=\"dsh429-btn dsh429-btn-mini\" data-act=\"stage-del\" data-id=\"" + esc(m.id) + "\" title=\"删除\">✕</button>" +
							"</li>"
						);
					}
					sList.innerHTML = rows.join("");
				}
			}

			var rs = popupEl.querySelector(".dsh429-retry-state");
			if (rs) {
				rs.textContent = state.testResult || (state.retryEnabled
					? "自动继续开（" + state.retryCount + "/" + CONFIG.maxRetries + (state.retryPending ? " · 等待发送" : "") + "）"
					: "自动继续关（默认只提醒）");
			}

			var cont = popupEl.querySelector("[data-act=\"continue\"]");
			if (cont) cont.disabled = state.retryPending;
			var tst = popupEl.querySelector("[data-act=\"test\"]");
			if (tst) tst.disabled = state.retryPending;
		}

		function attachDrag(root) {
			var head = root.querySelector(".dsh429-head");
			if (!head) return;
			var dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
			head.addEventListener("pointerdown", function (e) {
				if (e.target.closest && e.target.closest("button")) return;
				dragging = true;
				var rect = root.getBoundingClientRect();
				startX = e.clientX; startY = e.clientY;
				origX = rect.left; origY = rect.top;
				if (head.setPointerCapture) head.setPointerCapture(e.pointerId);
				if (e.preventDefault) e.preventDefault();
			});
			head.addEventListener("pointermove", function (e) {
				if (!dragging) return;
				var dx = e.clientX - startX;
				var dy = e.clientY - startY;
				root.style.left = Math.max(0, Math.min(window.innerWidth - 60, origX + dx)) + "px";
				root.style.top = Math.max(0, Math.min(window.innerHeight - 40, origY + dy)) + "px";
				root.style.right = "auto";
				root.style.bottom = "auto";
			});
			head.addEventListener("pointerup", function () { dragging = false; });
			head.addEventListener("pointercancel", function () { dragging = false; });
		}

		function destroyPopup() {
			cancelRetryTimer();
			if (popupRoot && popupRoot.parentNode) popupRoot.parentNode.removeChild(popupRoot);
			popupRoot = null;
			popupEl = null;
		}

		// ==================== 状态徽章组件 ====================

		/** 每会话去重集合（切换会话时清空；按 node seq 去重，只提醒新错误）。 */
		var seenSession = null;
		var seenSet = new Set();

		/**
		 * 输入栏状态徽章组件。0.1.2 重构后插槽拿不到当前会话 id，
		 * 改为「主机权威 + 全部会话聚合」模式（与 ON AIR 胶囊一致）：
		 * 状态 = 主机监控全部会话的聚合（429 > 等待 > 运行 > 完成 > 空闲）。
		 */
		function StatusBadge(props) {
			var inputActions = props.inputActions;
			var conversation = props.conversation;
			var s = react.useSyncExternalStore(subscribe, getState, getState);

			// 记录当前座位（发送兜底路径；不再依赖 session/sessionId）
			react.useEffect(function () {
				currentSeat = { conversation: conversation, inputActions: inputActions };
				return function () {
					if (currentSeat && currentSeat.inputActions === inputActions) currentSeat = null;
				};
			}, [conversation, inputActions]);

			var sessionCount = s.hostSessions.length;
			var alertCount = s.detections.length;
			var label = statusLabel(s.status);
			var countText = "";
			if (sessionCount > 0) countText = sessionCount + " 会话";
			if (alertCount > 0) countText = countText ? countText + " · " + alertCount + " 次 429" : alertCount + " 次 429";
			var badgeTitle = "🐙 " + (s.sessionTitle || "会话监控") + " · " + label
				+ (countText ? " · " + countText : "")
				+ "（点击查看）";
			var h = react.createElement;
			return h(
				"div",
				{
					className: "dsh429-badge",
					"data-status": s.status,
					"data-alert": alertCount > 0 ? "true" : "false",
					onClick: function () { togglePopup(); },
					title: badgeTitle
				},
				h("span", { className: "dsh429-badge-dot" }),
				h("span", { className: "dsh429-badge-label" }, label),
				countText ? h("span", { className: "dsh429-badge-activity" }, countText) : null,
				alertCount > 0 ? h("span", { className: "dsh429-badge-count" }, "429×" + alertCount) : null,
				s.retryEnabled ? h("span", { className: "dsh429-badge-retry", title: "自动继续已开启" }, "♻") : null
			);
		}

		// ==================== 设置页面板（settings.section） ====================

		/** 主机侧监控 API（独立于 webui；与 dsh-429-monitor 主机插件同源）。 */
		var MONITOR_API = "http://127.0.0.1:8091/api";

		/**
		 * dsh 设置页「会话监控」面板：控制主机侧监控（:8091）的开关与状态展示。
		 */
		function SettingsSection() {
			var pair = react.useState(null);
			var data = pair[0];
			var setData = pair[1];
			react.useEffect(function () {
				var alive = true;
				var load = function () {
					Promise.all([
						window.fetch(MONITOR_API + "/settings").then(function (r) { return r.json(); }).catch(function () { return null; }),
						window.fetch(MONITOR_API + "/state").then(function (r) { return r.json(); }).catch(function () { return null; })
					]).then(function (r) {
						if (alive) setData({ settings: r[0] && r[0].settings, state: r[1] });
					});
				};
				load();
				var t = setInterval(load, 3000);
				return function () { alive = false; clearInterval(t); };
			}, []);
			var post = function (patch) {
				window.fetch(MONITOR_API + "/settings", {
					method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch)
				}).then(function () { }).catch(function () { });
			};
			var s = data && data.settings;
			var st = data && data.state;
			var online = st !== null;
			var n = st && st.total ? st.total : 0;
			var h = react.createElement;
			var toggle = function (key, label, desc, on) {
				return h("label", { key: key, style: { display: "flex", alignItems: "center", gap: "10px", margin: "8px 0", cursor: "pointer" } },
					h("input", { type: "checkbox", checked: on, onChange: function (e) { var p = {}; p[key] = e.target.checked; post(p); }, style: { accentColor: "#ff5050", width: "16px", height: "16px" } }),
					h("span", null,
						h("span", { style: { display: "block", fontWeight: 600 } }, label),
						h("span", { style: { display: "block", color: "#888", fontSize: "12px" } }, desc)
					)
				);
			};
			return h("div", { style: { padding: "4px 2px 12px", fontSize: "13px" } },
				h("div", { style: { marginBottom: "8px" } },
					h("span", { style: { fontWeight: 700 } }, "🐙 DSH 会话监控"),
					h("span", { style: { color: online ? "#50c850" : "#ff5050", marginLeft: "8px", fontSize: "12px" } },
						online ? "在线 · " + n + " 个活动会话" : "主机监控离线")
				),
				toggle("monitoring", "会话监控", "监听全部会话的活动 / 429 状态", s ? s.monitoring !== false : true),
				toggle("autoRetry", "自动继续", "429 停止后自动发送「继续」（上限见下）", s ? s.autoRetry === true : false),
				toggle("desktopDisplay", "ON AIR 桌面显示", "启动 / 关闭演播室 ON AIR 桌面件", s ? s.desktopDisplay !== false : true),
				h("div", { key: "maxretries", style: { display: "flex", alignItems: "center", gap: "8px", margin: "6px 0" } },
					h("span", { style: { color: "#aaa", flex: "0 0 96px" } }, "自动继续上限"),
					h("input", { type: "number", min: 1, max: 10, defaultValue: (s && s.maxRetries) || 3, onBlur: function (e) { var v = parseInt(e.target.value, 10) || 3; post({ maxRetries: Math.max(1, Math.min(10, v)) }); }, style: { width: "64px", padding: "4px" } })
				),
				h("div", { key: "tokenplan", style: { display: "flex", alignItems: "center", gap: "8px", margin: "6px 0" } },
					h("span", { style: { color: "#aaa", flex: "0 0 96px" } }, "额度用尽重试(分)"),
					h("input", { type: "number", min: 1, max: 1440, defaultValue: Math.round(((s && s.tokenPlanRetryMs) || 3600000) / 60000), onBlur: function (e) { var v = parseInt(e.target.value, 10) || 60; post({ tokenPlanRetryMin: Math.max(1, Math.min(1440, v)) }); }, style: { width: "64px", padding: "4px" } }),
					h("span", { style: { color: "#888", fontSize: "11px" } }, "token plan 额度用尽时每 N 分钟重试一次")
				),
				h("div", { key: "note", style: { color: "#777", fontSize: "12px", marginTop: "8px" } },
					"数据由 dsh 主机进程提供，与 webui 是否打开无关；自动继续按会话精确路由，不会误发到其他会话。独立仪表盘：http://127.0.0.1:8091"
				)
			);
		}

		// ==================== 词表 ====================

		var NS = "dsh429";
		var zh = {
			"title": "429 请求过频",
			"running": "运行中",
			"idle": "空闲",
			"error": "报错",
			"interrupted": "429 中断",
			"blank": "未开始",
			"unknown": "未知"
		};
		var en = {
			"title": "429 Too Many Requests",
			"running": "Running",
			"idle": "Idle",
			"error": "Error",
			"interrupted": "429 Interrupted",
			"blank": "Not started",
			"unknown": "Unknown"
		};

		// ==================== 插件主体 ====================

		/** Required services: the dictionaries register through ctx.locale at apply time. */
		var inject = ["locale"];

		/**
		 * Client plugin body: register the dictionary namespace, then — once the
		 * slots service is up — contribute the status badge into the composer tool
		 * row's left list seat, waiting for ui-conversation's declaration via
		 * slots.inject. Also captures the sessions service for session-scoped
		 * auto-continue (session.prompt), and runs the popup subscription.
		 * @param {any} ctx - client cordis context.
		 */
		function apply(ctx) {
			ctx.effect(
				function () { return ctx.locale.register(NS, { zh: zh, en: en }); },
				"dsh-429-monitor: dictionaries"
			);
			ctx.inject(["slots"], function (scope) {
				scope.slots.inject("conversation.input.left", function () {
					return scope.slots.register(
						{
							name: "conversation.input.left",
							id: "dsh-429-monitor",
							order: 200,
							label: "429 Monitor",
							locale: NS
						},
						StatusBadge
					);
				});
				// 设置页「会话监控」面板（可靠：直接注册到 settings.section 插槽）
				scope.slots.inject("settings.section", function () {
					return scope.slots.register(
						{
							name: "settings.section",
							id: "dsh-429-monitor",
							order: 200,
							label: "会话监控",
							locale: NS
						},
						SettingsSection
					);
				});
			});

			// 捕获 sessions 服务：用于按会话作用域直接发送「继续」（session.prompt）
			ctx.inject(["sessions"], function (scope) {
				sessionsService = scope;
			});

			// 小窗渲染订阅（模块级单例，随 store 变化更新）
			var unsub = subscribe(function () {
				if (typeof document === "undefined") return;
				ensurePopup();
				renderPopup();
			});

			// 主机状态轮询（0.1.2 权威源；客户端快照已无 nodes，改读 :8091）
			var hostPollTimer = startHostPoller();
			// 暂存消息延迟自动发送（每 10s 检查到点未发送的消息）
			startStagedTimer();

			ctx.effect(function () {
				return function () {
					if (hostPollTimer) clearInterval(hostPollTimer);
					if (stagedTimer) clearInterval(stagedTimer);
					unsub();
					destroyPopup();
				};
			}, "dsh-429-monitor: cleanup");
		}

		// ==================== 导出 ====================

		exports.StatusBadge = StatusBadge;
		exports.SettingsSection = SettingsSection;
		exports.apply = apply;
		exports.inject = inject;
		// 纯逻辑导出，便于 Node 冒烟测试
		exports.is429Message = is429Message;
		exports.isRateLimitCode = isRateLimitCode;
		exports.deriveSessionStatus = deriveSessionStatus;
		exports.activityInfo = activityInfo;
		exports.latest429Stop = latest429Stop;
		exports.subscribe = subscribe;
		exports.getState = getState;
		exports.pushDetection = pushDetection;
		exports.clearDetections = clearDetections;
		exports.sendMessage = sendMessage;
		exports.sendToSession = sendToSession;
		exports.sendText = sendText;
		exports.sendContinue = sendContinue;
		exports.sendTest = sendTest;
		exports.togglePopup = togglePopup;
		exports.toggleCollapsed = toggleCollapsed;
		exports.toggleRetry = toggleRetry;
		exports.resetRetryCount = resetRetryCount;
		exports.stageMessage = stageMessage;
		exports.fireStaged = fireStaged;
		exports.removeStaged = removeStaged;
		// 测试钩子：仅用于冒烟测试调整定时/判定窗口（生产无副作用）。
		exports.__setRetryDelay = function (ms) { CONFIG.retryDelayMs = ms; };
		exports.__setStopWindow = function (ms) { CONFIG.stopWindowMs = ms; };
		return module.exports;
	}
});