import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {control} from '../src/ipc.mjs';
import {bridgeClient} from '../src/bridge-client.mjs';
import {registerCallback, persistCancellation} from '../src/notify.mjs';

const exec = promisify(execFile);
const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const notify = fileURLToPath(new URL('../src/notify.mjs', import.meta.url));
async function until(fn) {
  for (let i = 0; i < 300; i++) {const value = await fn(); if (value) return value; await delay(25);}
  throw new Error('Isolated observer host deadline expired');
}

async function fixture(t, {desktop = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-observer-host-'));
  const state = join(root, 'state'), codex = join(root, 'codex'), directory = join(root, 'callback');
  mkdirSync(state);
  const env = {...process.env, DSH_SUBAGENT_STATE: state, DSH_SUBAGENT_CONFIG: join(root, 'config'), CODEX_HOME: codex, DSH_CLI: process.execPath};
  const events = join(root, 'desktop-events.jsonl');
  if (desktop) {
    const plugin = join(codex, 'plugins/cache/openai-bundled/codex-app-tools/fixture');
    mkdirSync(plugin, {recursive: true});
    writeFileSync(join(plugin, 'server.mjs'), `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);let result;
 if(r.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'isolated-desktop',version:'1'}};
 if(r.method==='tools/list')result={tools:['read_thread','send_message_to_thread'].map(name=>({name,inputSchema:{type:'object'}}))};
 if(r.method==='tools/call'){
  appendFileSync(${JSON.stringify(events)},JSON.stringify({pipe:process.env.CODEX_APP_TOOLS_PIPE_PATH,request:r})+'\\n');
  if(process.env.CODEX_APP_TOOLS_PIPE_PATH!=='fresh-pipe')result={isError:true,content:[{type:'text',text:'stale fixture pipe'}]};
  else result={content:[{type:'text',text:JSON.stringify(r.params.name==='read_thread'?{thread:{id:r.params.arguments.threadId,status:{type:'idle'}}}:{threadId:r.params.arguments.threadId})}]};
 }
 if(r.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:result||{}})+'\\n');
});`);
    env.CODEX_APP_TOOLS_PIPE_PATH = 'stale-daemon-pipe';
    delete env.DSH_DESKTOP_MCP_SERVER; delete env.DSH_DESKTOP_MCP_NODE;
  }
  const child = spawn(process.execPath, [server, '--daemon'], {env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  let diagnostics = ''; child.stderr.on('data', chunk => {diagnostics += chunk;});
  t.after(async () => {
    if (existsSync(join(directory, 'callback.json'))) {
      persistCancellation(directory);
      await until(() => !['watching', 'connecting', 'starting'].includes(JSON.parse(readFileSync(join(directory, 'callback.json'), 'utf8')).status)).catch(() => {});
    }
    if (child.exitCode === null) {await control('stop', {state, force: true}).catch(() => child.kill('SIGKILL')); await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(1500)]);}
    await delay(150); rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  });
  await until(async () => {try {return (await control('status', {state})).pid === child.pid;} catch {return false;}}).catch(error => {throw new Error(error.message + ': ' + diagnostics);});
  const seed = status => {
    const record = {id: 'synthetic-host-record', status, execution_id: 'original-execution', cwd: root, created_at: new Date().toISOString(), answer: status === 'completed' ? 'synthetic persisted result' : '', persisted: true};
    const db = new DatabaseSync(join(state, 'state.sqlite'));
    try {db.prepare('INSERT OR REPLACE INTO agents VALUES (?,?)').run(record.id, JSON.stringify(record));} finally {db.close();}
    return record;
  };
  return {root, state, directory, env, events, daemon: child, seed};
}

test('helper fails closed when no service is available instead of forking in the caller Job', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-no-observer-host-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  await assert.rejects(registerCallback({agent: 'synthetic', thread: 'fixture-parent', state: root, delivery: 'queue'}));
  assert.deepEqual(existsSync(join(root, 'callbacks')), false);
});

test('real daemon rejects caller executable overrides and alternate execution registries', async t => {
  const f = await fixture(t), record = f.seed('completed');
  const args = {agent: record.id, thread: 'fixture-parent', delivery: 'queue'};
  await assert.rejects(control('callback-register', {state: f.state, callback_args: args, callback_context: {DSH_DESKTOP_MCP_SERVER: 'untrusted.mjs'}}), /Invalid callback transport context/);
  await assert.rejects(control('callback-register', {state: f.state, callback_args: {...args, state: f.root}}), /Invalid callback registration arguments/);
  await assert.rejects(registerCallback({...args, state: f.state}, {temp: join(f.root, 'alternate-registry')}), /daemon execution registry/);
  assert.equal(existsSync(join(f.state, 'callbacks')), false);
  assert.deepEqual((await control('status', {state: f.state})).runtimes, []);
});

test('real daemon recovery uses fresh caller pipe and same saved result while caller executable overrides are excluded', async t => {
  const f = await fixture(t, {desktop: true}), record = f.seed('completed');
  mkdirSync(f.directory);
  const resultPath = join(f.directory, 'result.json');
  writeFileSync(resultPath, JSON.stringify({...record, agent_id: record.id, wait_outcome: 'settled'}));
  const saved = readFileSync(resultPath, 'utf8');
  writeFileSync(join(f.directory, 'callback.json'), JSON.stringify({agent_id: record.id, thread_id: 'fixture-parent', turn: record.execution_id, delivery: 'desktop-message', status: 'delivery_failed', delivery_state: 'not_sent', result_path: resultPath, pid: 99999999, error: 'old host pipe closed'}));
  const args = [notify, '--agent', record.id, '--thread', 'fixture-parent', '--turn', record.execution_id, '--state', f.state, '--output-dir', f.directory, '--delivery', 'desktop-message', '--recover-not-sent'];
  const receipt = JSON.parse((await exec(process.execPath, args, {env: {...f.env, CODEX_APP_TOOLS_PIPE_PATH: 'fresh-pipe', DSH_DESKTOP_MCP_SERVER: 'untrusted.mjs', DSH_DESKTOP_MCP_NODE: 'missing-node'}, timeout: 15000})).stdout);
  assert.equal(receipt.status, 'watching'); assert.equal(receipt.registrar_pid, f.daemon.pid);
  const accepted = await until(() => {const current = JSON.parse(readFileSync(join(f.directory, 'callback.json'), 'utf8')); return current.status === 'delivered' && current;});
  assert.equal(accepted.turn, record.execution_id); assert.equal(accepted.thread_id, 'fixture-parent');
  assert.equal(accepted.delivery_state, 'accepted'); assert.equal(accepted.recovery_history.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), JSON.parse(saved));
  const rows = readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.every(row => row.pipe === 'fresh-pipe'));
  assert.equal(rows.filter(row => row.request.params.name === 'send_message_to_thread').length, 1);
  await assert.rejects(exec(process.execPath, args, {env: {...f.env, CODEX_APP_TOOLS_PIPE_PATH: 'fresh-pipe'}}), /requires delivery_failed\/not_sent/);
  assert.deepEqual((await control('status', {state: f.state})).runtimes, []);
  const db = new DatabaseSync(join(f.state, 'state.sqlite'), {readOnly: true});
  try {assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='bridge/prompt'").get().n, 0);} finally {db.close();}
});

test('formal dsh_watch runs in the daemon and retains observation after the calling MCP connection closes', async t => {
  const f = await fixture(t, {desktop: true}), record = f.seed('running');
  const client = await bridgeClient(f.state);
  let registered;
  try {
    const reply = await client.request('tools/call', {name: 'dsh_watch', arguments: {agent_id: record.id}, _meta: {threadId: 'fixture-parent', dshCompletionMode: 'desktop-message', dshDesktopPipe: 'fresh-pipe'}});
    assert.ok(!reply.isError, JSON.stringify(reply));
    registered = JSON.parse(reply.content[0].text);
  } finally {client.close();}
  assert.equal(registered.status, 'watching'); assert.equal(registered.registrar_pid, f.daemon.pid);
  const callbackDirectory = join(registered.result_path, '..');
  await delay(150); assert.doesNotThrow(() => process.kill(registered.pid, 0));
  assert.equal(JSON.parse(readFileSync(join(callbackDirectory, 'callback.json'), 'utf8')).status, 'watching');
  const resumedClient = await bridgeClient(f.state);
  try {const reply = await resumedClient.request('tools/call', {name: 'dsh_close', arguments: {agent_id: record.id, legacy: true}}); assert.ok(!reply.isError);} finally {resumedClient.close();}
  await until(() => JSON.parse(readFileSync(join(callbackDirectory, 'callback.json'), 'utf8')).status === 'stopped');
  const result = JSON.parse(readFileSync(registered.result_path, 'utf8'));
  assert.equal(result.execution_id, record.execution_id); assert.equal(result.wait_outcome, 'settled');
  assert.equal(existsSync(f.events) && readFileSync(f.events, 'utf8').includes('send_message_to_thread'), false);
});

test('Windows kill-on-close caller Job ends its helper while the real daemon observer survives and saves the same execution', {skip: process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)}, async t => {
  const f = await fixture(t), record = f.seed('running');
  const helper = join(f.root, 'job-helper.mjs'), jobScript = join(f.root, 'caller-job.ps1');
  writeFileSync(helper, `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).once('line',async()=>{
 const {registerCallback}=await import(${JSON.stringify(new URL('../src/notify.mjs', import.meta.url).href)});
 const receipt=await registerCallback(${JSON.stringify({agent: record.id, thread: 'fixture-parent', turn: record.execution_id, state: f.state, 'output-dir': f.directory, delivery: 'queue'})});
 console.log(JSON.stringify({receipt,helper_pid:process.pid}));setInterval(()=>{},1000);
});`);
  writeFileSync(jobScript, `param([string]$Node,[string]$Helper)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ObserverJob {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr h,int c,IntPtr i,uint n);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr h,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
}
'@
$job=[ObserverJob]::CreateJobObject([IntPtr]::Zero,$null)
$info=[Runtime.InteropServices.Marshal]::AllocHGlobal(144)
$proc=$null
try {
 for($i=0;$i -lt 144;$i++){[Runtime.InteropServices.Marshal]::WriteByte($info,$i,0)}
 [Runtime.InteropServices.Marshal]::WriteInt32($info,16,0x2000)
 if(-not [ObserverJob]::SetInformationJobObject($job,9,$info,144)){throw 'Could not set kill-on-close Job'}
 $start=[Diagnostics.ProcessStartInfo]::new($Node)
 $start.ArgumentList.Add($Helper);$start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $proc=[Diagnostics.Process]::Start($start)
 if(-not [ObserverJob]::AssignProcessToJobObject($job,$proc.Handle)){throw 'Could not assign helper to caller Job'}
 $proc.StandardInput.WriteLine('register');$proc.StandardInput.Flush()
 $line=$proc.StandardOutput.ReadLine()
 if(-not $line){throw ('Helper failed: '+$proc.StandardError.ReadToEnd())}
 [Console]::WriteLine($line);[Console]::Out.Flush()
 [Console]::ReadLine() | Out-Null
 if(-not [ObserverJob]::CloseHandle($job)){throw 'Could not close caller Job'}
 $job=[IntPtr]::Zero
 if(-not $proc.WaitForExit(10000)){throw 'Caller Job did not end helper'}
} finally {
 if($job -ne [IntPtr]::Zero){[ObserverJob]::CloseHandle($job) | Out-Null}
 [Runtime.InteropServices.Marshal]::FreeHGlobal($info)
 if($proc){$proc.Dispose()}
}
`);
  const job = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', jobScript, process.execPath, helper], {env: f.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  let diagnostic = ''; job.stderr.on('data', chunk => {diagnostic += chunk;});
  const closed = new Promise(resolve => job.once('close', resolve));
  const lines = createInterface({input: job.stdout});
  t.after(async () => {job.stdin.end('\n'); await Promise.race([closed, delay(1000)]); if (job.exitCode === null) job.kill('SIGKILL'); lines.close();});
  let readyTimer;
  const registered = await Promise.race([new Promise((resolve, reject) => {lines.once('line', line => {try {resolve(JSON.parse(line));} catch (error) {reject(error);}}); job.once('error', reject); readyTimer=setTimeout(()=>reject(new Error('Caller Job registration deadline: ' + diagnostic)),20000);}), closed.then(code => {throw new Error('Caller Job ended before ready (' + code + '): ' + diagnostic);})]).finally(()=>clearTimeout(readyTimer));
  assert.equal(registered.receipt.status, 'watching'); assert.equal(registered.receipt.registrar_pid, f.daemon.pid);
  const parent = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(registered.receipt.pid)}").ParentProcessId`], {windowsHide: true});
  assert.equal(Number(parent.stdout.trim()), f.daemon.pid);
  job.stdin.end('\n'); assert.equal(await closed, 0, diagnostic);
  assert.throws(() => process.kill(registered.helper_pid, 0), error => error.code === 'ESRCH');
  assert.doesNotThrow(() => process.kill(registered.receipt.pid, 0));
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'callback.json'), 'utf8')).status, 'watching');
  const client = await bridgeClient(f.state);
  try {const reply = await client.request('tools/call', {name: 'dsh_close', arguments: {agent_id: record.id, legacy: true}}); assert.ok(!reply.isError);} finally {client.close();}
  await until(() => JSON.parse(readFileSync(join(f.directory, 'callback.json'), 'utf8')).status === 'stopped');
  const saved = JSON.parse(readFileSync(join(f.directory, 'result.json'), 'utf8'));
  assert.equal(saved.execution_id, record.execution_id); assert.equal(saved.status, 'closed'); assert.equal(saved.wait_outcome, 'settled');
  t.diagnostic(JSON.stringify({kind: 'windows-caller-job', helper_pid: registered.helper_pid, daemon_pid: f.daemon.pid, observer_pid: registered.receipt.pid, observer_parent_pid: Number(parent.stdout.trim()), helper_ended: true, observer_survived: true, execution_id: saved.execution_id, saved_status: saved.status}));
  assert.deepEqual((await control('status', {state: f.state})).runtimes, []);
  const db = new DatabaseSync(join(f.state, 'state.sqlite'), {readOnly: true});
  try {assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='bridge/prompt'").get().n, 0);} finally {db.close();}
});
