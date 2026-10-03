import {spawnSync} from 'node:child_process';
for(const file of ['test/smoke.mjs','host/test-core.mjs','test/client-runtime.mjs','test/settings-delivery.mjs','test/host-http.mjs','test/endpoint-routing.mjs','test/dashboard.mjs','test/index-inject.mjs','test/load-sim.mjs']) {
 const result=spawnSync(process.execPath,[file],{stdio:'inherit'}); if(result.status!==0)process.exit(result.status||1);
}
