import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {apply} from '../host/session-monitor.mjs';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-http-'));
const savedHome=process.env.DSH_HOME,savedPort=process.env.SM_PORT;
process.env.DSH_HOME=home;process.env.SM_PORT='0';
const dispose=[],effects=[];let inject,calls=0;
const ctx={on(name,fn){if(name==='dispose')dispose.push(fn)},effect(fn){const cleanup=fn();if(typeof cleanup==='function')effects.push(cleanup)},webServer:{tapIndex(fn){inject=fn}},sessions:{list(){return []}},agents:{get(id){return id==='session'?{followup:async()=>{calls++;return {ok:true}}}:undefined}}};
try {
 apply(ctx,{profileId:'http-test',desktopDisplay:false});
 let binding;
 for(let i=0;i<100;i++) {const window={};vm.runInNewContext(inject('<head></head>').match(/<script>([\s\S]*?)<\/script>/)[1],{window});binding=window.__DSH_MONITOR_BINDING__;if(!binding.api.includes(':0/'))break;await new Promise(r=>setTimeout(r,10));}
 assert(!binding.api.includes(':0/'));
 const state=await (await fetch(binding.api+'/state')).json();assert.equal(state.instance.id,binding.id);
 const post=(url,body,id=binding.id)=>fetch(binding.api+url,{method:'POST',headers:{'Content-Type':'application/json','X-DSH-Monitor-Instance':id},body:JSON.stringify(body)});
 assert.equal((await post('/settings',{autoRetry:true},'wrong')).status,409);
 const settings=await (await post('/settings',{autoRetry:false,maxRetries:200})).json();assert.equal(settings.settings.maxRetries,10);
 const send={text:'isolated test',requestId:'same-request'};
 assert.equal((await (await post('/session/session/continue',send)).json()).status,'sent');
 assert.equal((await (await post('/session/session/continue',send)).json()).status,'sent');assert.equal(calls,1);
 assert.equal((await (await fetch(binding.api+'/delivery/same-request')).json()).status,'sent');
 console.log('✔ Actual HTTP binding, identity gate, settings and duplicate delivery');
} finally {
 dispose.forEach(fn=>fn());effects.forEach(fn=>fn());
 if(savedHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=savedHome;
 if(savedPort===undefined)delete process.env.SM_PORT;else process.env.SM_PORT=savedPort;
 fs.rmSync(home,{recursive:true,force:true});
}
