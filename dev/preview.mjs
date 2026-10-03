// Isolated UI preview. Synthetic sessions only; never sends to a running DSH host.
import http from 'node:http';
import fs from 'node:fs';
import { dashboardHtml, injectMonitorEndpoint } from '../host/session-monitor.mjs';

const port = Number(process.env.SM_PREVIEW_PORT || 18091);
const base = `http://127.0.0.1:${port}`;
const now = Date.now();
const sessions = [
  ['approval', 'Knowledge · PersonalProject', 'waiting-approval', '等待批准', 'D:/PersonalProject/Knowledge'],
  ['research', '先充分了解这份代码研究的问题和运行方式', 'active', '活动中', 'D:/Research/DeepSeek'],
  ['done', '会话监控工具 UI 优化', 'complete', '工作完成', 'D:/DshWork/dsh-session-monitor'],
  ['limit', '长时间任务 · 限流恢复验证', 'error429', '429 中断', 'D:/Research/Harness'],
].map(([id, title, state, stateText, cwd]) => ({ id, title, state, stateText, cwd, running: state === 'active',
  activeSince: now - 93000, lastActivity: now - 12000, retries: 0,
  alerts: state === 'error429' ? [{ kind: '429', code: 'RATE_LIMIT', message: '请求频率超过限制，请稍后继续。', ts: now }] : [] }));
const instance = {id: "preview-host", profile: "preview"};
const state = { instance, settings: { autoRetry: false, desktopDisplay: true, monitoring: true, maxRetries: 3 }, sessions, total: sessions.length, archived: [] };
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-DSH-Monitor-Instance');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/client.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(fs.readFileSync(new URL('../client.js', import.meta.url))); return; }
  if (req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      if (req.url === '/api/settings') {
        let body = ''; req.on('data', part => { body += part; });
        req.on('end', () => { try { Object.assign(state.settings, JSON.parse(body)); } catch {} res.end(JSON.stringify({ ok: true, settings: state.settings, instance })); });
      } else res.end(JSON.stringify({ ok: true, status: "sent", instance }));
    } else res.end(JSON.stringify(req.url === '/api/settings' ? { settings: state.settings, instance } : state));
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/popup') {
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 浮窗预览</title><style>body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 20% 20%,#6575a9,transparent 55%),radial-gradient(ellipse at 80% 70%,#667996,transparent 50%),#273148;font-family:system-ui;color:#dce6fa}.preview-note{padding:36px;font-size:13px;max-width:340px;line-height:1.8}.preview-note a{color:#bdd0ff}</style></head><body><div class="preview-note">DSH 会话浮窗 · Glass 预览<br>使用模拟数据，操作不会发送到真实会话。<br><a href="/">查看主机仪表盘 →</a></div><script>window.__ModuleLoader__={load:function(reg){window.previewMonitor=reg.factory(function(){return{}})}};</script><script src="/client.js"></script><script>window.previewMonitor.apply({effect:function(fn){fn()},locale:{register:function(){}},inject:function(){}});</script></body></html>`;
    res.end(injectMonitorEndpoint(html, base, instance));
  } else res.end(dashboardHtml());
}).listen(port, '127.0.0.1', () => console.log(`UI preview: ${base} · popup: ${base}/popup (synthetic data only)`));
