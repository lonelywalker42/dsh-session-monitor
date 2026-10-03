import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardHtml } from '../host/session-monitor.mjs';

const html = dashboardHtml();
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert(scripts.length > 0);
scripts.forEach((match, index) => new vm.Script(match[1], { filename: `dashboard-script-${index}` }));
const elements = new Map();
const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { style: {}, dataset: {}, addEventListener() {} });
    return elements.get(id);
  },
  querySelectorAll() { return []; },
  addEventListener() {},
};
const separator = String.fromCharCode(92);
const windowsPath = ['D:', 'Research', 'Harness'].join(separator);
const snapshot = {
  instance: { id: "dashboard-test", profile: "test" }, settings: { autoRetry: false }, total: 4, archived: [],
  sessions: ['active', 'waiting-approval', 'error429', 'complete'].map((state, i) => ({
    id: String(i), title: '<script>test</script>', cwd: windowsPath, state, stateText: state,
    lastActivity: Date.now(), retries: 0, alerts: state === 'error429' ? [{ kind: '429', code: 'RATE_LIMIT', message: '<alert>' }] : [],
  })),
};
const context = vm.createContext({ document, Date, AbortController, setTimeout, clearTimeout, setInterval() {}, fetch: async () => ({ ok: true, json: async () => snapshot }) });
vm.runInContext(scripts[0][1], context);
await new Promise(resolve => setTimeout(resolve, 0));
for (const id of ['stat-active', 'stat-wait', 'stat-alert', 'stat-done']) assert.equal(elements.get(id).textContent, 1, id);
assert.equal(elements.get('health').dataset.online, 'true');
assert(elements.get('rows').innerHTML.includes('&lt;script&gt;test&lt;/script&gt;'));
assert(elements.get('rows').innerHTML.includes('[429] RATE_LIMIT'));
assert.equal(vm.runInContext('cwdShort(' + JSON.stringify(windowsPath) + ')', context), ['Research', 'Harness'].join(separator));
context.fetch = async () => { throw new Error('offline'); };
await vm.runInContext('refresh()', context);
assert.equal(elements.get('health').dataset.online, 'false');
assert(elements.get('health').textContent.includes('offline'));
console.log('✔ Generated dashboard script, state summary, escaping, Windows paths and offline indicator');
