import fs from 'node:fs';
import vm from 'node:vm';
export function createClient({ binding = null, fetch = async () => { throw new Error('offline'); }, storage = new Map() } = {}) {
  let registration, now = Date.now();
  const timers = new Map(), requests = [], cleanups = [];
  let timerId = 0;
  class Clock extends Date { static now() { return now; } }
  const window = {
    __DSH_MONITOR_BINDING__: binding,
    __ModuleLoader__: { load(reg) { registration = reg; } },
    fetch: async (url, options) => { requests.push({ url, options }); return fetch(url, options); },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
  };
  const react = { createElement: () => ({}), useSyncExternalStore: (_, get) => get() };
  const context = vm.createContext({
    window, Date: Clock, console,
    setInterval(fn, interval) { const id = ++timerId; timers.set(id, { fn, interval }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout() { return ++timerId; }, clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), context);
  const mod = registration.factory(() => react);
  function apply() {
    mod.apply({
      effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); },
      locale: { register: () => () => {} },
      inject(deps, callback) { if (deps.includes('slots')) callback({ slots: { inject: (_, fn) => fn(), register: () => () => {} } }); },
    });
  }
  return {
    mod, window, requests, storage, apply, now: () => now, advance(ms) { now += ms; },
    tick(interval) { for (const timer of [...timers.values()]) if (timer.interval === interval) timer.fn(); },
    cleanup() { cleanups.forEach(fn => fn()); timers.clear(); },
  };
}
export const flush = () => new Promise(resolve => setImmediate(resolve));
export const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
export const snapshot = (binding, sessions = [], settings = {}) => ({
  instance: { id: binding.id, profile: binding.profile }, settings: { autoRetry: false, maxRetries: 3, monitoring: true, ...settings },
  total: sessions.length, sessions, archived: [],
});
