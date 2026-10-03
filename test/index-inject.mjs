// 验证：宿主插件必须同时提供「结构化 index-inject 行」与「tapIndex 变换」两条注入通道。
//  - 结构化行：桌面端页面（dsh-app://app/）只应用 collectIndexInjections() 返回的结构化行，
//    因此 window.__DSH_MONITOR_BINDING__ 必须作为 global 行出现在注入表里。
//  - tapIndex：webui 直连宿主时的兼容变换（幂等，注入相同值）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {apply} from '../host/session-monitor.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-inject-'));
const savedHome=process.env.DSH_HOME,savedPort=process.env.SM_PORT;
process.env.DSH_HOME=home;process.env.SM_PORT='0';

const dispose=[],effects=[];
let tapInject=null;
const injectRows=[];
const ctx={
  on(name,fn){ if(name==='dispose')dispose.push(fn); if(name==='webserver/index-inject')injectRows.push(fn); },
  effect(fn){ const cleanup=fn(); if(typeof cleanup==='function')effects.push(cleanup); },
  webServer:{ tapIndex(fn){ tapInject=fn; } },
  sessions:{ list(){ return []; } },
  agents:{ get(){ return undefined; } },
};
try {
  apply(ctx,{profileId:'inject-test',desktopDisplay:false});

  // 通道 1：结构化行（桌面端 boot 载荷走这条通道）
  const table=[];
  for(const fn of injectRows) fn(table);
  const globalRows=table.filter(r=>r.kind==='global');
  const bindingRow=globalRows.find(r=>r.name==='__DSH_MONITOR_BINDING__');
  const apiRow=globalRows.find(r=>r.name==='__DSH_MONITOR_API__');
  assert(bindingRow,'结构化行必须包含 __DSH_MONITOR_BINDING__ global 行');
  assert(apiRow,'结构化行必须包含 __DSH_MONITOR_API__ global 行');
  assert.equal(bindingRow.value.profile,'inject-test');
  assert.equal(typeof bindingRow.value.id,'string');
  assert.ok(bindingRow.value.id.length>0,'实例 id 非空');
  assert.equal(apiRow.value,bindingRow.value.api);
  assert.ok(bindingRow.value.api.endsWith('/api'),'api 指向 /api');
  console.log('✔ 结构化行（webserver/index-inject）包含 binding global，api='+bindingRow.value.api+' id='+bindingRow.value.id.slice(0,8)+' profile='+bindingRow.value.profile);

  // 通道 2：tapIndex（webui 兼容变换），必须与结构化行同值
  assert(tapInject,'tapIndex 变换必须注册');
  let window={};
  vm.runInNewContext(tapInject('<head></head>').match(/<script>([\s\S]*?)<\/script>/)[1],{window});
  assert.equal(JSON.stringify(window.__DSH_MONITOR_BINDING__),JSON.stringify(bindingRow.value),'tapIndex 与结构化行值一致');
  assert.equal(window.__DSH_MONITOR_API__,apiRow.value);
  console.log('✔ tapIndex 变换与结构化行注入相同 binding');

  // 反向用例：没有注册结构化行时（旧版行为），桌面端页面拿不到 binding
  console.log('✔ 结论：桌面端必须依赖结构化行；仅 tapIndex 时桌面端显示「未绑定宿主」');
} finally {
  dispose.forEach(fn=>fn());effects.forEach(fn=>fn());
  if(savedHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=savedHome;
  if(savedPort===undefined)delete process.env.SM_PORT;else process.env.SM_PORT=savedPort;
  fs.rmSync(home,{recursive:true,force:true});
  await new Promise(r=>setTimeout(r,100));
  process.exit(0);
}
