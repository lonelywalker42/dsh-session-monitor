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
 *  - 聚合当前宿主所有会话；绑定与状态以宿主 API 为准。
 *  - 出现 429 时弹窗提醒；自动继续开关修改宿主设置，由宿主唯一执行。
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
			/** 旧偏好读取的默认值；不自动开启宿主。 */
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
			".dsh429-retry-state{color:#999;font-size:11px;margin-left:auto;}",
			"/* Compact monitor: clear hierarchy and semantic state colors. */",
			".dsh429-popup{width:400px;max-height:calc(100dvh - 48px);display:none;flex-direction:column;background:linear-gradient(145deg,rgba(41,51,80,.86),rgba(17,25,44,.91));backdrop-filter:blur(28px) saturate(145%);-webkit-backdrop-filter:blur(28px) saturate(145%);border:1px solid #bed3ff3b;border-radius:20px;color:#e7edf6;box-shadow:0 24px 64px #050a2059,inset 0 1px 0 #ffffff1f;}",
			".dsh429-popup[data-open=true]{display:flex;}.dsh429-head{padding:14px 16px;background:linear-gradient(110deg,#8eb8ff0f,#c4a4ff0d);border-color:#b8ccff1a;gap:12px;}.dsh429-title{color:#e7edf6;font-size:14px;}.dsh429-head-actions{gap:6px;}",
			".dsh429-btn{min-height:32px;border-color:#354156;background:#242e3e;border-radius:8px;color:#dce5f3;transition:background .15s,border-color .15s;}.dsh429-btn:hover{background:#303e54;border-color:#627ca4;}.dsh429-btn-mini{width:28px;height:28px;min-height:28px;flex-shrink:0;}.dsh429-btn[data-act=continue-row]{width:auto;padding:0 8px;}",
			".dsh429-body{padding:16px;overflow-y:auto;min-height:0;}.dsh429-session-row{margin-bottom:8px;}.dsh429-session-name{font-size:14px;}.dsh429-status-row{margin-bottom:14px;font-size:12px;}.dsh429-activity-text{color:#9aa8bd;}",
			".dsh429-list{display:flex;flex-direction:column;gap:8px;max-height:240px;}.dsh429-item{align-items:center;gap:10px;padding:12px;border:1px solid #b8ccff17;background:linear-gradient(115deg,#b3ccff0d,#ffffff04);border-radius:12px;}.dsh429-item-alert{background:#fb718514;border-color:#fb71854d;}.dsh429-item-content{flex:1;min-width:0;}.dsh429-item-msg{display:block;color:#e7edf6;font-size:12px;}.dsh429-item-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#94a3b8;font-size:11px;margin-top:3px;}",
			".dsh429-item-code{font-size:10px;padding:3px 6px;border-radius:6px;color:#aab8cd;background:#2b3546;}.dsh429-item[data-status=running] .dsh429-item-code{color:#6ee7b7;background:#183c35;}.dsh429-item[data-status=waiting] .dsh429-item-code{color:#93c5fd;background:#243954;}.dsh429-item[data-status=idle] .dsh429-item-code{color:#a7d6b9;background:#253b32;}.dsh429-item[data-status=interrupted] .dsh429-item-code,.dsh429-item[data-status=error] .dsh429-item-code{color:#fda4af;background:#532d38;}",
			".dsh429-stage{margin-top:16px;padding:14px 0 0;border-color:#303949;}.dsh429-stage-title{font-size:12px;color:#c8d6ee;}.dsh429-stage-body{padding-top:10px;}.dsh429-stage-input{min-height:76px;padding:10px;background:#111722;border-color:#354156;border-radius:10px;line-height:1.6;font-size:12px;}.dsh429-stage-input::placeholder{color:#8492a8;}.dsh429-stage-row{gap:8px;margin:10px 0;}.dsh429-stage-label{color:#a7b4c8;font-size:11px;}",
			".dsh429-stage-session,.dsh429-stage-delay{min-height:32px;font-family:inherit;}.dsh429-stage-empty,.dsh429-empty{padding:12px;text-align:center;color:#93a2b8;font-size:11px;}.dsh429-stage-item{padding:8px 0;}.dsh429-foot{padding:12px 16px;gap:8px;flex-wrap:wrap;background:#19202c;border-color:#303949;}.dsh429-btn-primary{background:#537fe7;border-color:#6a92ed;}.dsh429-btn-primary:hover{background:#638cf0;}.dsh429-retry-state{flex-basis:100%;margin:2px 0 0;color:#9aa8bd;line-height:1.5;overflow-wrap:anywhere;}",
			".dsh429-popup button:focus-visible,.dsh429-popup input:focus-visible,.dsh429-popup select:focus-visible,.dsh429-popup textarea:focus-visible{outline:2px solid #83afff;outline-offset:2px;}.dsh429-popup :disabled{opacity:.5;cursor:not-allowed;}.dsh429-popup *{scrollbar-width:thin;scrollbar-color:#43516a transparent;}",
			".dsh429-popup .dsh429-btn{background:#c3d5ff0b;border-color:#c3d5ff24;}.dsh429-popup .dsh429-btn:hover{background:#c3d5ff1c;}.dsh429-popup .dsh429-btn-primary{background:linear-gradient(120deg,#7598f1,#9384e9);border-color:#b4c6ff4d;color:#fff;box-shadow:0 4px 14px #8095ff26;}.dsh429-foot{background:#0b122b33;border-color:#b8ccff1a;}.dsh429-stage{border-color:#b8ccff1a;}.dsh429-stage-input,.dsh429-stage-session,.dsh429-stage-delay{background:#101a3080!important;border-color:#b8ccff29!important;border-radius:9px!important;color:#e7edf6!important;}.dsh429-stage-session option{background:#1b263f;}.dsh429-stage-empty{border:1px dashed #b8ccff26;border-radius:9px;margin-top:8px;}.dsh429-popup[data-status=interrupted]{border-color:#fb71855c;}.dsh429-popup[data-status=waiting] .dsh429-head{background:#93c5fd0d;}.dsh429-popup[data-status=running] .dsh429-head{background:#6ee7b70a;}.dsh429-status-dot[data-status=running]{background:#6ee7b7;}",
			".dsh429-connection{padding:9px 18px;font-size:11px;color:#93c5fd;background:#93c5fd0b;border-bottom:1px solid #ffffff0d;}.dsh429-item[data-status=complete] .dsh429-item-code{color:#c4b5fd;background:#c4b5fd15;}.dsh429-title[data-status=complete]{color:#c4b5fd;}.dsh429-stage-hint{font-size:11px;line-height:1.6;color:#aab8d2;}button:disabled{opacity:.45;cursor:not-allowed;}",
			".dsh429-eyebrow{display:block;font-size:9px;letter-spacing:2px;color:#a3b8e4;margin-bottom:4px;}.dsh429-title[data-status=running]{color:#6ee7b7;}.dsh429-item[data-status=idle] .dsh429-item-code{color:#c4b5fd;background:#c4b5fd15;}.dsh429-head,.dsh429-foot{flex-shrink:0;}.dsh429-stage-input{display:block;}.dsh429-item-code{flex-shrink:0;}.dsh429-btn[data-act=toggle-retry][aria-pressed=true]{color:#bdd0ff;background:#7598f126;}",
			"@supports not (backdrop-filter:blur(1px)){.dsh429-popup{background:#1c263d;}}@media(prefers-reduced-transparency:reduce){.dsh429-popup{background:#1c263d;backdrop-filter:none;}}",
			"@media(max-width:440px){.dsh429-root{right:12px;bottom:12px;}.dsh429-popup{max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);}.dsh429-body{padding:12px;}.dsh429-head{padding:12px;}.dsh429-item{gap:6px;padding:8px;}}@media(prefers-reduced-motion:reduce){.dsh429-popup *,.dsh429-badge,.dsh429-badge-dot{animation:none!important;transition:none!important;}}"
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
			connection: "unbound",
			connectionError: "",
			lastSyncAt: 0,
			instanceId: null,
			profile: "",
			settings: null,
			settingsPending: false,
			legacyRetryEnabled: loadSettings().autoRetry,
			legacyStaged: [],
			stagedMessages: [],
			stagedText: "",
			stagedSessionId: "",
			stagedDelayMin: 0,              // 延迟发送（分钟；0 = 立即）
			retryEnabled: false,
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
			var signature = (info.sessionId || "") + "|" + source + "|" + code + "|" + message;
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

			// Automatic continuation belongs exclusively to the host.
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
		/** 模块级 sessions 服务引用（apply 时通过 ctx.inject 捕获；用于按会话作用域直接发送）。 */

		/**
		 * 按会话作用域直接发送文本（最可靠的无手动介入路径）。
		 * 通过 ctx.sessions.binding(sessionId).session.prompt([{type:"text",text}], "queue")
		 * 发送——与 conversation.send 内部完全一致，不依赖输入框/合成器状态。
		 * @param {string|null} sessionId - 目标会话 id。
		 * @param {string} text - 要发送的文本。
		 * @returns {Promise<boolean>}
		 */
		function sendToSession(sessionId, text) { return sendText(sessionId, text); }
		function sendMessage(seat, text) { return sendText(seat && seat.sessionId, text); }

		function newRequestId() {
			return typeof window !== "undefined" && window.crypto && window.crypto.randomUUID
				? window.crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2);
		}
		function canSend() {
			var binding = monitorBinding();
			return !!(binding && state.connection === "online" && state.instanceId === binding.id && Date.now() - state.lastSyncAt < 7500);
		}
		function sendText(sessionId, text, requestId) {
			if (!canSend() || !sessionId || !state.hostSessions.some(function (s) { return s.id === sessionId; })) return Promise.resolve(false);
			text = String(text || "").trim();
			if (!text) return Promise.resolve(false);
			var binding = monitorBinding();
			return window.fetch(binding.api + "/session/" + encodeURIComponent(sessionId) + "/continue", {
				method: "POST", headers: { "Content-Type": "application/json", "X-DSH-Monitor-Instance": binding.id },
				body: JSON.stringify({ text: text, requestId: requestId || newRequestId() })
			}).then(function (r) { return r.json().then(function (j) { return r.ok && sameBinding(binding, monitorBinding()) && matchesInstance(j.instance, binding) && j.ok === true && j.status === "sent"; }); })
				.catch(function () { return false; });
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

		function resetRetryCount() { /* counters are owned by the host */ }
		function toggleRetry() { return postSettings({ autoRetry: !state.retryEnabled }); }

		function postSettings(patch) {
			if (!canSend() || state.settingsPending) return Promise.resolve(false);
			var binding = monitorBinding();
			setState({ settingsPending: true });
			return window.fetch(binding.api + "/settings", {
				method: "POST", headers: { "Content-Type": "application/json", "X-DSH-Monitor-Instance": binding.id }, body: JSON.stringify(patch)
			}).then(function (r) { return r.json().then(function (j) {
				if (!r.ok || !j.ok || !matchesInstance(j.instance, binding)) throw new Error("设置未保存");
				if (!sameBinding(binding, monitorBinding())) return false;
				setState({ settings: j.settings, retryEnabled: j.settings.autoRetry === true, legacyRetryEnabled: false });
				if (Object.prototype.hasOwnProperty.call(patch, "autoRetry")) {
					try { if (window.localStorage) window.localStorage.setItem(SETTINGS_KEY + ":migration:" + binding.id, "acknowledged"); } catch (e) { /* retain original preference */ }
				}
				return true;
			}); }).catch(function (e) { setState({ testResult: "设置保存失败：" + e.message }); return false; })
				.finally(function () { setState({ settingsPending: false }); });
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
				complete: "工作完成",
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
		function monitorBinding() {
			var b = typeof window !== "undefined" && window.__DSH_MONITOR_BINDING__;
			return b && typeof b.api === "string" && b.api && typeof b.id === "string" && b.id && typeof b.profile === "string"
				? { api: b.api.replace(/\/$/, ""), id: b.id, profile: b.profile } : null;
		}
		function monitorApi() { var b = monitorBinding(); return b ? b.api : ""; }
		function sameBinding(a, b) { return !!(a && b && a.id === b.id && a.api === b.api && a.profile === b.profile); }
		function matchesInstance(instance, binding) { return !!(binding && instance && instance.id === binding.id && instance.profile === binding.profile); }
		function connectionLabel(connection) {
			return { unbound: "未绑定宿主", connecting: "正在连接", online: "在线", stale: "数据过期 · 正在重试", offline: "宿主离线" }[connection] || "未连接";
		}
		function mapHostState(hostState) {
			return { error429: "interrupted", active: "running", "waiting-answer": "waiting", "waiting-approval": "waiting",
				error: "error", complete: "complete", idle: "idle", blank: "blank" }[hostState] || "unknown";
		}
		var detectionKeys = new Set();
		function syncFromHost(hostState, binding) {
			binding = binding || monitorBinding();
			if (!sameBinding(binding, monitorBinding())) return false;
			if (!matchesInstance(hostState && hostState.instance, binding) || !Array.isArray(hostState.sessions)) {
				setState({ connection: "unbound", connectionError: "宿主身份不匹配，请重新加载页面", settings: null, retryEnabled: false });
				return false;
			}
			if (state.instanceId !== binding.id) {
				detectionKeys.clear();
				var acknowledged = false;
				try { acknowledged = !!(window.localStorage && window.localStorage.getItem(SETTINGS_KEY + ":migration:" + binding.id)); } catch (e) { /* ignore */ }
				setState({ instanceId: binding.id, profile: binding.profile, detections: [], stagedMessages: loadStaged(binding.id), legacyStaged: loadLegacyStaged(), legacyRetryEnabled: loadSettings().autoRetry && !acknowledged });
			}
			var list = hostState.sessions;
			var any429 = list.some(function (s) { return s.state === "error429"; });
			var anyError = list.some(function (s) { return s.state === "error"; });
			var anyWait = list.some(function (s) { return s.state === "waiting-answer" || s.state === "waiting-approval"; });
			var anyAct = list.some(function (s) { return s.state === "active"; });
			var anyComplete = list.some(function (s) { return s.state === "complete"; });
			var aggregate = any429 ? "interrupted" : anyError ? "error" : anyWait ? "waiting" : anyAct ? "running" : anyComplete ? "complete" : "idle";
			var hosts = list.map(function (s) {
				return { id: s.id, title: s.title, cwd: s.cwd, state: mapHostState(s.state), stateText: s.stateText, running: !!s.running,
					lastActivity: Number(s.lastActivity) || 0, activeSince: Number(s.activeSince) || 0, retries: s.retries || 0,
					alerts: (s.alerts || []).filter(function (a) { return a.kind === "429"; }).slice(0, 3) };
			});
			for (var i = 0; i < list.length; i++) {
				if (list[i].state !== "error429") continue; // historical alerts are not current interruptions
				var alert = (list[i].alerts || []).filter(function (a) { return a.kind === "429"; })[0];
				if (!alert) continue;
				var key = binding.id + ":" + list[i].id + ":" + alert.ts + ":" + alert.code;
				if (!detectionKeys.has(key)) {
					detectionKeys.add(key);
					pushDetection({ message: alert.message, code: alert.code, source: "host", sessionId: list[i].id, time: alert.ts });
				}
			}
			var activeTimes = hosts.filter(function (s) { return s.state === "running" && s.activeSince; }).map(function (s) { return s.activeSince; });
			setState({
				status: aggregate, hostSessions: hosts, running: anyAct, runningSince: activeTimes.length ? Math.min.apply(Math, activeTimes) : 0,
				sessionTitle: list.length ? list.length + " 个会话" : "", lastActivityAt: hosts.reduce(function (latest, s) { return Math.max(latest, s.lastActivity); }, 0),
				connection: "online", connectionError: "", lastSyncAt: Date.now(), settings: hostState.settings || {},
				retryEnabled: !!(hostState.settings && hostState.settings.autoRetry),
				retryCount: hosts.reduce(function (total, s) { return total + s.retries; }, 0)
			});
			reconcileStagedReceipts();
			return true;
		}
		var pollInFlight = null;
		var pollStopped = false;
		function pollHost() {
			var binding = monitorBinding();
			if (!binding) { setState({ connection: "unbound", connectionError: "请从已加载监控插件的 DSH 页面打开", retryEnabled: false }); return Promise.resolve(false); }
			if (pollInFlight && sameBinding(pollInFlight.binding, binding)) {
				if (state.lastSyncAt && Date.now() - state.lastSyncAt >= 7500) setState({ connection: "stale" });
				return pollInFlight.promise;
			}
			if (state.connection === "unbound") setState({ connection: "connecting", connectionError: "" });
			var controller = typeof AbortController === "function" ? new AbortController() : null;
			var timeout = setTimeout(function () { if (controller) controller.abort(); }, 7000);
			if (timeout && timeout.unref) timeout.unref();
			var operation = { binding: binding };
			operation.promise = window.fetch(binding.api + "/state", { cache: "no-store", signal: controller ? controller.signal : undefined })
				.then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
				.then(function (j) { return !pollStopped && syncFromHost(j, binding); })
				.catch(function (e) {
					if (!pollStopped && sameBinding(binding, monitorBinding())) setState({ connection: state.lastSyncAt && Date.now() - state.lastSyncAt < 7500 ? "stale" : "offline", connectionError: e.message });
					return false;
				}).finally(function () { clearTimeout(timeout); if (pollInFlight === operation) pollInFlight = null; });
			pollInFlight = operation;
			return operation.promise;
		}
		function startHostPoller() {
			if (typeof window === "undefined" || typeof window.fetch !== "function") return;
			pollStopped = false;
			pollHost();
			var timer = setInterval(pollHost, 2500);
			if (timer && timer.unref) timer.unref();
			return timer;
		}

		// ==================== 消息暂存区（暂存 + 定时发送） ====================

		var STAGED_KEY = "dsh:429-monitor.staged";
		function readStored(key) {
			try { var value = window.localStorage && window.localStorage.getItem(key); return value ? JSON.parse(value) : []; } catch (e) { return []; }
		}
		function loadLegacyStaged() {
			var items = readStored(STAGED_KEY);
			return Array.isArray(items) ? items.filter(function (m) { return m && !m.sent && typeof m.text === "string"; }) : [];
		}
		function loadStaged(instanceId) {
			var items = readStored(STAGED_KEY + ":" + instanceId);
			return Array.isArray(items) ? items.filter(function (m) { return m && m.instanceId === instanceId && typeof m.text === "string"; }) : [];
		}
		function saveStaged() {
			if (!state.instanceId) return;
			try {
				if (window.localStorage) window.localStorage.setItem(STAGED_KEY + ":" + state.instanceId, JSON.stringify(state.stagedMessages));
			} catch (e) { setState({ testResult: "消息队列无法保存，请检查浏览器存储空间" }); }
		}
		function stageMessage(text, sessionId, delayMin) {
			text = String(text || "").trim();
			if (!text) return { ok: false, reason: "empty" };
			if (!canSend()) return { ok: false, reason: "host-unavailable" };
			if (!sessionId || !state.hostSessions.some(function (s) { return s.id === sessionId; })) return { ok: false, reason: "no-session" };
			var d = Math.max(0, Math.min(1440, Math.floor(Number(delayMin) || 0)));
			var item = { id: newRequestId(), instanceId: state.instanceId, text: text, sessionId: sessionId, delayMin: d,
				sendAt: Date.now() + d * 60000, status: "pending", sent: false, sentAt: 0, error: "", createdAt: Date.now() };
			item.requestId = item.id;
			setState({ stagedMessages: [item].concat(state.stagedMessages).slice(0, 20), stagedText: "" });
			saveStaged();
			return { ok: true, id: item.id, sendAt: item.sendAt };
		}
		function updateStaged(id, patch) {
			setState({ stagedMessages: state.stagedMessages.map(function (m) { return m.id === id ? Object.assign({}, m, patch) : m; }) });
			saveStaged();
		}
		var receiptChecks = new Set();
		function checkReceipt(item) {
			var binding = monitorBinding();
			if (!canSend() || item.instanceId !== binding.id || receiptChecks.has(item.id)) return Promise.resolve(false);
			receiptChecks.add(item.id);
			return window.fetch(binding.api + "/delivery/" + encodeURIComponent(item.requestId), { cache: "no-store" })
				.then(function (r) { return r.json().then(function (receipt) {
					if (!sameBinding(binding, monitorBinding()) || !matchesInstance(receipt.instance, binding)) return false;
					var current = state.stagedMessages.filter(function (m) { return m.id === item.id; })[0];
					if (!current || current.status !== "sending" || current.requestId !== item.requestId) return false;
					if (!receipt.ok) {
						updateStaged(item.id, { status: "unknown", error: "回执不可用，请核实发送结果后再决定是否重发" });
						return false;
					}
					if (receipt.sessionId !== item.sessionId) return false;
					if (receipt.status === "sent") updateStaged(item.id, { status: "sent", sent: true, sentAt: Date.now(), error: "" });
					if (receipt.status === "failed") updateStaged(item.id, { status: "failed", error: receipt.reason || "发送失败" });
					return receipt.status === "sent";
				}); }).catch(function () { return false; }).finally(function () { receiptChecks.delete(item.id); });
		}
		function reconcileStagedReceipts() {
			state.stagedMessages.filter(function (m) { return m.status === "sending"; }).forEach(checkReceipt);
		}
		function fireStaged(id, retry) {
			var item = state.stagedMessages.filter(function (m) { return m.id === id; })[0];
			if (!item || !canSend() || item.instanceId !== state.instanceId || item.status === "sent" || item.status === "sending") return Promise.resolve(false);
			if (item.status !== "pending" && retry !== true) return Promise.resolve(false);
			if (!state.hostSessions.some(function (s) { return s.id === item.sessionId; })) {
				updateStaged(id, { status: "failed", error: "目标会话已移除，请重新选择会话" }); return Promise.resolve(false);
			}
			var requestId = retry ? newRequestId() : item.requestId;
			updateStaged(id, { status: "sending", requestId: requestId, error: "" });
			var binding = monitorBinding();
			return window.fetch(binding.api + "/session/" + encodeURIComponent(item.sessionId) + "/continue", {
				method: "POST", headers: { "Content-Type": "application/json", "X-DSH-Monitor-Instance": binding.id },
				body: JSON.stringify({ text: item.text, requestId: requestId })
			}).then(function (r) { return r.json().then(function (result) {
				if (!sameBinding(binding, monitorBinding()) || !matchesInstance(result.instance, binding)) { updateStaged(id, { status: "unknown", error: "宿主身份变化，请核实结果" }); return false; }
				if (r.ok && result.ok && result.status === "sent" && matchesInstance(result.instance, binding)) {
					updateStaged(id, { status: "sent", sent: true, sentAt: Date.now(), error: "" });
					setState({ testResult: "消息已发送 ✓" }); return true;
				}
				updateStaged(id, { status: "failed", error: result.reason || "发送失败，请手动重试" });
				return false;
			}); }).catch(function () {
				// A lost response is not proof of failure. Reconcile; never resend automatically.
				var sending = state.stagedMessages.filter(function (m) { return m.id === id; })[0];
				return sending ? checkReceipt(sending) : false;
			});
		}
		function removeStaged(id) {
			var item = state.stagedMessages.filter(function (m) { return m.id === id; })[0];
			if (item && item.status === "sending") return;
			setState({ stagedMessages: state.stagedMessages.filter(function (m) { return m.id !== id; }) });
			saveStaged();
		}
		var stagedTimer = null;
		function startStagedTimer() {
			if (typeof window === "undefined" || typeof window.fetch !== "function") return;
			if (stagedTimer) clearInterval(stagedTimer);
			stagedTimer = setInterval(function () {
				if (!canSend()) return;
				state.stagedMessages.filter(function (m) { return m.status === "pending" && m.instanceId === state.instanceId && m.sendAt <= Date.now(); })
					.forEach(function (m) { fireStaged(m.id); });
			}, 1000);
			if (stagedTimer && stagedTimer.unref) stagedTimer.unref();
		}

		function ensurePopup() {
			if (popupRoot && popupEl && document.body.contains(popupRoot)) return popupEl;
			popupRoot = document.createElement("div");
			popupRoot.className = "dsh429-root";
			popupRoot.setAttribute("data-plugin", "dsh-429-monitor");
			popupRoot.innerHTML =
				"<div class=\"dsh429-popup\" data-open=\"false\" data-collapsed=\"false\">" +
					"<div class=\"dsh429-head\" data-drag=\"true\">" +
						"<div><span class=\"dsh429-eyebrow\">DSH MONITOR</span><span class=\"dsh429-title\">会话监控</span></div>" +
						"<div class=\"dsh429-head-actions\">" +
							"<button data-act=\"toggle-retry\" class=\"dsh429-btn dsh429-btn-mini\" title=\"自动继续 开/关\">♻</button>" +
							"<button data-act=\"clear\" class=\"dsh429-btn dsh429-btn-mini\" title=\"清空记录\">🗑</button>" +
							"<button data-act=\"collapse\" class=\"dsh429-btn dsh429-btn-mini\" title=\"收起/展开\">–</button>" +
							"<button data-act=\"close\" class=\"dsh429-btn dsh429-btn-mini dsh429-close\" title=\"关闭\">×</button>" +
						"</div>" +
					"</div>" +
					"<div class=\"dsh429-connection\" role=\"status\"></div>" +
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
								"<p class=\"dsh429-stage-hint\">延迟发送仅在此页面打开时运行；失败后需手动重试。</p>" +
								"<ul class=\"dsh429-stage-list\"></ul><ul class=\"dsh429-legacy-list\"></ul>" +
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
			popupEl.setAttribute("role", "region");
			popupEl.setAttribute("aria-label", "DSH 会话监控");
			Array.prototype.forEach.call(popupEl.querySelectorAll("button"), function (button) {
				button.setAttribute("aria-label", button.title || button.textContent);
			});
			popupEl.querySelector(".dsh429-stage-input").setAttribute("aria-label", "要发送的消息");
			popupEl.querySelector(".dsh429-stage-session").setAttribute("aria-label", "目标会话");
			popupEl.querySelector(".dsh429-stage-delay").setAttribute("aria-label", "延迟发送分钟数");
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
			else if (act === "stage-retry") {
				var retryId = btn.getAttribute("data-id");
				var retryItem = state.stagedMessages.filter(function (m) { return m.id === retryId; })[0];
				if (retryItem && (retryItem.status !== "unknown" || window.confirm("上次发送结果未知。请确认已核实会话内容，仍要重发这条消息？"))) fireStaged(retryId, true);
			}
			else if (act === "stage-legacy") {
				var legacyId = btn.getAttribute("data-id");
				var draft = state.legacyStaged.filter(function (m) { return String(m.id) === legacyId; })[0];
				if (draft) {
					popupEl.querySelector(".dsh429-stage-input").value = draft.text;
					popupEl.querySelector(".dsh429-stage-session").value = "";
					setState({ testResult: "已复制旧版草稿，请重新选择目标会话后暂存" });
				}
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
			popupEl.setAttribute("data-status", state.status);
			popupEl.setAttribute("data-connection", state.connection);
			var connection = popupEl.querySelector(".dsh429-connection");
			connection.textContent = (state.profile ? state.profile + " · " : "") + connectionLabel(state.connection);
			connection.title = state.connectionError || (state.lastSyncAt ? "最后同步 " + fmtTime(state.lastSyncAt) : "");
			popupEl.querySelector("[data-act=toggle-retry]").setAttribute("aria-pressed", String(state.retryEnabled));

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
					list.innerHTML = "<li class=\"dsh429-empty\">" + (state.connection === "online" ? "暂无活动会话，新的会话会自动出现在这里" : esc(connectionLabel(state.connection)) + " · 正在等待可靠数据") + "</li>";
				} else {
					var items = [];
					for (var i = 0; i < hosts.length; i++) {
						var hs = hosts[i];
						var cwdShort = hs.cwd ? hs.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2).join("\\") : "";
						var t = (hs.title || "会话") + (cwdShort ? " - " + cwdShort : "");
						var is429 = hs.state === "interrupted";
						items.push(
							"<li class=\"dsh429-item" + (is429 ? " dsh429-item-alert" : "") + "\" data-status=\"" + esc(hs.state) + "\" title=\"" + esc(t + " · " + hs.id) + "\">" +
								"<span class=\"dsh429-item-code\">" + esc(hs.stateText || hs.state) + "</span>" +
								"<span class=\"dsh429-item-content\"><span class=\"dsh429-item-msg\">" + esc(hs.title || "会话") + "</span>" + (cwdShort ? "<span class=\"dsh429-item-path\">" + esc(cwdShort) + "</span>" : "") + "</span>" +
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
						if (m.status === "sent") metaText = "已发送";
						else if (m.status === "sending") metaText = "发送中 · 等待回执";
						else if (m.status === "failed") metaText = "发送失败";
						else if (m.status === "unknown") metaText = "结果未知";
						else if (m.sendAt > now) {
							var secs = Math.ceil((m.sendAt - now) / 1000);
							metaText = secs >= 60 ? (Math.ceil(secs / 60) + " 分后自动发送") : (secs + " 秒后自动发送");
						} else metaText = "待发送";
						rows.push(
							"<li class=\"dsh429-stage-item\" title=\"" + esc(m.error || m.text) + " → " + esc(m.sessionId) + "\">" +
								"<span class=\"dsh429-stage-text\">" + esc(truncate(m.text, 26)) + "</span>" +
								"<span class=\"dsh429-stage-meta\" style=\"color:" + (m.sent ? "#7cc87c" : "#ffc860") + "\">" + metaText + " · " + esc(truncate(tName, 12)) + "</span>" +
								(m.status === "pending" ? "<button class=\"dsh429-btn dsh429-btn-mini\" data-act=\"stage-send\" data-id=\"" + esc(m.id) + "\" title=\"立即发送\">▶</button>"
									: m.status === "failed" || m.status === "unknown" ? "<button class=\"dsh429-btn\" data-act=\"stage-retry\" data-id=\"" + esc(m.id) + "\" title=\"" + esc(m.error) + "\">" + (m.status === "unknown" ? "核实后重发" : "重试") + "</button>" : "") +
								(m.status === "sending" ? "" : "<button class=\"dsh429-btn dsh429-btn-mini\" data-act=\"stage-del\" data-id=\"" + esc(m.id) + "\" title=\"删除\">✕</button>") +
							"</li>"
						);
					}
					sList.innerHTML = rows.join("");
				}
			}
			var legacyList = popupEl.querySelector(".dsh429-legacy-list");
			legacyList.innerHTML = state.legacyStaged.length ? "<li class=\"dsh429-stage-hint\">旧版草稿：复制后需重新选择目标，原始草稿仍保留。</li>" + state.legacyStaged.map(function (m) {
				return "<li class=\"dsh429-stage-item\"><span class=\"dsh429-stage-text\">" + esc(truncate(m.text, 24)) + "</span><button class=\"dsh429-btn\" data-act=\"stage-legacy\" data-id=\"" + esc(m.id) + "\">复制</button></li>";
			}).join("") : "";

			var rs = popupEl.querySelector(".dsh429-retry-state");
			if (rs) {
				rs.textContent = state.testResult || (state.retryEnabled
					? "自动继续已开启 · 宿主执行 · 每次上限 " + (state.settings.maxRetries || 3)
					: state.legacyRetryEnabled ? "旧版自动继续曾开启，请核对宿主开关" : "自动继续已关闭 · 仅提醒");
			}

			var cont = popupEl.querySelector("[data-act=\"continue\"]");
			if (cont) cont.disabled = state.retryPending || !canSend() || !state.hostSessions.length;
			var tst = popupEl.querySelector("[data-act=\"test\"]");
			if (tst) tst.disabled = state.retryPending || !canSend() || !state.hostSessions.length;
			Array.prototype.forEach.call(popupEl.querySelectorAll("[data-act=continue-row],[data-act=stage-add],[data-act=stage-send],[data-act=stage-retry]"), function (button) { button.disabled = !canSend(); });
			popupEl.querySelector("[data-act=toggle-retry]").disabled = !canSend() || state.settingsPending;
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

			if (popupRoot && popupRoot.parentNode) popupRoot.parentNode.removeChild(popupRoot);
			popupRoot = null;
			popupEl = null;
		}

		// ==================== 状态徽章组件 ====================

		/** 每会话去重集合（切换会话时清空；按 node seq 去重，只提醒新错误）。 */

		/**
		 * 输入栏状态徽章组件。0.1.2 重构后插槽拿不到当前会话 id，
		 * 改为「主机权威 + 全部会话聚合」模式（与 ON AIR 胶囊一致）：
		 * 状态 = 主机监控全部会话的聚合（429 > 等待 > 运行 > 完成 > 空闲）。
		 */
		function StatusBadge(props) {
			var inputActions = props.inputActions;
			var conversation = props.conversation;
			var s = react.useSyncExternalStore(subscribe, getState, getState);


			var sessionCount = s.hostSessions.length;
			var alertCount = s.detections.length;
			var label = statusLabel(s.status);
			if (s.connection !== "online") label = connectionLabel(s.connection);
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
					"data-alert": s.connection === "online" && s.status === "interrupted" ? "true" : "false",
					role: "button", tabIndex: 0,
					onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePopup(); } },
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

		/**
		 * dsh 设置页「会话监控」面板：控制主机侧监控（:8091）的开关与状态展示。
		 */
		function SettingsSection() {
			var s = react.useSyncExternalStore(subscribe, getState, getState);
			var settings = s.settings || {};
			var online = canSend(), h = react.createElement;
			var disabled = !online || s.settingsPending;
			function toggle(key, label, desc, value) {
				return h("label", { key: key, style: { display: "flex", alignItems: "center", gap: "10px", margin: "12px 0" } },
					h("input", { type: "checkbox", checked: value, disabled: disabled, onChange: function (e) { var patch = {}; patch[key] = e.target.checked; postSettings(patch); }, style: { accentColor: "#93a9f5", width: "16px", height: "16px" } }),
					h("span", null, h("span", { style: { display: "block", fontWeight: 600 } }, label),
						h("span", { style: { display: "block", color: "#9aaac6", fontSize: "12px" } }, desc)));
			}
			return h("div", { style: { padding: "8px 4px 16px", fontSize: "13px" } },
				h("div", { style: { marginBottom: "14px" } }, h("strong", null, "DSH 会话监控"),
					h("span", { role: "status", style: { color: online ? "#6ee7b7" : "#fda4af", marginLeft: "10px", fontSize: "12px" } },
						connectionLabel(s.connection) + (s.profile ? " · " + s.profile : "") + (online ? " · " + s.hostSessions.length + " 个会话" : ""))),
				toggle("monitoring", "会话监控", "监听当前宿主的全部会话", settings.monitoring !== false),
				toggle("autoRetry", "自动继续", "由宿主统一执行；429 停止后向对应会话发送继续", settings.autoRetry === true),
				toggle("desktopDisplay", "桌面显示", "开启当前宿主的玻璃桌面件", settings.desktopDisplay === true),
				h("label", { style: { display: "flex", gap: "10px", alignItems: "center", margin: "12px 0" } }, "自动继续上限",
					h("input", { key: s.instanceId + ":" + settings.maxRetries, type: "number", min: 1, max: 10, disabled: disabled,
						defaultValue: settings.maxRetries || 3, onBlur: function (e) { postSettings({ maxRetries: Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3)) }); }, style: { width: "70px", padding: "6px" } })),
				h("label", { style: { display: "flex", gap: "10px", alignItems: "center", margin: "12px 0" } }, "额度用尽重试（分钟）",
					h("input", { key: s.instanceId + ":" + settings.tokenPlanRetryMs, type: "number", min: 1, max: 1440, disabled: disabled,
						defaultValue: Math.round((settings.tokenPlanRetryMs || 3600000) / 60000), onBlur: function (e) { postSettings({ tokenPlanRetryMin: Math.max(1, Math.min(1440, parseInt(e.target.value, 10) || 60)) }); }, style: { width: "70px", padding: "6px" } })),
				s.legacyRetryEnabled ? h("p", { style: { color: "#c4b5fd", fontSize: "12px" } }, "旧版客户端自动继续曾开启。现在统一由宿主执行，请核对上方开关；不会自动迁移为开启。") : null,
				s.testResult ? h("p", { role: "status", style: { fontSize: "12px", color: "#fda4af" } }, s.testResult) : null,
				h("p", { style: { color: "#9aaac6", fontSize: "12px" } }, online ? "设置仅属于 " + s.profile + "。独立仪表盘：" + monitorApi().replace(/\/api$/, "") : "连接宿主后可修改设置。")
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
					pollStopped = true;
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
		exports.pollHost = pollHost;
		exports.canSend = canSend;
		exports.postSettings = postSettings;
		// 测试钩子：仅用于冒烟测试调整定时/判定窗口（生产无副作用）。
		exports.__setStopWindow = function (ms) { CONFIG.stopWindowMs = ms; };
		return module.exports;
	}
});
