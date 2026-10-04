import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import net from 'node:net';
import {createInterface} from 'node:readline';
import {mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {privateDirectory, temporaryDirectory, writeJson} from '../src/platform.mjs';
import {saveNotificationFile,registerCallback,registerCallbackFromControl} from '../src/notify.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../src/notify.mjs', import.meta.url));
const thread = '01a0e5c5-cdae-7101-9d53-228035271cfe';

async function lockReplacement(file, directory) {
  const ps = join(directory, 'hold-file.ps1');
  writeFileSync(ps, `param([string]$Target)
$ErrorActionPreference = 'Stop'
try {
  $stream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    [Console]::WriteLine('locked')
    [Console]::Out.Flush()
    [Console]::ReadLine() | Out-Null
  } finally { $stream.Dispose() }
  exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`);
  // The trusted fixture also runs on Windows hosts with Restricted policy.
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, file], {windowsHide: true});
  let error = '';
  child.stderr.on('data', chunk => {error += chunk;});
  const closed = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({input: child.stdout});
  await new Promise((resolve, reject) => {
    lines.once('line', line => line === 'locked' ? resolve() : reject(new Error(line)));
    child.once('error', reject);
    closed.then(code => reject(new Error(`File lock exited before readiness (${code}): ${error}`)));
  });
  return async () => {child.stdin.end('\n'); assert.equal(await closed, 0, error); lines.close();};
}

async function fixture(t) {
  const root = privateDirectory(mkdtempSync(join(temporaryDirectory(), 'dsh-node-notify-')));
  const state = privateDirectory(join(root, 'state'));
  const sockets = new Set(), requests = [], waits = new Map(), directories = [];
  const callbackControls = [], callbackHostEnv = {...process.env};
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    createInterface({input: socket}).on('error',()=>{}).on('line', line => {
      const request = JSON.parse(line);
      if (request.authenticate) {assert.equal(request.authenticate, 'fixture-token'); return;}
      if (request.bridge_control === 'callback-register') {
        callbackControls.push(request);
        registerCallbackFromControl(request, {state, env: callbackHostEnv})
          .then(receipt => socket.end(JSON.stringify({receipt}) + '\n'))
          .catch(error => socket.end(JSON.stringify({error: error.message}) + '\n'));
        return;
      }
      requests.push(request);
      if (request.method === 'initialize') socket.write(JSON.stringify({id: request.id, result: {protocolVersion: '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1'}}}) + '\n');
      else if (request.method === 'tools/call') waits.set(request.params.arguments.agent_id, {socket, id: request.id});
    });
  });
  await new Promise(resolve => server.listen(process.platform === 'win32' ? {host: '127.0.0.1', port: 0} : join(state, 'server.sock'), resolve));
  if (process.platform === 'win32') writeJson(join(state, 'endpoint.json'), {port: server.address().port, token: 'fixture-token'});
  const ws = new WebSocketServer({host: '127.0.0.1', port: 0});
  await new Promise(resolve => ws.once('listening', resolve));
  const calls = [];
  const flags = {missingParent: false, deliveryFailure: false};
  ws.on('connection', socket => socket.on('message', data => {
    const req = JSON.parse(data); calls.push(req);
    if (req.method === 'initialize') socket.send(JSON.stringify({id: req.id, result: {}}));
    if (req.method === 'thread/read') socket.send(JSON.stringify(flags.missingParent ? {id: req.id, error: {message: 'Unknown parent'}} : {id: req.id, result: {thread: {id: thread, status: {type: 'idle'}}}}));
    if (req.method === 'turn/start') socket.send(JSON.stringify(flags.deliveryFailure ? {id: req.id, error: {message: 'fixture delivery failure'}} : {id: req.id, result: {turn: {id: 'turn-1', status: 'inProgress'}}}));
  }));
  const endpoint = 'ws://127.0.0.1:' + ws.address().port;
  const launch = async (agent, extra = [], env = process.env) => {
    const directory = join(root, agent); directories.push(directory);
    const args = [script, '--agent', agent, '--thread', thread, '--state', state, '--remote', endpoint, '--output-dir', directory, ...extra];
    const result = await exec(process.execPath, args, {timeout: 15000, env});
    return {directory, args, receipt: JSON.parse(result.stdout)};
  };
  const until = async (directory, status) => {
    for (let i = 0; i < 250; i++) {
      const receipt = JSON.parse(readFileSync(join(directory, 'callback.json'), 'utf8'));
      if (receipt.status === status) return receipt;
      await delay(20);
    }
    assert.fail('Callback did not reach ' + status + ': ' + readFileSync(join(directory, 'callback.json'), 'utf8'));
  };
  const complete = (agent, status = 'completed', fields = {}) => {
    const {socket, id} = waits.get(agent);
    socket.write(JSON.stringify({id, result: {content: [{type: 'text', text: JSON.stringify({agent_id: agent, status, wait_outcome: 'settled', answer: 'evidence', ...fields})}]}}) + '\n');
  };
  t.after(async () => {
    for (const directory of directories) {
      if (!existsSync(join(directory, 'callback.json'))) continue;
      const receipt = JSON.parse(readFileSync(join(directory, 'callback.json'), 'utf8'));
      if (['watching', 'connecting'].includes(receipt.status)) {writeFileSync(join(directory, 'cancel'), ''); await until(directory, 'cancelled').catch(()=>{});}
    }
    for (const socket of sockets) socket.destroy();
    for (const socket of ws.clients) socket.terminate();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => ws.close(resolve))]);
    // Detached children release their log handles as they exit on Windows.
    await delay(100);
    rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  });
  return {root, state, launch, until, complete, calls, requests, waits, flags, endpoint, directories, callbackControls, callbackHostEnv};
}

test('Node helper asks its bridge host to detach a listener, waits once, and sends native completion', async t => {
  const f = await fixture(t), run = await f.launch('one');
  assert.equal(run.receipt.status, 'watching');
  assert.equal(run.receipt.registrar_pid, process.pid);
  assert.equal(f.callbackControls.length, 1);
  await delay(100);
  assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 0);
  assert.deepEqual(f.requests.filter(x => x.method === 'tools/call').map(x => x.params), [{name: 'dsh_wait', arguments: {agent_id: 'one', legacy: true}}]);
  f.complete('one'); await f.until(run.directory, 'delivered');
  const output = JSON.parse(f.calls.find(x => x.method === 'turn/start').params.toolOutput.output);
  assert.equal(output.answer, 'evidence'); assert.equal(output.result_path, join(run.directory, 'result.json'));
});

test('Windows receipt replacement recovers after a reader releases its handle without repeating delivery', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t), run = await f.launch('locked');
  const release = await lockReplacement(join(run.directory, 'callback.json'), run.directory);
  try {
    f.complete('locked');
    const pending = join(run.directory, 'callback.json.pending');
    for (let i = 0; i < 100 && !existsSync(pending); i++) await delay(20);
    assert.ok(existsSync(pending), 'The acknowledged receipt must be retained while replacement is blocked');
    await delay(250);
    assert.equal(JSON.parse(readFileSync(pending, 'utf8')).status, 'delivery_attempting');
    assert.equal(JSON.parse(readFileSync(join(run.directory, 'callback.json'), 'utf8')).status, 'watching');
    assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 0);
  } finally {await release();}
  const receipt = await f.until(run.directory, 'delivered');
  assert.equal(receipt.delivery_receipt.turn_id, 'turn-1');
  assert.equal(existsSync(join(run.directory, 'callback.json.pending')), false);
  assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 1);
  assert.equal(f.requests.filter(x => x.method === 'tools/call').length, 1);
});

test('Windows replacement stops after its deadline and preserves the pending receipt', {skip: process.platform !== 'win32'}, async t => {
  const root = mkdtempSync(join(temporaryDirectory(), 'dsh-receipt-lock-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const file = join(root, 'callback.json');
  writeFileSync(file, JSON.stringify({status: 'watching'}));
  const release = await lockReplacement(file, root);
  try {
    const start = Date.now();
    await assert.rejects(saveNotificationFile(file, {status: 'delivered', delivery_receipt: {turn_id: 'turn-1'}}), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    assert.ok(Date.now() - start < 5000, 'A held file must not cause an unbounded wait');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'watching');
    assert.equal(JSON.parse(readFileSync(file + '.pending', 'utf8')).delivery_receipt.turn_id, 'turn-1');
  } finally {await release();}
});

test('independent listeners allow a fast task to return while another is pending', async t => {
  const f = await fixture(t), slow = await f.launch('slow'), fast = await f.launch('fast');
  f.complete('fast'); await f.until(fast.directory, 'delivered');
  assert.equal(JSON.parse(readFileSync(join(slow.directory, 'callback.json'), 'utf8')).status, 'watching');
});

test('cancel command stops notification without interrupting the DSH task', async t => {
  const f = await fixture(t), run = await f.launch('one');
  await exec(process.execPath, [script, '--cancel', '--output-dir', run.directory]);
  await f.until(run.directory, 'cancelled');
  assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 0);
  assert.equal(f.requests.some(x => x.params?.name === 'dsh_interrupt'), false);
});

test('closed and interrupted tasks do not notify; error and context exhaustion do', async t => {
  const f = await fixture(t);
  for (const status of ['closed', 'interrupted', 'error', 'context_exhausted']) {
    const run = await f.launch(status); f.complete(status, status);
    await f.until(run.directory, ['closed', 'interrupted'].includes(status) ? 'stopped' : 'delivered');
  }
  assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 2);
});

test('delivery failure retains the full result without retrying or using queue', async t => {
  const f = await fixture(t), run = await f.launch('one'); f.flags.deliveryFailure = true;
  f.complete('one'); const receipt = await f.until(run.directory, 'delivery_failed');
  assert.match(receipt.error, /fixture delivery failure/);
  assert.ok(existsSync(join(run.directory, 'result.json')));
  assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 1);
});

test('unknown parent fails preflight before DSH wait registration', async t => {
  const f = await fixture(t); f.flags.missingParent = true;
  await assert.rejects(f.launch('one'));
  assert.equal(f.requests.length, 0);
  await f.until(join(f.root, 'one'), 'setup_failed');
});

test('duplicate registration preserves the original receipt', async t => {
  const f = await fixture(t), run = await f.launch('one');
  const original = readFileSync(join(run.directory, 'callback.json'), 'utf8');
  assert.equal(JSON.parse((await exec(process.execPath, run.args)).stdout).status,'watching');
  assert.equal(readFileSync(join(run.directory, 'callback.json'), 'utf8'), original);
});

test('long answers are truncated only inline and keep their full saved evidence', async t => {
  const f = await fixture(t), run = await f.launch('one'), answer = 'x'.repeat(12000);
  f.complete('one', 'completed', {answer, last_completed_answer: answer}); await f.until(run.directory, 'delivered');
  const output = JSON.parse(f.calls.find(x => x.method === 'turn/start').params.toolOutput.output);
  assert.equal(output.answer.length, 8000); assert.deepEqual(output.truncated_fields, ['answer']);
  assert.equal(output.last_completed_answer, undefined);
  assert.equal(JSON.parse(readFileSync(join(run.directory, 'result.json'), 'utf8')).answer, answer);
});

function desktopFixture(f, loseAck=false) {
  const server=join(f.root,'desktop-server.mjs'),messages=join(f.root,'desktop-messages.jsonl');
  writeFileSync(server,`import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
if(process.env.CODEX_APP_TOOLS_PIPE_PATH==='missing')process.exit(1);
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);let result;
 if(r.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'desktop-fixture',version:'1'}};
 if(r.method==='tools/list')result={tools:['read_thread','send_message_to_thread'].map(name=>({name,inputSchema:{type:'object'}}))};
 if(r.method==='tools/call'){
  if(r.params.name==='send_message_to_thread')appendFileSync(${JSON.stringify(messages)},JSON.stringify(r)+'\\n');
  if(${loseAck}&&r.params.name==='send_message_to_thread')process.exit(0);
  const value=r.params.name==='read_thread'?{thread:{id:r.params.arguments.threadId,status:{type:'idle'}}}:{threadId:r.params.arguments.threadId};
  result={content:[{type:'text',text:JSON.stringify(value)}]};
 }
 if(r.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:result||{}})+'\\n');
});`);
  f.callbackHostEnv.DSH_DESKTOP_MCP_SERVER=server;
  return {messages,env:{...process.env,CODEX_APP_TOOLS_PIPE_PATH:'fixture',DSH_DESKTOP_MCP_SERVER:server}};
}

test('explicit recovery sends only the persisted unsent result through the refreshed Desktop pipe',async t=>{
 const f=await fixture(t),desktop=desktopFixture(f),directory=join(f.root,'desktop-recover');privateDirectory(directory);f.directories.push(directory);
 const receipt={agent_id:'desktop-recover',thread_id:thread,turn:'original-execution',delivery:'desktop-message',status:'delivery_failed',delivery_state:'not_sent',pid:99999999,error:'old pipe closed',result_path:join(directory,'result.json')};
 writeJson(join(directory,'callback.json'),receipt);writeJson(join(directory,'result.json'),{agent_id:'desktop-recover',status:'completed',wait_outcome:'settled',answer:'persisted result'});
 const args=[script,'--agent','desktop-recover','--thread',thread,'--turn','original-execution','--state',f.state,'--output-dir',directory,'--delivery','desktop-message','--recover-not-sent'];
 const first=JSON.parse((await exec(process.execPath,args,{env:desktop.env})).stdout);assert.equal(first.status,'watching');
 const delivered=await f.until(directory,'delivered');assert.equal(delivered.delivery_state,'accepted');assert.equal(delivered.recovery_history.length,1);assert.equal(delivered.recovery_history[0].previous_error,'old pipe closed');
 assert.equal(f.requests.length,0);const rows=readFileSync(desktop.messages,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.length,1);assert.match(rows[0].params.arguments.prompt,/persisted result/);
 await assert.rejects(exec(process.execPath,args,{env:desktop.env}),/requires delivery_failed\/not_sent/);
 assert.equal(readFileSync(desktop.messages,'utf8').trim().split('\n').length,1);
});

test('manual recovery preflight failure stays not_sent and its next explicit recovery is audited',async t=>{
 const f=await fixture(t),desktop=desktopFixture(f),directory=join(f.root,'preflight-recover');privateDirectory(directory);f.directories.push(directory);
 writeJson(join(directory,'callback.json'),{agent_id:'preflight-recover',thread_id:thread,turn:'original',delivery:'desktop-message',status:'delivery_failed',delivery_state:'not_sent',pid:99999999});
 writeJson(join(directory,'result.json'),{agent_id:'preflight-recover',status:'completed',wait_outcome:'settled',answer:'persisted'});
 const args=[script,'--agent','preflight-recover','--thread',thread,'--turn','original','--state',f.state,'--output-dir',directory,'--delivery','desktop-message','--recover-not-sent'];
 await assert.rejects(exec(process.execPath,args,{env:{...desktop.env,CODEX_APP_TOOLS_PIPE_PATH:'missing'}}));
 const failed=await f.until(directory,'delivery_failed');assert.equal(failed.delivery_state,'not_sent');assert.equal(failed.recovery_history.length,1);assert.equal(existsSync(desktop.messages),false);
 await delay(150);
 await exec(process.execPath,args,{env:desktop.env});const delivered=await f.until(directory,'delivered');assert.equal(delivered.recovery_history.length,2);assert.equal(f.requests.length,0);
});

test('manual recovery rejects uncertainty, stop, transport changes and incomplete results',async t=>{
 const f=await fixture(t),directory=join(f.root,'recovery-refuse');privateDirectory(directory);
 const base={agent_id:'recovery-refuse',thread_id:thread,turn:'original',delivery:'desktop-message',status:'delivery_failed',delivery_state:'not_sent',pid:99999999};
 const args={agent:'recovery-refuse',thread,turn:'original',state:f.state,'output-dir':directory,delivery:'desktop-message','recover-not-sent':true};
 for(const patch of [{status:'delivery_uncertain',delivery_state:'unknown'},{status:'delivered',delivery_state:'accepted'},{status:'cancelled'},{delivery:'tool-output'},{cancel_requested:true}]){
  writeJson(join(directory,'callback.json'),{...base,...patch});writeJson(join(directory,'result.json'),{agent_id:base.agent_id,status:'completed',wait_outcome:'settled'});await assert.rejects(registerCallback(args));
 }
 writeJson(join(directory,'callback.json'),base);writeJson(join(directory,'result.json'),{agent_id:base.agent_id,status:'completed'});await assert.rejects(registerCallback(args),/complete persisted result/);assert.equal(f.requests.length,0);assert.equal(f.calls.length,0);
});

test('concurrent explicit recovery shares one locked listener and never double sends',async t=>{
 const f=await fixture(t),desktop=desktopFixture(f),directory=join(f.root,'concurrent-recover');privateDirectory(directory);f.directories.push(directory);
 writeJson(join(directory,'callback.json'),{agent_id:'concurrent-recover',thread_id:thread,turn:'original',delivery:'desktop-message',status:'delivery_failed',delivery_state:'not_sent',pid:99999999});
 writeJson(join(directory,'result.json'),{agent_id:'concurrent-recover',status:'completed',wait_outcome:'settled',answer:'fixture'});
 const args=[script,'--agent','concurrent-recover','--thread',thread,'--turn','original','--state',f.state,'--output-dir',directory,'--delivery','desktop-message','--recover-not-sent'];
 await Promise.allSettled([exec(process.execPath,args,{env:desktop.env}),exec(process.execPath,args,{env:desktop.env})]);await f.until(directory,'delivered');
 assert.equal(readFileSync(desktop.messages,'utf8').trim().split('\n').length,1);assert.equal(f.requests.length,0);
});

test('manual recovery acknowledgement loss becomes unknown and cannot be recovered again',async t=>{
 const f=await fixture(t),desktop=desktopFixture(f,true),directory=join(f.root,'recover-acklost');privateDirectory(directory);f.directories.push(directory);
 writeJson(join(directory,'callback.json'),{agent_id:'recover-acklost',thread_id:thread,turn:'original',delivery:'desktop-message',status:'delivery_failed',delivery_state:'not_sent',pid:99999999});
 writeJson(join(directory,'result.json'),{agent_id:'recover-acklost',status:'completed',wait_outcome:'settled',answer:'fixture'});
 const args=[script,'--agent','recover-acklost','--thread',thread,'--turn','original','--state',f.state,'--output-dir',directory,'--delivery','desktop-message','--recover-not-sent'];
 await exec(process.execPath,args,{env:desktop.env});const uncertain=await f.until(directory,'delivery_uncertain');assert.equal(uncertain.delivery_state,'unknown');assert.equal(uncertain.recovery_history.length,1);
 await assert.rejects(exec(process.execPath,args,{env:desktop.env}),/requires delivery_failed\/not_sent/);assert.equal(readFileSync(desktop.messages,'utf8').trim().split('\n').length,1);assert.equal(f.requests.length,0);
});

test('an explicit helper --turn cannot bypass unknown external execution identity',async t=>{
 const f=await fixture(t),db=new DatabaseSync(join(f.state,'state.sqlite'));db.exec('CREATE TABLE agents(id TEXT PRIMARY KEY,data TEXT)');
 try {
 db.prepare('INSERT INTO agents VALUES (?,?)').run('external-unknown',JSON.stringify({id:'external-unknown',external:true,execution_identity_state:'unknown',created_at:'legacy-date'}));
 await assert.rejects(exec(process.execPath,[script,'--agent','external-unknown','--thread',thread,'--turn','invented','--state',f.state,'--remote',f.endpoint]),/execution identity is unknown/);assert.equal(f.requests.length,0);assert.equal(f.calls.length,0);
 } finally {db.close();}
});

test('Desktop message listener waits once and sends only after the DSH completion event',async t=>{
  const f=await fixture(t),desktop=desktopFixture(f);
  const run=await f.launch('desktop-complete',['--delivery','desktop-message'],desktop.env);
  assert.equal(run.receipt.status,'watching');assert.equal(run.receipt.delivery,'desktop-message');
  assert.equal(existsSync(desktop.messages),false);
  f.complete('desktop-complete');
  const receipt=await f.until(run.directory,'delivered');
  assert.equal(receipt.delivery_receipt.thread_id,thread);
  assert.equal(f.requests.filter(x=>x.method==='tools/call').length,1);
  const sent=readFileSync(desktop.messages,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(sent.length,1);assert.equal(sent[0].params.arguments.threadId,thread);
  assert.equal(f.calls.filter(x=>x.method==='turn/start').length,0);
});

test('Desktop message listener cancellation preserves the DSH task and sends no message',async t=>{
  const f=await fixture(t),desktop=desktopFixture(f);
  const run=await f.launch('desktop-cancel',['--delivery','desktop-message'],desktop.env);
  writeFileSync(join(run.directory,'cancel'),'');
  await f.until(run.directory,'cancelled');
  assert.equal(existsSync(desktop.messages),false);
  assert.deepEqual(f.requests.filter(x=>x.method==='tools/call').map(x=>x.params.name),['dsh_wait']);
});

test('lost observer process can resume the same wait without replaying a prompt',async t=>{
  const f=await fixture(t),run=await f.launch('observer-death');
  process.kill(run.receipt.pid,'SIGKILL');
  await delay(150);
  const changed=[...run.args,'--delivery','desktop-message'];
  await assert.rejects(exec(process.execPath,changed),/preserve the original callback transport/);
  const resumed=JSON.parse((await exec(process.execPath,run.args)).stdout);
  assert.equal(resumed.status,'watching');assert.notEqual(resumed.pid,run.receipt.pid,JSON.stringify({run,resumed,requests:f.requests}));
  f.complete('observer-death');await f.until(run.directory,'delivered');
  assert.deepEqual(f.requests.filter(x=>x.method==='tools/call').map(x=>x.params.name),['dsh_wait','dsh_wait']);
  assert.equal(f.calls.filter(x=>x.method==='turn/start').length,1);
});
test('persistent delivery_attempting after process death is uncertain and never resent',async t=>{
  const f=await fixture(t),directory=join(f.root,'attempt-death');
  privateDirectory(directory);
  writeJson(join(directory,'callback.json'),{agent_id:'attempt-death',thread_id:thread,turn:'initial',status:'delivery_attempting',pid:99999999,result_path:join(directory,'result.json')});
  writeJson(join(directory,'result.json'),{agent_id:'attempt-death',status:'completed',answer:'fixture result'});
  await assert.rejects(exec(process.execPath,[script,'--agent','attempt-death','--thread',thread,'--state',f.state,'--remote','ws://127.0.0.1:1','--output-dir',directory]));
  assert.equal(JSON.parse(readFileSync(join(directory,'callback.json'),'utf8')).status,'delivery_uncertain');
  assert.equal(f.requests.length,0);assert.equal(f.calls.length,0);
});

test('Desktop lost acknowledgement is durable and duplicate registration never sends again',async t=>{
 const f=await fixture(t),desktop=desktopFixture(f,true),run=await f.launch('desktop-ack-lost',['--delivery','desktop-message'],desktop.env);
 f.complete('desktop-ack-lost');const receipt=await f.until(run.directory,'delivery_uncertain');
 assert.equal(receipt.delivery_state,'unknown');assert.ok(existsSync(join(run.directory,'result.json')));
 await assert.rejects(exec(process.execPath,run.args,{env:desktop.env}),e=>JSON.parse(e.stdout).status==='delivery_uncertain');
 assert.equal(readFileSync(desktop.messages,'utf8').trim().split('\n').length,1);
 const switched=[...run.args];switched[switched.indexOf('--delivery')+1]='queue';
 await assert.rejects(exec(process.execPath,switched,{env:desktop.env}),e=>JSON.parse(e.stdout).status==='delivery_uncertain');
 assert.equal(f.requests.filter(x=>x.method==='tools/call').length,1);
});
test('alternate output directory cannot register another callback for the same execution',async t=>{
 const f=await fixture(t),run=await f.launch('same-execution');
 const alternate=[...run.args];alternate[alternate.indexOf('--output-dir')+1]=join(f.root,'alternate');
 const duplicate=JSON.parse((await exec(process.execPath,alternate)).stdout);
 assert.equal(duplicate.result_path,run.receipt.result_path);assert.equal(duplicate.pid,run.receipt.pid);
 f.complete('same-execution');await f.until(run.directory,'delivered');
 assert.equal(f.requests.filter(x=>x.method==='tools/call').length,1);assert.equal(f.calls.filter(x=>x.method==='turn/start').length,1);
});

test('alive connecting observer is awaited until readiness rather than returned early',async t=>{
 const f=await fixture(t),directory=join(f.root,'connecting'),scriptPath=join(f.root,'idle-observer.mjs');privateDirectory(directory);
 writeFileSync(scriptPath,'setInterval(()=>{},1000);');
 const child=spawn(process.execPath,[scriptPath,'--foreground',directory],{windowsHide:true,stdio:'ignore'});
 t.after(()=>child.kill('SIGKILL'));
 writeJson(join(directory,'callback.json'),{agent_id:'connecting',thread_id:thread,status:'connecting',pid:child.pid});
 const timer=setTimeout(()=>writeJson(join(directory,'callback.json'),{agent_id:'connecting',thread_id:thread,status:'watching',pid:child.pid}),1500);
 try{const receipt=await registerCallback({agent:'connecting',thread,state:f.state,'output-dir':directory,delivery:'queue'});assert.equal(receipt.status,'watching');assert.equal(receipt.pid,child.pid);}finally{clearTimeout(timer);child.kill('SIGKILL');}
});
test('malformed pending receipt fails closed and preserves saved evidence',async t=>{
 const f=await fixture(t),directory=join(f.root,'malformed');privateDirectory(directory);
 writeJson(join(directory,'callback.json'),{agent_id:'malformed',thread_id:thread,status:'watching',pid:99999999});
 writeFileSync(join(directory,'callback.json.pending'),'{');writeJson(join(directory,'result.json'),{answer:'saved evidence'});
 await assert.rejects(registerCallback({agent:'malformed',thread,state:f.state,'output-dir':directory,delivery:'queue'}),/malformed; refusing recovery/);
 assert.equal(readFileSync(join(directory,'callback.json.pending'),'utf8'),'{');assert.equal(JSON.parse(readFileSync(join(directory,'result.json'),'utf8')).answer,'saved evidence');assert.equal(f.requests.length,0);
});

test('direct helper without --turn reads persistent followup generation and permits its new completion',async t=>{
 const f=await fixture(t),db=new DatabaseSync(join(f.state,'state.sqlite'));db.exec('CREATE TABLE agents(id TEXT PRIMARY KEY,data TEXT)');
 const agent='helper-followup';
 try {
 const setTurn=turn=>db.prepare('INSERT OR REPLACE INTO agents VALUES (?,?)').run(agent,JSON.stringify({id:agent,execution_id:turn}));
 const args=[script,'--agent',agent,'--thread',thread,'--state',f.state,'--remote',f.endpoint];
 setTurn('execution-first');const first=JSON.parse((await exec(process.execPath,args)).stdout);f.directories.push(join(first.result_path,'..'));
 assert.equal(first.turn,'execution-first');f.complete(agent);await f.until(join(first.result_path,'..'),'delivered');
 setTurn('execution-followup');const next=JSON.parse((await exec(process.execPath,args)).stdout);f.directories.push(join(next.result_path,'..'));
 assert.equal(next.turn,'execution-followup');assert.notEqual(next.result_path,first.result_path);
 f.complete(agent);await f.until(join(next.result_path,'..'),'delivered');assert.equal(f.calls.filter(x=>x.method==='turn/start').length,2);
 } finally {db.close();}
});
