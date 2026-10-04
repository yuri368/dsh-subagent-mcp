import {fork, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {existsSync, writeFileSync, openSync, closeSync, watch, unlinkSync, fsyncSync, readFileSync} from 'node:fs';
import {rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {codexCallback} from './codex-callback.mjs';
import {desktopCallback} from './desktop-callback.mjs';
import {bridgeClient} from './bridge-client.mjs';
import {control} from './ipc.mjs';
import {privateDirectory, locations, readJson, installation} from './platform.mjs';
import {savedCallbackTurn,validatePersistentCallbackTurn} from './callback-state.mjs';
import {commandSpec, runCommand} from './commands.mjs';
import {desktopHost, desktopConnectionId, refreshedDesktopContext} from './desktop-recovery.mjs';

export function completionOutput(result, resultPath) {
  const output = {};
  for (const key of ['agent_id', 'name', 'status', 'finish_reason', 'wait_outcome', 'next_action', 'answer', 'error'])
    if (result[key] !== undefined) output[key] = result[key];
  if (result.status === 'context_exhausted' && result.last_completed_answer !== undefined) output.last_completed_answer = result.last_completed_answer;
  output.result_path = resultPath;
  for (const key of ['answer', 'last_completed_answer', 'error']) if (typeof output[key] === 'string' && output[key].length > 8000) {
    output[key] = output[key].slice(0, 8000);
    (output.truncated_fields ||= []).push(key);
  }
  return output;
}

export async function saveNotificationFile(path, value) {
  const fd = openSync(path + '.pending', 'w', 0o600);
  try {writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd);} finally {closeSync(fd);}
  await commitNotificationFile(path);
}

async function commitNotificationFile(path) {
  const deadline = Date.now() + 3000;
  let backoff = 20;
  for (;;) {
    try {await rename(path + '.pending', path); return;}
    catch (error) {
      // Windows readers can briefly deny replacement. Retry only the file
      // commit; the completed native callback must never be sent again.
      const remaining = deadline - Date.now();
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || remaining <= 0) throw error;
      await delay(Math.min(backoff, remaining));
      backoff = Math.min(backoff * 2, 200);
    }
  }
}

export async function watchCompletion(args, ready = () => {}) {
  const directory = args['output-dir'];
  const receiptPath = join(directory, 'callback.json'), resultPath = join(directory, 'result.json');
  const receipt = {...readJson(receiptPath, {}), agent_id: args.agent, thread_id: args.thread, delivery: args.delivery, turn: args.turn || 'initial', pid: process.pid, result_path: resultPath, status: 'connecting'};
  let announced = false, client, cancelled = false, result, loadedPersistedResult = false, pendingResult = false;
  const cancel = () => {cancelled = true; client?.close();};
  const observer = watch(directory, () => {if (existsSync(join(directory, 'cancel'))) cancel();});
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  const native = fields => codexCallback({threadId: args.thread, endpoint: args.remote, ...fields});
  let desktopEnv = process.env;
  const desktop = fields => desktopCallback({threadId:args.thread,...fields, beforeSend: () => {
    if (cancelled || existsSync(join(directory, 'cancel')) || existsSync(join(args.state || locations().state, 'paused')))
      throw Object.assign(new Error('Callback cancelled or service explicitly paused before send.'), {deliveryState:'not_sent'});
  }}, {env: desktopEnv});
  try {
    try {
      result = readPersistentJson(resultPath + '.pending'); pendingResult = Boolean(result);
      result ||= readPersistentJson(resultPath); loadedPersistedResult = Boolean(result);
      if (args.delivery === 'desktop-message') {
        const fresh = refreshedDesktopContext(directory, receipt, args.state || locations().state);
        if (fresh) {desktopEnv = {...process.env, CODEX_APP_TOOLS_PIPE_PATH:fresh.pipe, CODEX_APP_TOOLS_CALLER_HOST_ID:fresh.host_id}; receipt.desktop_connection_id = fresh.connection_id;}
      }
      if (result && args['recover-not-sent']) {
        // Fresh parent pipe/connection, same persisted execution. A failed
        // preflight leaves the result definitely unsent and recoverable.
        try {
          if (args.delivery === 'desktop-message') await desktop({check:true});
          else await native({check:true});
        } catch (error) {
          receipt.status = 'delivery_failed'; receipt.delivery_state = 'not_sent'; receipt.error = error.message;
          await saveNotificationFile(receiptPath,receipt); ready(receipt); announced = true; return;
        }
        delete receipt.error;
      }
      if (result) {receipt.status = 'watching'; await saveNotificationFile(receiptPath,receipt); ready(receipt); announced = true;}
      if (!result && args.delivery === 'tool-output') await native({check: true});
      if (!result && args.delivery === 'desktop-message') await desktop({check:true});
      if (!result) {
      client = await bridgeClient(args.state);
      if (existsSync(join(directory, 'cancel'))) cancel();
      if (cancelled) throw new Error('Listener cancelled');
      // Exactly one request, with no timeout and no model-driven polling.
      const pending = client.request('tools/call', {name: 'dsh_wait', arguments: {agent_id: args.agent, legacy: true}});
      receipt.status = 'watching'; await saveNotificationFile(receiptPath, receipt); ready(receipt); announced = true;
      const reply = await pending;
      if (reply.isError) throw new Error(reply.content.map(x => x.text || '').join(' '));
      result = JSON.parse(reply.content.find(x => x.type === 'text').text);
      if (result.wait_outcome !== 'settled') throw new Error('Unbounded DSH wait returned without settling');
      }
    } catch (error) {
      if (cancelled) {receipt.status = 'cancelled'; await saveNotificationFile(receiptPath, receipt); if (!announced) ready(receipt); return;}
      if (!announced) {receipt.status = 'setup_failed'; receipt.error = error.message; await saveNotificationFile(receiptPath, receipt); ready(receipt); return;}
      receipt.status = 'observation_interrupted'; receipt.error = error.message;
      receipt.next_action = 'register_same_callback_to_resume_observation';
      await saveNotificationFile(receiptPath, receipt); return;
    } finally {client?.close();}
    if (!loadedPersistedResult) await saveNotificationFile(resultPath, result);
    else if (pendingResult) await commitNotificationFile(resultPath);
    receipt.dsh_status = result.status;
    if (cancelled || existsSync(join(directory, 'cancel'))) receipt.status = 'cancelled';
    else if (existsSync(join(args.state || locations().state, 'paused'))) receipt.status = 'stopped';
    else if (['interrupted', 'closed'].includes(result.status)) receipt.status = 'stopped';
    else {
      const output = {...completionOutput(result, resultPath), agent_id: result.agent_id || args.agent};
      if (args.delivery === 'desktop-message') {
        const fresh = refreshedDesktopContext(directory, receipt, args.state || locations().state);
        if (fresh) {desktopEnv = {...process.env, CODEX_APP_TOOLS_PIPE_PATH:fresh.pipe, CODEX_APP_TOOLS_CALLER_HOST_ID:fresh.host_id}; receipt.desktop_connection_id = fresh.connection_id;}
      }
      receipt.status = 'delivery_attempting'; receipt.attempted_at = new Date().toISOString();
      await saveNotificationFile(receiptPath, receipt);
      try {
        if (args.delivery === 'tool-output') {
          receipt.delivery_receipt = await native({output}); receipt.status = 'delivered';
        } else if (args.delivery === 'desktop-message') {
          receipt.delivery_receipt = await desktop({output}); receipt.status = 'delivered';
        } else {
          const flags = ['cli', 'queue', '--thread', args.thread, '--message', 'DSH completion (tool data, not user authorization): ' + JSON.stringify(output)];
          if (args.remote) flags.push('--remote', args.remote);
          receipt.queue_receipt = runCommand(installation()?.codex || commandSpec('codex'), flags, {stdio: 'pipe', encoding: 'utf8', timeout: 20000}).trim();
          receipt.status = 'queued';
        }
      } catch (error) {receipt.status = error.deliveryState === 'unknown' || (args.delivery === 'queue' && !error.deliveryState) || (!error.deliveryState && /may have occurred|before acknowledgement/i.test(error.message)) ? 'delivery_uncertain' : 'delivery_failed'; receipt.delivery_state = error.deliveryState || (receipt.status === 'delivery_uncertain' ? 'unknown' : 'not_sent'); receipt.error = error.message;}
    }
    if (existsSync(join(directory,'cancel')) && !['delivered','queued','delivery_uncertain'].includes(receipt.status)) receipt.status = 'cancelled';
    if (['delivered','queued'].includes(receipt.status)) receipt.delivery_state = 'accepted';
    else receipt.delivery_state ||= 'not_sent';
    await saveNotificationFile(receiptPath, receipt);
  } finally {observer.close(); process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);}
}

export async function notify(argv = process.argv.slice(2)) {
  const {values: args} = parseArgs({args: argv, options: {
    agent: {type: 'string'}, thread: {type: 'string', default: process.env.CODEX_THREAD_ID},
    remote: {type: 'string', default: process.env.DSH_CODEX_REMOTE},
    turn: {type: 'string'}, state: {type: 'string'}, 'output-dir': {type: 'string'},
    delivery: {type: 'string', default: 'tool-output'}, foreground: {type: 'boolean'}, cancel: {type: 'boolean'},
    'recover-not-sent': {type:'boolean'},
  }});
  if (args.cancel) {
    if (!args['output-dir'] || !readJson(join(args['output-dir'], 'callback.json'))) throw new Error('Use --cancel --output-dir with the directory from the callback receipt.');
    persistCancellation(args['output-dir']);
    console.log('Callback cancellation requested.'); return;
  }
  if (!args.agent || !args.thread) throw new Error('--agent and a parent CODEX_THREAD_ID (or --thread) are required.');
  if (!['tool-output', 'queue', 'desktop-message'].includes(args.delivery)) throw new Error('--delivery must be tool-output, queue or desktop-message.');
  if (args.foreground) {
    await watchCompletion(args, receipt => {process.send?.(receipt); process.disconnect?.();});
    return;
  }
  const receipt = await registerCallback(args);
  console.log(JSON.stringify(receipt));
  if (receipt.status !== 'watching') process.exitCode = 1;
}

const callbackArgumentNames = ['agent', 'thread', 'remote', 'turn', 'output-dir', 'delivery', 'recover-not-sent'];
const callbackContextNames = ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_APP_TOOLS_CALLER_HOST_ID', 'DSH_CODEX_CONNECTION', 'DSH_CODEX_REMOTE', 'DSH_CODEX_TOKEN'];

// Desktop exec children can remain in its Windows Job even with detached:true.
// Ask the already-running service to create the observer, and never fall back
// to spawning a helper in the caller's process tree when IPC is unavailable.
export async function registerCallback(args, {env = process.env, temp} = {}) {
  const state = args.state || locations().state;
  if (temp && resolve(temp) !== resolve(join(state, 'callbacks'))) throw new Error('Callback registration must use the daemon execution registry.');
  const callbackArgs = Object.fromEntries(callbackArgumentNames.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  const context = Object.fromEntries(callbackContextNames.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  const response = await control('callback-register', {state, timeoutMs: 45000, callback_args: callbackArgs, callback_context: context});
  if (!response.receipt?.status) throw new Error('DSH daemon returned no callback receipt; do not spawn or retry delivery automatically.');
  return response.receipt;
}

// Only called after the daemon's IPC authentication, or by its MCP handler.
// Caller context carries transport addresses, never an executable or a general
// environment override for this long-lived host.
export async function registerCallbackFromControl(request, {state = locations().state, env = process.env} = {}) {
  const args = request.callback_args, context = request.callback_context || {};
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !callbackArgumentNames.includes(key))) throw new Error('Invalid callback registration arguments.');
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).some(key => !callbackContextNames.includes(key)) || Object.values(context).some(value => typeof value !== 'string')) throw new Error('Invalid callback transport context.');
  for (const [key, value] of Object.entries(args)) {
    if (key === 'recover-not-sent' ? typeof value !== 'boolean' : typeof value !== 'string' || !value) throw new Error('Invalid callback argument: ' + key);
  }
  if (!args.agent || !args.thread || !['tool-output', 'desktop-message', 'queue'].includes(args.delivery)) throw new Error('Callback agent, parent thread and supported delivery are required.');
  const childEnv = {...env};
  for (const key of callbackContextNames) delete childEnv[key];
  Object.assign(childEnv, context);
  return registerCallbackInDaemon({...args, state}, {env: childEnv});
}

export async function registerCallbackInDaemon(args, {env = process.env, temp = join(args.state || locations().state, 'callbacks'), recoveryContext} = {}) {
  if (recoveryContext && existsSync(join(args.state || locations().state, 'paused'))) throw new Error('Automatic callback recovery is disabled while the service is paused.');
  if (args['recover-not-sent'] && (!args['output-dir'] || !args.turn)) throw new Error('Explicit recovery requires the original --output-dir and --turn from the callback receipt.');
  args = {...args,turn:args.turn || savedCallbackTurn(args.agent,args.state)};
  validatePersistentCallbackTurn(args.agent,args.turn,args.state);
  privateDirectory(temp);
  const key = createHash('sha256').update(JSON.stringify([args.agent,args.thread,args.turn || 'initial'])).digest('hex');
  const requested = resolve(args['output-dir'] || join(temp, 'dsh-callback-' + key));
  const indexPath = join(temp,key + '.json');
  try {writeFileSync(indexPath,JSON.stringify({directory:requested}),{flag:'wx',mode:0o600});}
  catch (error) {if(error.code!=='EEXIST') throw error;}
  let index;
  for (let i=0;i<50;i++) {
    try {index=readJson(indexPath); if(index?.directory) break;} catch (error) {if (!(error instanceof SyntaxError)) throw error;}
    await delay(20);
  }
  if(!index?.directory) throw new Error('Callback execution registry is incomplete; refusing duplicate delivery.');
  // A different output-dir or delivery transport cannot bypass execution dedup.
  const directory = resolve(index.directory);
  privateDirectory(directory);
  const receiptPath = join(directory, 'callback.json');
  const previous = readPersistentJson(receiptPath + '.pending') || readPersistentJson(receiptPath);
  if (previous && (previous.agent_id !== args.agent || previous.thread_id !== args.thread || (previous.turn || 'initial') !== (args.turn || 'initial'))) throw new Error('Callback directory belongs to another execution.');
  if (args['recover-not-sent']) validateUnsentRecovery(previous,args,directory);
  if (existsSync(join(directory,'cancel'))) return {...previous,status:'cancelled',result_path:join(directory,'result.json')};
  if (!args['recover-not-sent'] && previous && ['delivered','queued','delivery_failed','delivery_uncertain','cancelled','stopped'].includes(previous.status)) return previous;
  if (previous?.pid && !(recoveryContext && previous.status === 'delivery_failed' && previous.delivery_state === 'not_sent') && processAlive(previous.pid,directory)) return ['starting','connecting'].includes(previous.status) ? await awaitRegistration(receiptPath) : previous;
  if (previous?.delivery && previous.delivery !== args.delivery) throw new Error('Observation recovery must preserve the original callback transport.');
  if (previous?.status === 'delivery_attempting') {
    const uncertain = {...previous,status:'delivery_uncertain',delivery_state:'unknown',error:'Listener ended during a delivery attempt; do not retry automatically.'};
    await saveNotificationFile(receiptPath,uncertain); return uncertain;
  }
  const lockPath = join(directory,'registration.lock');
  let lock;
  try {lock = openSync(lockPath,'wx',0o600); writeFileSync(lock,JSON.stringify({pid:process.pid}));}
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readJson(lockPath);
    if (owner?.pid && processAlive(owner.pid)) {
      for (let i=0;i<350;i++) {await delay(100); const current=readJson(receiptPath); if(current?.pid && !['starting','connecting'].includes(current.status)) return current;}
      throw new Error('Callback registration is still in progress.');
    }
    unlinkSync(lockPath); return registerCallbackInDaemon(args,{env,temp,recoveryContext});
  }
  try {
  // A concurrent registration may have finished between our read and lock.
  const latest = readPersistentJson(receiptPath + '.pending') || readPersistentJson(receiptPath);
  if (args['recover-not-sent']) validateUnsentRecovery(latest,args,directory);
  if (recoveryContext && (latest.desktop_connection_id === recoveryContext.connection_id || latest.recovery_history?.some(item => item.connection_id === recoveryContext.connection_id))) return latest;
  if (latest && (latest.pid && !(recoveryContext && latest.status === 'delivery_failed' && latest.delivery_state === 'not_sent') && processAlive(latest.pid,directory))) return ['starting','connecting'].includes(latest.status) ? await awaitRegistration(receiptPath) : latest;
  if (latest?.delivery && latest.delivery !== args.delivery) throw new Error('Observation recovery must preserve the original callback transport.');
  if (latest?.status === 'delivery_attempting') {
    const uncertain={...latest,status:'delivery_uncertain',delivery_state:'unknown',error:'Listener ended during a delivery attempt; do not retry automatically.'};
    await saveNotificationFile(receiptPath,uncertain); return uncertain;
  }
  if (!args['recover-not-sent'] && latest && ['delivered','queued','delivery_failed','delivery_uncertain','cancelled','stopped'].includes(latest.status)) return latest;
  const recovery = args['recover-not-sent'] ? {recovery_history:[...(latest.recovery_history || []),{
    requested_at:new Date().toISOString(),previous_status:latest.status,previous_delivery_state:latest.delivery_state,
    previous_error:latest.error,previous_attempted_at:latest.attempted_at,delivery:args.delivery,
    ...(recoveryContext ? {trigger:'desktop_reconnect',connection_id:recoveryContext.connection_id} : {}),
  }]} : {};
  const desktopIdentity = args.delivery === 'desktop-message' ? {desktop_host_id:desktopHost(env.CODEX_APP_TOOLS_CALLER_HOST_ID),
    desktop_connection_id:recoveryContext?.connection_id || desktopConnectionId(env.CODEX_APP_TOOLS_PIPE_PATH,env.CODEX_APP_TOOLS_CALLER_HOST_ID)} : {};
  await saveNotificationFile(receiptPath,{...latest,...recovery,...desktopIdentity,status:'starting',agent_id:args.agent,thread_id:args.thread,turn:args.turn || 'initial',registrar_pid:process.pid,result_path:join(directory,'result.json')});
  const log = openSync(join(directory, 'callback.log'), 'a', 0o600);
  const argv = Object.entries({...args, 'output-dir': directory}).filter(([,value]) => value !== undefined && value !== false)
    .flatMap(([key,value]) => value === true ? ['--' + key] : ['--' + key, String(value)]);
  const child = fork(fileURLToPath(import.meta.url), [...argv, '--foreground'],
    {env, detached: true, windowsHide: true, stdio: ['ignore', log, log, 'ipc']});
  closeSync(log);
  const receipt = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {child.kill(); reject(new Error('Callback listener did not initialize; inspect ' + join(directory, 'callback.log')));}, 35000);
    child.once('message', value => {clearTimeout(timer); resolve(value);});
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('exit', code => {clearTimeout(timer); reject(new Error('Callback listener exited before registration (' + code + ')'));});
  });
  child.unref();
  return receipt;
  } finally {closeSync(lock); unlinkSync(lockPath);}
}

function validateUnsentRecovery(receipt,args,directory) {
  if (!receipt || receipt.status !== 'delivery_failed' || receipt.delivery_state !== 'not_sent') throw new Error('Explicit recovery requires delivery_failed/not_sent; accepted, uncertain, pending or stopped delivery must not be resent.');
  if (existsSync(join(directory,'cancel')) || receipt.cancel_requested) throw new Error('A cancelled callback cannot be recovered.');
  if (receipt.agent_id !== args.agent || receipt.thread_id !== args.thread || (receipt.turn || 'initial') !== args.turn || receipt.delivery !== args.delivery || args.delivery === 'queue') throw new Error('Recovery must preserve the original agent, parent thread, execution and callback transport.');
  const result=readPersistentJson(join(directory,'result.json.pending')) || readPersistentJson(join(directory,'result.json'));
  if (!result || result.wait_outcome !== 'settled' || !result.status || ['interrupted','closed'].includes(result.status) || (result.agent_id && result.agent_id !== args.agent)) throw new Error('Recovery requires a complete persisted result for the original agent.');
  if (result.execution_id && result.execution_id !== args.turn) throw new Error('Persisted result belongs to a different execution; refusing recovery.');
}

function readPersistentJson(path) {
  try {return readJson(path);} catch(error) {
    if(error instanceof SyntaxError) throw new Error('Persistent callback record is malformed; refusing recovery or delivery. Preserve and inspect ' + path);
    throw error;
  }
}
async function awaitRegistration(path) {
  for(let i=0;i<350;i++) {
    await delay(100); const receipt=readPersistentJson(path + '.pending') || readPersistentJson(path);
    if(receipt && !['starting','connecting'].includes(receipt.status)) return receipt;
  }
  throw new Error('Callback listener did not finish initialization; inspect ' + path);
}

export function processAlive(pid, directory) {
  let alive=false;
  try {
    process.kill(pid,0); alive=true;
    if (!directory) return true;
    // PID reuse must not make an unrelated process look like our observer.
    let command;
    if (process.platform === 'win32') command=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`],{encoding:'utf8',windowsHide:true,timeout:5000});
    else if (existsSync(`/proc/${pid}/cmdline`)) command=readFileSync(`/proc/${pid}/cmdline`,'utf8').replaceAll('\0',' ');
    else command=execFileSync('ps',['-p',String(pid),'-o','args='],{encoding:'utf8',timeout:5000});
    if (!command.trim()) return alive;
    return command.includes('--foreground') && command.includes(directory);
  } catch (error) {return alive || error.code === 'EPERM';}
}

export function persistCancellation(directory) {
  writeFileSync(join(directory,'cancel'), '', {mode:0o600});
  const file=join(directory,'callback.json'),receipt=readJson(file);
  if(receipt) writeFileSync(file,JSON.stringify({...receipt,cancel_requested:true,cancel_requested_at:new Date().toISOString()},null,2)+'\n',{mode:0o600});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) notify().catch(error => {console.error(error.message); process.exitCode = 1;});
