import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {control} from '../src/ipc.mjs';
import {registerCallback, persistCancellation, saveNotificationFile} from '../src/notify.mjs';
import {callbackRegistryKey, desktopReconnectEvent} from '../src/desktop-recovery.mjs';

const script = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
async function until(fn) {
  for (let i=0;i<500;i++) {try {const value=await fn(); if(value)return value;} catch {} await delay(20);}
  throw new Error('Isolated Desktop recovery deadline expired');
}
const read = path => JSON.parse(readFileSync(path,'utf8'));
async function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'dsh-desktop-recovery-')), state=join(root,'state'), codex=join(root,'codex');
  mkdirSync(state);
  const env={...process.env,DSH_SUBAGENT_STATE:state,DSH_SUBAGENT_CONFIG:join(root,'config'),CODEX_HOME:codex,DSH_CLI:process.execPath};
  delete env.CODEX_THREAD_ID; delete env.CODEX_APP_TOOLS_PIPE_PATH; delete env.CODEX_APP_TOOLS_CALLER_HOST_ID;
  delete env.DSH_DESKTOP_MCP_SERVER; delete env.DSH_DESKTOP_MCP_NODE;
  const plugin=join(codex,'plugins/cache/openai-bundled/codex-app-tools/fixture'); mkdirSync(plugin,{recursive:true});
  // A controlled MCP endpoint uses a real OS named pipe/socket. Its content is
  // synthetic; no user's Desktop pipe, plugin process, chat or DSH model is used.
  writeFileSync(join(plugin,'server.mjs'),`import net from 'node:net';
const socket=net.connect(process.env.CODEX_APP_TOOLS_PIPE_PATH);
socket.on('error',()=>process.exit(2)); socket.pipe(process.stdout);process.stdin.pipe(socket);
socket.on('close',()=>process.exit(0));`);
  const daemon=spawn(process.execPath,[script,'--daemon'],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let diagnostics='';daemon.stderr.on('data',chunk=>{diagnostics+=chunk;});
  const pipes=[],children=[],directories=[],rows=[];
  t.after(async()=>{
    for(const directory of directories) if(existsSync(join(directory,'callback.json'))) persistCancellation(directory);
    for(const child of children) {child.stdin.end(); if(child.exitCode===null) child.kill();}
    for(const p of pipes) {for(const socket of p.sockets)socket.destroy(); await new Promise(resolve=>p.server.close(resolve));}
    if(daemon.exitCode===null) {await control('stop',{state,force:true}).catch(()=>daemon.kill()); await Promise.race([new Promise(resolve=>daemon.once('close',resolve)),delay(1500)]);}
    await delay(150);rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  await until(async()=>{try{return (await control('status',{state})).pid===daemon.pid;}catch{return false;}});
  function seed(id, {status='delivery_failed', delivery_state='not_sent', host='local', parent='fixture-parent', result={}, recordStatus='completed', turn='execution-'+id, cancelled=false, custom=false, receiptFields={}}={}) {
    const receipt={agent_id:id,thread_id:parent,turn,delivery:'desktop-message',status,delivery_state,desktop_host_id:host,pid:99999999,...receiptFields};
    const key=callbackRegistryKey(receipt), directory=custom?join(root,'custom-'+id):join(state,'callbacks','dsh-callback-'+key);
    mkdirSync(directory,{recursive:true}); directories.push(directory);
    writeFileSync(join(state,'callbacks',key+'.json'),JSON.stringify({directory}));
    receipt.result_path=join(directory,'result.json');
    writeFileSync(join(directory,'callback.json'),JSON.stringify(receipt));
    const record={id,status:recordStatus,execution_id:turn,cwd:root,created_at:new Date().toISOString(),answer:'synthetic saved result',persisted:true};
    const db=new DatabaseSync(join(state,'state.sqlite'));
    try {db.prepare('INSERT OR REPLACE INTO agents VALUES (?,?)').run(id,JSON.stringify(record));}finally{db.close();}
    if(result!==null) writeFileSync(receipt.result_path,JSON.stringify({...record,agent_id:id,wait_outcome:'settled',...result}));
    if(cancelled) persistCancellation(directory);
    return {directory,key,receipt,path:join(directory,'callback.json'),resultPath:receipt.result_path,record};
  }
  async function pipe({mode='normal',readGate,host='local'}={}) {
    const path=process.platform==='win32'?'\\\\.\\pipe\\dsh-recovery-fixture-'+randomUUID():join(root,'pipe-'+randomUUID()+'.sock');
    const sockets=new Set();
    const server=net.createServer(socket=>{
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
      const lines=createInterface({input:socket});lines.on('line',async line=>{
        const r=JSON.parse(line);let result;
        if(r.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'isolated-pipe',version:'1'}};
        if(r.method==='tools/list')result={tools:['read_thread','send_message_to_thread'].map(name=>({name,inputSchema:{type:'object'}}))};
        if(r.method==='tools/call') {
          rows.push({pipe:path,request:r});
          if(r.params.name==='read_thread'&&readGate)await readGate;
          if(r.params.name==='send_message_to_thread'&&mode==='ack-lost'){socket.destroy();return;}
          const args=r.params.arguments;
          const value=r.params.name==='read_thread'?{thread:{id:mode==='wrong-parent'?'another-parent':args.threadId,status:{type:mode==='closed'?'closed':'idle'},hostId:host}}:{threadId:args.threadId};
          result=mode==='not-sent'?{isError:true,content:[{type:'text',text:'fixture pre-send failure'}]}:{content:[{type:'text',text:JSON.stringify(value)}]};
        }
        if(r.id!==undefined&&!socket.destroyed)socket.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:result||{}})+'\n');
      });
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});pipes.push({server,sockets});
    return path;
  }
  async function frontend(pipe,host='local') {
    const child=spawn(process.execPath,[script],{env:{...env,CODEX_APP_TOOLS_PIPE_PATH:pipe,CODEX_APP_TOOLS_CALLER_HOST_ID:host},windowsHide:true,stdio:['pipe','pipe','pipe']});
    children.push(child);let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
    const lines=createInterface({input:child.stdout});
    const initialized=new Promise((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));child.once('exit',()=>reject(new Error(errors)));});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'synthetic-frontend',version:'1'}}})+'\n');
    const reply=await initialized;assert.equal(reply.id,1);assert.ok(reply.result?.serverInfo);
    return child;
  }
  function event(path,fields={}) {return {...desktopReconnectEvent({...env,CODEX_APP_TOOLS_PIPE_PATH:path}),...fields};}
  async function reconnect(context) {return control('desktop-reconnect',{state,desktop_context:context,timeoutMs:45000});}
  async function noPrompts() {
    assert.deepEqual((await control('status',{state})).runtimes,[]);
    const db=new DatabaseSync(join(state,'state.sqlite'),{readOnly:true});
    try{assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='bridge/prompt'").get().n,0);}finally{db.close();}
  }
  return {root,state,env,daemon,seed,pipe,frontend,event,reconnect,noPrompts,rows,diagnostics:()=>diagnostics};
}

test('fresh frontend without thread metadata recovers the original saved result over authenticated daemon IPC and a real test pipe',async t=>{
  const f=await fixture(t), saved=f.seed('saved');const original=readFileSync(saved.resultPath,'utf8');
  const p=await f.pipe();await f.frontend(p);
  const receipt=await until(()=>{const r=read(saved.path);return r.status==='delivered'&&r;});
  assert.equal(receipt.registrar_pid,f.daemon.pid);assert.equal(receipt.turn,saved.record.execution_id);
  assert.equal(receipt.delivery_state,'accepted');assert.equal(receipt.recovery_history[0].trigger,'desktop_reconnect');
  assert.equal(readFileSync(saved.resultPath,'utf8'),original);
  const sends=f.rows.filter(row=>row.request.params.name==='send_message_to_thread');
  assert.equal(sends.length,1);assert.equal(sends[0].request.params.arguments.threadId,'fixture-parent');
  assert.equal(sends[0].pipe,p);await f.frontend(p);await delay(200);assert.equal(f.rows.filter(row=>row.request.params.name==='send_message_to_thread').length,1);
  await f.noPrompts();t.diagnostic(JSON.stringify({kind:'controlled-real-ipc-named-pipe',desktop_restarted:false,thread_metadata_at_startup:false,sends:1,execution_id:receipt.turn}));
});

test('startup recovery preflight does not block the normal MCP initialize response',async t=>{
  const f=await fixture(t);f.seed('nonblocking');let release;const gate=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());const p=await f.pipe({readGate:gate});await f.frontend(p);
  await until(()=>f.rows.some(row=>row.request.params.name==='read_thread'));
  assert.equal(f.rows.filter(row=>row.request.params.name==='send_message_to_thread').length,0);
  release();await until(()=>f.rows.some(row=>row.request.params.name==='send_message_to_thread'));await f.noPrompts();
});

test('reconnect while the observer is alive refreshes its final delivery without recreating observation or replaying a task',async t=>{
  const f=await fixture(t), old=await f.pipe();
  const seed=f.seed('running',{status:'watching',recordStatus:'running',result:null});
  // Remove the synthetic receipt to let the real daemon create its observer.
  rmSync(seed.path);
  const receipt=await registerCallback({agent:'running',thread:'fixture-parent',turn:seed.record.execution_id,state:f.state,delivery:'desktop-message'},{env:{...f.env,CODEX_APP_TOOLS_PIPE_PATH:old}});
  assert.equal(receipt.status,'watching');assert.equal(dirname(receipt.result_path),seed.directory);
  const fresh=await f.pipe(),event=f.event(fresh);await f.reconnect(event);
  // Complete only the isolated persisted record, then ask the existing Manager
  // to reload it via its ordinary read. No model runtime exists in this fixture.
  const db=new DatabaseSync(join(f.state,'state.sqlite'));
  try{db.prepare('UPDATE agents SET data=? WHERE id=?').run(JSON.stringify({...seed.record,status:'completed',persisted:false}),'running');}finally{db.close();}
  const client=(await import('../src/bridge-client.mjs')).bridgeClient;
  const bridge=await client(f.state);try{await bridge.request('tools/call',{name:'dsh_rename',arguments:{agent_id:'running',name:'synthetic completion transition'}});}finally{bridge.close();}
  const done=await until(()=>{const r=read(seed.path);return r.status==='delivered'&&r;});
  assert.equal(done.pid,receipt.pid);assert.equal(done.desktop_connection_id,event.connection_id);
  assert.equal(done.recovery_history,undefined);
  const sends=f.rows.filter(row=>row.request.params.name==='send_message_to_thread');assert.equal(sends.length,1);assert.equal(sends[0].pipe,fresh);await f.noPrompts();
});

test('an older surviving observer that finishes after reconnect is recovered from its result commit event',async t=>{
  const f=await fixture(t), original=f.seed('late',{status:'watching',recordStatus:'running',result:null});
  const p=await f.pipe(),event=f.event(p);await f.reconnect(event);
  await saveNotificationFile(original.resultPath,{...original.record,status:'completed',agent_id:original.record.id,wait_outcome:'settled'});
  await saveNotificationFile(original.path,{...original.receipt,status:'delivery_failed',delivery_state:'not_sent',error:'synthetic older observer stale pipe'});
  const done=await until(()=>{const r=read(original.path);return r.status==='delivered'&&r;});
  assert.equal(done.recovery_history.length,1);assert.equal(done.desktop_connection_id,event.connection_id);
  assert.equal(f.rows.filter(row=>row.request.params.name==='send_message_to_thread').length,1);await f.noPrompts();
});

test('terminal, uncertain, cancelled, paused, non-Desktop, wrong host, result and registry identities never auto-send',async t=>{
  const f=await fixture(t);const cases=[
    ['accepted',{status:'delivered',delivery_state:'accepted'}],['unknown',{status:'delivery_uncertain',delivery_state:'unknown'}],
    ['attempting',{status:'delivery_attempting',delivery_state:'unknown'}],['stopped',{status:'stopped'}],['cancelled',{cancelled:true}],
    ['cancel-receipt',{receiptFields:{cancel_requested:true}}],['native',{receiptFields:{delivery:'tool-output'}}],['queue',{receiptFields:{delivery:'queue'}}],
    ['host',{host:'other-host'}],['partial',{result:{wait_outcome:'timeout'}}],['missing',{result:null}],
    ['result-agent',{result:{agent_id:'different'}}],['result-execution',{result:{execution_id:'different'}}],
    ['interrupted-result',{result:{status:'interrupted'}}],['agent-stopped',{recordStatus:'closed'}],['custom',{custom:true}],
  ];
  const records=cases.map(([id,options])=>f.seed(id,options));
  const mismatch=f.seed('registry');writeFileSync(join(f.state,'callbacks',mismatch.key+'.json'),JSON.stringify({directory:records[0].directory}));
  const cancelledLegacy=f.seed('legacy-host',{host:undefined});const legacy=read(cancelledLegacy.path);delete legacy.desktop_host_id;writeFileSync(cancelledLegacy.path,JSON.stringify(legacy));
  // Legacy local records may recover; do not select them from a remote host.
  const remote=await f.pipe({host:'other-host'});await f.reconnect(f.event(remote,{host_id:'unrelated-host'}));
  assert.equal(f.rows.length,0);
  persistCancellation(cancelledLegacy.directory);
  const p=await f.pipe();await f.reconnect(f.event(p));await delay(100);
  assert.equal(f.rows.filter(row=>row.request.params.name==='send_message_to_thread').length,0);
  const paused=f.seed('paused');writeFileSync(join(f.state,'paused'),'');const response=await f.reconnect(f.event(p,{connection_id:randomUUID()}));assert.equal(response.recovery.status,'paused');assert.equal(read(paused.path).status,'delivery_failed');
  await f.noPrompts();
});

test('same generation failures and send acknowledgement loss stay closed, concurrent duplicates send at most once, and older generations cannot overwrite the fresh pipe',async t=>{
  const f=await fixture(t), saved=f.seed('failure');const bad=await f.pipe({mode:'not-sent'}),event=f.event(bad);
  await Promise.all([f.reconnect(event),f.reconnect(event)]);
  await until(()=>read(saved.path).status==='delivery_failed');await delay(200);
  assert.equal(read(saved.path).recovery_history.length,1);assert.equal(f.rows.filter(row=>row.request.params.name==='send_message_to_thread').length,0);
  const fresh=await f.pipe({mode:'ack-lost'}), next=f.event(fresh,{started_at:event.started_at+1});await f.reconnect(next);
  await until(()=>read(saved.path).status==='delivery_uncertain');
  assert.equal(f.rows.filter(row=>row.request.params.name==='send_message_to_thread').length,1);
  const stale=await f.reconnect({...event,connection_id:randomUUID()});assert.equal(stale.recovery.status,'stale_or_duplicate');
  assert.equal(read(join(saved.directory,'desktop-context.json')).pipe,fresh);
  await f.reconnect(f.event(await f.pipe(),{started_at:next.started_at+1}));await delay(100);
  assert.equal(f.rows.filter(row=>row.request.params.name==='send_message_to_thread').length,1);await f.noPrompts();
});

test('malformed context overrides, malformed pending records, symlink registry directories and a different parent read fail closed',async t=>{
  const f=await fixture(t), original=f.seed('malformed');
  writeFileSync(original.path+'.pending','{broken');
  const p=await f.pipe();await assert.rejects(f.reconnect({...f.event(p),DSH_DESKTOP_MCP_SERVER:'override'}),/Invalid fresh Desktop/);
  await f.reconnect(f.event(p));assert.equal(f.rows.length,0);
  const link=f.seed('link'), target=join(f.root,'outside-link');mkdirSync(target);rmSync(link.directory,{recursive:true});
  symlinkSync(target,link.directory,process.platform==='win32'?'junction':'dir');
  writeFileSync(join(target,'callback.json'),JSON.stringify(link.receipt));writeFileSync(join(target,'result.json'),JSON.stringify({...link.record,agent_id:link.record.id,wait_outcome:'settled'}));
  const wrong=f.seed('wrong-parent');const wrongPipe=await f.pipe({mode:'wrong-parent'});await f.reconnect(f.event(wrongPipe));
  await until(()=>read(wrong.path).status==='delivery_failed');assert.equal(f.rows.filter(row=>row.request.params.name==='send_message_to_thread').length,0);
  assert.ok(!existsSync(join(target,'desktop-context.json')));await f.noPrompts();
});

test('legacy local callbacks and flushed pending results recover without changing bytes, with optional exact parent scope',async t=>{
  const f=await fixture(t), selected=f.seed('legacy'), other=f.seed('other',{parent:'other-parent'});
  const legacy=read(selected.path);delete legacy.desktop_host_id;writeFileSync(selected.path,JSON.stringify(legacy));
  const original='  '+readFileSync(selected.resultPath,'utf8')+'  \n';
  writeFileSync(selected.resultPath+'.pending',original);rmSync(selected.resultPath);
  const p=await f.pipe();await f.reconnect(f.event(p,{thread_id:'fixture-parent'}));
  await until(()=>read(selected.path).status==='delivered');
  assert.equal(readFileSync(selected.resultPath,'utf8'),original);assert.ok(!existsSync(selected.resultPath+'.pending'));
  assert.equal(read(other.path).status,'delivery_failed');assert.ok(!existsSync(join(other.directory,'desktop-context.json')));
  const sends=f.rows.filter(row=>row.request.params.name==='send_message_to_thread');assert.equal(sends.length,1);assert.equal(sends[0].request.params.arguments.hostId,'local');await f.noPrompts();
});

test('a cancellation received during reconnect preflight prevents sending, while wrong returned host fails the read preflight',async t=>{
  const f=await fixture(t), cancelled=f.seed('cancel-during-read');let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const p=await f.pipe({readGate:gate}), pending=f.reconnect(f.event(p));
  await until(()=>f.rows.some(row=>row.request.params.name==='read_thread'));persistCancellation(cancelled.directory);release();await pending;
  await until(()=>read(cancelled.path).status==='cancelled');assert.equal(f.rows.filter(row=>row.request.params.name==='send_message_to_thread').length,0);
  const wrong=f.seed('returned-host');const wrongHost=await f.pipe({host:'unexpected-host'});await f.reconnect(f.event(wrongHost));
  await until(()=>read(wrong.path).status==='delivery_failed');assert.match(read(wrong.path).error,/different host/);assert.equal(f.rows.filter(row=>row.request.params.name==='send_message_to_thread').length,0);await f.noPrompts();
});
