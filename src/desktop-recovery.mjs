import {createHash, randomUUID} from 'node:crypto';
import {existsSync, readdirSync, realpathSync, lstatSync, watch} from 'node:fs';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {control} from './ipc.mjs';
import {privateDirectory, readJson} from './platform.mjs';
import {validatePersistentCallbackTurn} from './callback-state.mjs';
import {registerCallbackInDaemon, saveNotificationFile} from './notify.mjs';

export const desktopHost = value => value || 'local';
export const callbackRegistryKey = receipt => createHash('sha256').update(JSON.stringify([receipt.agent_id, receipt.thread_id, receipt.turn || 'initial'])).digest('hex');
export const desktopConnectionId = (pipe, host) => createHash('sha256').update(JSON.stringify([pipe, desktopHost(host)])).digest('hex');

// This is emitted once when the fresh stdio frontend connects, including when
// Desktop has not supplied any thread metadata yet. It carries no executables.
export function desktopReconnectEvent(env = process.env) {
  if (!env.CODEX_APP_TOOLS_PIPE_PATH) return null;
  return {pipe: env.CODEX_APP_TOOLS_PIPE_PATH, host_id: desktopHost(env.CODEX_APP_TOOLS_CALLER_HOST_ID),
    started_at: Date.now(), connection_id: randomUUID(), ...(env.CODEX_THREAD_ID ? {thread_id: env.CODEX_THREAD_ID} : {})};
}
export function announceDesktopReconnect(event, state) {
  return control('desktop-reconnect', {state, desktop_context: event, timeoutMs: 45000});
}

function persistent(path) {return readJson(path + '.pending') || readJson(path);}
function paused(state) {return existsSync(join(state, 'paused'));}
function stoppedAgent(agent, state) {
  if (!existsSync(join(state, 'state.sqlite'))) return false;
  const db = new DatabaseSync(join(state, 'state.sqlite'), {readOnly: true});
  try {
    const row = db.prepare('SELECT data FROM agents WHERE id=?').get(agent);
    if (!row) return true;
    return ['interrupted', 'interrupting', 'closed'].includes(JSON.parse(row.data).status);
  } finally {db.close();}
}
function identityMatches(receipt, context) {
  return context && receipt.delivery === 'desktop-message' && context.agent_id === receipt.agent_id &&
    context.thread_id === receipt.thread_id && context.turn === (receipt.turn || 'initial') &&
    desktopHost(receipt.desktop_host_id) === context.host_id;
}

// Called by an already-owned observer immediately before delivery. Nothing from
// a different execution, parent or host can replace that observer's transport.
export function refreshedDesktopContext(directory, receipt, state) {
  if (paused(state) || existsSync(join(directory, 'cancel')) || receipt.cancel_requested) return null;
  for (const suffix of ['', '.pending']) if (existsSync(join(directory, 'desktop-context.json' + suffix)) && lstatSync(join(directory, 'desktop-context.json' + suffix)).isSymbolicLink()) return null;
  const context = persistent(join(directory, 'desktop-context.json'));
  return identityMatches(receipt, context) ? context : null;
}

export function createDesktopRecovery({state, env = process.env, diagnostic = message => console.error('DSH Desktop recovery: ' + message)}) {
  const observers = new Map(), pending = new Map();
  let events = Promise.resolve(), closed = false;
  const directoryRoot = join(state, 'callbacks');
  function records() {
    if (!existsSync(directoryRoot)) return [];
    return readdirSync(directoryRoot).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
      try {
        const indexPath = join(directoryRoot,name);
        if (lstatSync(indexPath).isSymbolicLink()) return [];
        const index = readJson(indexPath);
        if (!index?.directory || typeof index.directory !== 'string') return [];
        const directory = resolve(index.directory);
        if (['callback.json','callback.json.pending','result.json','result.json.pending','desktop-context.json','desktop-context.json.pending']
          .some(file => existsSync(join(directory,file)) && lstatSync(join(directory,file)).isSymbolicLink())) return [];
        const receipt = persistent(join(directory, 'callback.json'));
        if (!receipt || callbackRegistryKey(receipt) + '.json' !== name) return [];
        if (directory !== resolve(join(directoryRoot,'dsh-callback-' + name.slice(0,-5))) || lstatSync(directory).isSymbolicLink()) return [];
        const canonical = resolve(join(realpathSync(directoryRoot),'dsh-callback-' + name.slice(0,-5)));
        const actual = realpathSync(directory);
        if (process.platform === 'win32' ? actual.toLowerCase() !== canonical.toLowerCase() : actual !== canonical) return [];
        return [{directory, receipt}];
      } catch (error) {diagnostic('Registry record preserved and skipped: ' + error.message); return [];}
    });
  }
  function eligible(record, context) {
    const {directory, receipt} = record;
    if (paused(state) || stoppedAgent(receipt.agent_id,state) || existsSync(join(directory, 'cancel')) || receipt.cancel_requested || receipt.remote ||
      receipt.delivery !== 'desktop-message' || desktopHost(receipt.desktop_host_id) !== context.host_id ||
      (context.thread_id && receipt.thread_id !== context.thread_id)) return false;
    // An old RC4 receipt without host metadata only represents the local host.
    if (!receipt.desktop_host_id && context.host_id !== 'local') return false;
    if (!['starting', 'connecting', 'watching', 'delivery_attempting', 'delivery_failed'].includes(receipt.status)) return false;
    if (receipt.status === 'delivery_failed' && receipt.delivery_state !== 'not_sent') return false;
    validatePersistentCallbackTurn(receipt.agent_id, receipt.turn || 'initial', state);
    return true;
  }
  async function attempt(directory) {
    if (closed || paused(state)) return;
    const registered = records().find(record => record.directory === directory);
    if (!registered) return;
    const receipt = registered.receipt;
    if (!receipt || stoppedAgent(receipt.agent_id,state)) return;
    const context = refreshedDesktopContext(directory, receipt || {}, state);
    if (!context || receipt.status !== 'delivery_failed' || receipt.delivery_state !== 'not_sent') return;
    if (receipt.desktop_connection_id === context.connection_id || receipt.recovery_history?.some(item => item.connection_id === context.connection_id)) return;
    // Register performs the settled-result, durable execution and cancellation
    // validation again under its existing process-wide registration lock.
    const childEnv = {...env, CODEX_APP_TOOLS_PIPE_PATH: context.pipe, CODEX_APP_TOOLS_CALLER_HOST_ID: context.host_id};
    for (const key of ['DSH_CODEX_CONNECTION', 'DSH_CODEX_REMOTE', 'DSH_CODEX_TOKEN', 'DSH_DESKTOP_MCP_SERVER', 'DSH_DESKTOP_MCP_NODE']) delete childEnv[key];
    await registerCallbackInDaemon({agent: receipt.agent_id, thread: receipt.thread_id, turn: receipt.turn || 'initial',
      delivery: 'desktop-message', state, 'output-dir': directory, 'recover-not-sent': true},
    {env: childEnv, recoveryContext: context});
  }
  function schedule(directory) {
    if (pending.has(directory)) return pending.get(directory);
    const task = attempt(directory).catch(error => diagnostic('Execution preserved and skipped: ' + error.message))
      .finally(() => {
        pending.delete(directory);
        try {
          const receipt = persistent(join(directory,'callback.json'));
          if (receipt && !['starting','connecting','watching','delivery_attempting'].includes(receipt.status)) {
            observers.get(directory)?.close(); observers.delete(directory);
          }
        } catch {observers.get(directory)?.close(); observers.delete(directory);}
      });
    pending.set(directory, task); return task;
  }
  function observe(directory) {
    if (observers.has(directory)) return;
    const observer = watch(directory, (_event, filename) => {
      // File commit is the event, not a timed scan. This also covers an older
      // surviving observer that cannot read RC5's fresh transport context.
      if (filename === null || String(filename) === 'callback.json' || String(filename) === 'cancel') schedule(directory);
    });
    observer.on('error', error => diagnostic('Callback file observation ended: ' + error.message));
    observers.set(directory, observer);
  }
  async function reconnect(request) {
    const context = request.desktop_context;
    if (!context || typeof context !== 'object' || Array.isArray(context) ||
      Object.keys(context).some(key => !['pipe', 'host_id', 'started_at', 'connection_id', 'thread_id'].includes(key)) ||
      !['pipe', 'host_id', 'connection_id'].every(key => typeof context[key] === 'string' && context[key]) ||
      (context.thread_id !== undefined && (typeof context.thread_id !== 'string' || !context.thread_id)) ||
      !Number.isSafeInteger(context.started_at) || context.started_at <= 0 || context.started_at > Date.now() + 10000) throw new Error('Invalid fresh Desktop connection context.');
    const task = events.then(async () => {
      if (closed || paused(state)) return {status: 'paused', selected: 0};
      const connections = join(state, 'desktop-connections'); privateDirectory(connections);
      const path = join(connections, createHash('sha256').update(context.host_id).digest('hex') + '.json');
      const previous = persistent(path);
      if (previous && (previous.started_at > context.started_at || previous.connection_id === context.connection_id)) return {status: 'stale_or_duplicate', selected: 0};
      await saveNotificationFile(path, context);
      let selected = 0;
      for (const record of records()) {
        try {
          if (!eligible(record, context)) continue;
          const fresh = {...context, agent_id: record.receipt.agent_id, thread_id: record.receipt.thread_id, turn: record.receipt.turn || 'initial'};
          await saveNotificationFile(join(record.directory, 'desktop-context.json'), fresh);
          observe(record.directory); selected++;
          await schedule(record.directory);
        } catch (error) {diagnostic('Execution preserved and skipped: ' + error.message);}
      }
      return {status: 'registered', selected};
    });
    events = task.catch(() => {}); return task;
  }
  return {reconnect, close() {closed = true; for (const observer of observers.values()) observer.close(); observers.clear();}};
}
