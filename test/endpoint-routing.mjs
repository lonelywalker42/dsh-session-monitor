import assert from 'node:assert/strict';
import vm from 'node:vm';
import { injectMonitorEndpoint } from '../host/session-monitor.mjs';
import { createClient, response, snapshot, flush } from './client-harness.mjs';
for (const port of [8091,8092]) {
 const instance={id:'host-'+port,profile:'profile-'+port};
 const window={}; const html=injectMonitorEndpoint('<head><script>window.started=true</script></head>', 'http://127.0.0.1:'+port, instance);
 const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
 vm.runInNewContext(scripts[0][1],{window}); assert.equal(window.started,undefined);
 const binding=window.__DSH_MONITOR_BINDING__;
 assert.equal(binding.id,instance.id);
 const c=createClient({binding,fetch:async(url,opts)=>response(opts?.method==='POST'?{ok:true,status:'sent',instance}:snapshot(binding,[{id:'session/'+port,state:'active',alerts:[]}]))});
 c.apply(); await flush();
 assert.equal(await c.mod.sendText('session/'+port,'继续'),true);
 assert(c.requests.every(r=>r.url.startsWith(binding.api+'/')));
 assert(c.requests.some(r=>r.options?.headers?.['X-DSH-Monitor-Instance']===instance.id));
 c.cleanup();
}
const special={id:'host',profile:'</script>test'};
const html=injectMonitorEndpoint('<head></head>','http://localhost:8091',special);
const window={}; vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{window});
assert.equal(window.__DSH_MONITOR_BINDING__.profile,special.profile);
console.log('✔ Dual-instance endpoint routing and safe injection');
