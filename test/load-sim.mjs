/**
 * dsh-429-monitor 加载/注册/渲染链路模拟 — 在 Node 下用真实 React 19 复现：
 *  1) 模拟 window.__ModuleLoader__.load 加载 client.js（经典脚本）
 *  2) 用 require("react") 执行 factory
 *  3) mock ctx 调用 apply(ctx)，验证不抛错
 *  4) 捕获 scope.slots.register，验证注册了 StatusBadge
 *  5) 用 react-dom/server 渲染 StatusBadge，验证组件可渲染
 *
 * 运行：node test/load-sim.mjs
 */
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * 解析 React / ReactDOM 的位置。
 * 原版写死 `C:/Users/12575/AppData/Local/npm-cache/_npx/.../react`（制作者机器的 npx 缓存），
 * 在其它机器上必然 MODULE_NOT_FOUND。这里改为按候选锚点探测，并支持
 * DSH_REACT_ROOT / DSH_CHECKOUT 环境变量覆盖；找不到时给出可操作的提示。
 */
function resolveReactRoot() {
  const fileOf = (p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile() } catch { return false } };
  // 1) 显式覆盖：DSH_REACT_ROOT 直接指到含 react/ 的目录；DSH_CHECKOUT 指仓库根。
  const explicit = [process.env.DSH_REACT_ROOT, process.env.DSH_CHECKOUT]
    .filter(Boolean)
    .flatMap((root) => [root, path.join(root, 'node_modules'), path.join(root, 'apps', 'web', 'node_modules')]);
  for (const root of explicit) {
    if (fileOf(path.join(root, 'react', 'package.json'))) return root;
  }
  // 2) 常规 Node 解析：插件自身、逐级向上、以及已安装的 profile（桌面版/web 版）。
  const probes = [
    new URL('..', import.meta.url),
    new URL('../../../', import.meta.url),
    new URL('../../../../', import.meta.url),
    pathToFileURL(path.join(os.homedir(), '.dsh', 'profiles', 'desktop') + path.sep),
    pathToFileURL(path.join(os.homedir(), '.dsh', 'profiles', 'web') + path.sep),
  ];
  for (const base of probes) {
    try {
      const rooted = createRequire(base);
      return path.dirname(path.dirname(rooted.resolve('react/package.json')));
    } catch { /* 继续探测下一处 */ }
  }
  // 3) 本机已知的 dsh 开发检出（pnpm workspace 会把 react 放在 apps/*/node_modules 下）。
  const known = [
    'D:/Deepseek_Harness/deepseek-harness',
    path.join(os.homedir(), 'Deepseek_Harness', 'deepseek-harness'),
  ];
  for (const root of known) {
    for (const sub of ['apps/web/node_modules', 'apps/desktop/node_modules', 'node_modules']) {
      const dir = path.join(root, sub);
      if (fileOf(path.join(dir, 'react', 'package.json'))) return dir;
    }
  }
  return undefined;
}

const REACT19 = resolveReactRoot();
if (!REACT19) {
  console.error('✘ 找不到 React。请设置 DSH_REACT_ROOT 指向包含 react/ 的 node_modules 目录，');
  console.error('  例如：$env:DSH_REACT_ROOT="D:\Deepseek_Harness\deepseek-harness\apps\web\node_modules"');
  process.exit(1);
}
const requireFromRoot = createRequire(pathToFileURL(path.join(REACT19, 'noop.js')).href);

// ---------- 1) DOM 桩 ----------
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.MutationObserver = class { constructor(){} observe(){} disconnect(){} };
globalThis.window = { innerWidth: 1280, innerHeight: 800 };
const mkEl = (tag) => ({
  tagName: tag.toUpperCase(), children: [], style: {}, className: '', dataset: {},
  setAttribute() {}, appendChild(c) { this.children.push(c); return c; },
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
  remove() {}, addEventListener() {}, setPointerCapture() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  closest() { return null; }, getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
  get innerHTML() { return ''; }, set innerHTML(v) {},
  get textContent() { return ''; }, set textContent(v) {},
  contains() { return false; }, parentNode: null, nodeType: 1, nodeValue: null,
});
globalThis.document = {
  head: mkEl('head'), body: mkEl('body'),
  createElement: (t) => mkEl(t),
  querySelector: () => null,
  addEventListener() {},
  contains() { return false; },
};

// ---------- 2) 模拟模块加载器 ----------
let registration = null;
globalThis.window.__ModuleLoader__ = { load(reg) { registration = reg; } };
const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
vm.runInThisContext(code);
console.log('✔ client.js 已通过 window.__ModuleLoader__.load 注册, id =', registration.id);

// ---------- 3) 执行 factory（真实 React） ----------
const React = requireFromRoot('react');
const mod = registration.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});
console.log('✔ factory 执行 OK (React', React.version + ')，apply 是函数:', typeof mod.apply === 'function');

// ---------- 4) mock ctx 并调用 apply ----------
// 注意：client.js 会向「两个」插槽各注册一次（conversation.input.left 的 StatusBadge、
// settings.section 的 SettingsSection）。原版只用一个 registeredEntry 变量接最后一次注册，
// 于是被后注册的 SettingsSection 覆盖，导致下面断言 StatusBadge 时必然失败。
// 这里改为**按插槽键**分别记录，才能正确验证两个注册都发生。
const registeredBySlot = new Map();
const cleanups = [];
const ctx = {
  effect(fn, label) { const c = fn(); if (typeof c === 'function') cleanups.push(c); console.log('✔ ctx.effect(', label, ')'); },
  inject(deps, cb) {
    console.log('✔ ctx.inject(', JSON.stringify(deps), ')');
    // 立即提供 slots 服务
    const scope = {
      slots: {
        inject(key, cb2) { console.log('  ✔ scope.slots.inject(', key, ')'); currentSlot = key; cb2(key); },
        register(opts, comp) {
          console.log('  ✔ scope.slots.register -> id=', opts.id, 'order=', opts.order, 'component=', comp.name || '(anon)');
          if (!registeredBySlot.has(currentSlot)) registeredBySlot.set(currentSlot, { opts, comp });
          return () => {};
        },
      },
    };
    const dispose = cb(scope);
    if (typeof dispose === 'function') cleanups.push(dispose);
  },
  locale: { register(ns, dict) { console.log('✔ ctx.locale.register(', ns, ') keys=', Object.keys(dict).join(',')); return () => {}; } },
};
let currentSlot = '';

try {
  mod.apply(ctx);
  console.log('✔ apply(ctx) 执行 OK');
} catch (e) {
  console.error('✘ apply(ctx) 抛错:', e.message);
  process.exit(1);
}
const badgeEntry = registeredBySlot.get('conversation.input.left');
if (!badgeEntry || badgeEntry.comp !== mod.StatusBadge) {
  console.error('✘ 未注册 StatusBadge 到 conversation.input.left');
  process.exit(1);
}
console.log('✔ 已注册 StatusBadge 到 conversation.input.left（id=dsh-429-monitor, order=200）');
const settingsEntry = registeredBySlot.get('settings.section');
if (!settingsEntry) {
  console.error('✘ 未注册 SettingsSection 到 settings.section');
  process.exit(1);
}
console.log('✔ 已注册 SettingsSection 到 settings.section（id=dsh-429-monitor）');

// ---------- 5) 渲染 StatusBadge ----------
try {
  const { renderToString } = await import(pathToFileURL(requireFromRoot.resolve('react-dom/server.node')).href);
  const session = {
    sessionId: 'sess-12345678',
    running: true,
    nodes: [
      { kind: 'assistant', seq: 1 },
      { kind: 'turn-error', seq: 2, code: 'RATE_LIMIT', message: '429 Too Many Requests', time: Date.now() },
      { kind: 'model-retry', seq: 3, failure: { code: 'RATE_LIMIT', status: 429, message: 'rate limit' }, provider: 'deepseek', time: Date.now() },
    ],
  };
  const seat = {
    session,
    inputActions: { setDraft() {}, submit() {} },
    conversation: { send: async () => true },
    t: (k) => k,
  };
  const html = renderToString(React.createElement(badgeEntry.comp, seat));
  console.log('✔ renderToString 渲染 OK，输出长度:', html.length);
  if (html.includes('429') || html.includes('中断')) console.log('✔ 渲染结果包含 429/中断 标记');
  else console.warn('  注意：渲染结果未包含预期标记（可能是状态未同步）');
} catch (e) {
  console.error('✘ 渲染 StatusBadge 抛错:', e.message);
  process.exit(1);
}

// ---------- 6) 清理 ----------
for (const c of cleanups) { try { c(); } catch (e) { console.error('cleanup err', e); } }
console.log('\n结果: 全部通过');
