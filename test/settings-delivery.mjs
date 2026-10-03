import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSettingsStore,resolveProfile,createMonitorCore} from '../host/session-monitor.mjs';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-monitor-test-'));
try {
 const root=path.join(home,'storages','session-monitor'); fs.mkdirSync(root,{recursive:true}); fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({autoRetry:true,maxRetries:100}));
 const defaults={autoRetry:false,maxRetries:3,monitoring:true};
 const a=createSettingsStore({home,profile:'desktop',defaults}); assert.equal(a.migrated,true); assert.equal(a.settings.maxRetries,10);
 a.save({...a.settings,autoRetry:false});
 const again=createSettingsStore({home,profile:'desktop',defaults}); assert.equal(again.instanceId,a.instanceId); assert.equal(again.settings.autoRetry,false);
 const b=createSettingsStore({home,profile:'web',defaults}); assert.notEqual(a.instanceId,b.instanceId); assert.equal(b.settings.autoRetry,true);
 assert.equal(resolveProfile({port:8091},{SM_PORT:'8092'},'/custom/plugin'),'endpoint-8092');
 fs.writeFileSync(a.file,'bad json'); assert.throws(()=>createSettingsStore({home,profile:'desktop',defaults}));
} finally { fs.rmSync(home,{recursive:true,force:true}); }
const c=createMonitorCore(); let calls=0;
c.agents.set('s',{followup:async()=>{calls++}}); c.ensure('s');
const first=c.continueSession('s','text','req'); assert.equal(first.ok,true);
assert.equal(c.continueSession('s','text','req').ok,true);
assert.equal(c.continueSession('s','other','req').reason,'request-id-conflict');
assert.equal((await c.waitForDelivery('req')).status,'sent'); assert.equal(calls,1);
c.agents.set('fail',{followup:async()=>{throw Error('transport rejected')}});
c.continueSession('fail','text','bad'); assert.equal((await c.waitForDelivery('bad')).status,'failed');
assert.equal(c.deliveryReceipt('bad').status,'failed'); assert.equal(c.deliveryReceipt('missing').ok,false);
c.clearAllTokenPlanTimers();
console.log('✔ Profile migration, durable identity, isolation and idempotent delivery receipts');
