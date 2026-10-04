import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {commandSpec} from './commands.mjs';
import {installation, locations} from './platform.mjs';
import {routeCodex, requireExecutableRouting} from './model-routing.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'];
const ownerKey = owner => createHash('sha256').update(owner).digest('hex');

export function codexWorkerEnvironment(env) {
  const worker = {...env};
  for (const name of Object.keys(worker)) if (name.startsWith('CODEX_APP_TOOLS_') || [
    'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_PERMISSION_PROFILE', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'DSH_CODEX_CONNECTION', 'DSH_CODEX_TOKEN', 'DSH_CODEX_REMOTE', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  ].includes(name)) delete worker[name];
  return worker;
}

export function delegationPolicy(permission, cwd) {
  if (!PERMISSIONS.includes(permission)) throw new Error('Codex delegation requires a known parent permission; refusing to widen access.');
  if (permission === 'read-only') return {type: 'readOnly', networkAccess: false};
  if (permission === 'workspace-write') return {type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true};
  return {type: 'dangerFullAccess'};
}

function acquireLock(path) {
  let fd;
  try {fd = openSync(path, 'wx', 0o600);}
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const record = JSON.parse(readFileSync(path, 'utf8'));
    try {process.kill(record.pid, 0);}
    catch (probe) {
      if (probe.code !== 'ESRCH') throw error;
      unlinkSync(path);
      fd = openSync(path, 'wx', 0o600);
    }
    if (fd === undefined) throw new Error('This Codex delegation is already running; do not submit the task twice.');
  }
  writeFileSync(fd, JSON.stringify({pid: process.pid}));
  return () => {closeSync(fd); unlinkSync(path);};
}

class AppServer {
  constructor(spec, cwd, env, onEvent) {
    const [file, ...prefix] = spec;
    this.pending = new Map(); this.seq = 0; this.stderr = ''; this.onEvent = onEvent;
    this.child = spawn(file, [...prefix, '-c', 'features.apps=false', '-c', 'web_search="disabled"', 'app-server', '--listen', 'stdio://'], {cwd, env: codexWorkerEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    this.exit = new Promise(resolve => this.child.once('exit', resolve));
    this.child.stderr.on('data', chunk => {this.stderr = (this.stderr + chunk).slice(-4000);});
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {this.exited = true; this.fail(new Error(`Codex App Server exited (${code ?? signal}).`));});
    this.child.stdin.on('error', error => this.fail(error));
    this.lines = createInterface({input: this.child.stdout});
    this.lines.on('line', line => {
      let message;
      try {message = JSON.parse(line);} catch {this.fail(new Error('Codex App Server emitted invalid JSON.')); return;}
      if (message.method && message.id !== undefined) {
        // This bridge has no interactive approval surface. Unexpected requests
        // must fail explicitly rather than granting extra permissions or hanging.
        this.send({id: message.id, error: {code: -32601, message: 'Interactive requests are unavailable for DSH Codex delegation.'}});
        return;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
        return;
      }
      this.onEvent?.(message);
      if (message.method === 'turn/completed') this.completion?.resolve(message.params);
    });
  }
  send(message) {if (!this.exited) this.child.stdin.write(JSON.stringify(message) + '\n');}
  fail(error) {
    for (const pending of this.pending.values()) {clearTimeout(pending.timer); pending.reject(error);}
    this.pending.clear(); this.completion?.reject(error);
  }
  request(method, params, timeoutMs = 60000) {
    if (this.exited) return Promise.reject(new Error('Codex App Server is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {this.pending.delete(id); reject(new Error(`Codex ${method} timed out; the task must not be replayed automatically.`));}, timeoutMs);
      this.pending.set(id, {resolve, reject, timer}); this.send({id, method, params});
    });
  }
  async close() {
    this.lines.close(); this.child.stdin.end();
    if (this.exited) return;
    const timer = setTimeout(() => this.child.kill(), 3000);
    await this.exit; clearTimeout(timer);
  }
}

// Each call owns a separate supported stdio App Server, never the Desktop
// conversation. Persisted thread IDs are usable only by their original DSH
// session and cwd. Resume reapplies the current parent's permission every time.
export async function delegateCodex({task, cwd, permission, owner, threadId, model, effort, taskKind}, {
  spec = installation()?.codex || commandSpec('codex', {explicit: process.env.DSH_CODEX_CLI}),
  env = process.env, state = join(locations().state, 'codex-delegations'), signal,
  timeoutMs = 3600000, onEvent,
} = {}) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('Codex task must be nonempty.');
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('Codex delegation requires a parent DSH session.');
  if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error('Codex delegation requires an existing absolute parent cwd.');
  cwd = realpathSync(cwd);
  delegationPolicy(permission, cwd);
  if (threadId !== undefined && !UUID.test(threadId)) throw new Error('Invalid Codex delegation thread ID.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Codex delegation timeout must be positive.');
  signal?.throwIfAborted();
  const directory = join(state, ownerKey(owner)); mkdirSync(directory, {recursive: true, mode: 0o700});
  let prior;
  if (threadId) {
    const path = join(directory, threadId + '.json');
    if (!existsSync(path)) throw new Error('This Codex thread is not owned by the calling DSH session.');
    prior = JSON.parse(readFileSync(path, 'utf8'));
    if (prior.owner !== owner || prior.cwd !== cwd) throw new Error('Codex delegation owner or cwd mismatch.');
  }
  const unlock = acquireLock(join(directory, (threadId || 'start') + '.lock'));
  let routing;
  try {
    // Re-read after acquiring the lock; another process may have just settled.
    if (threadId) prior = JSON.parse(readFileSync(join(directory, threadId + '.json'), 'utf8'));
    routing = routeCodex({taskKind, model, effort, prior, env});
    // Fail before spawning a worker, resuming a thread or charging a model turn.
    // No environment/config flag can opt out of this production boundary.
    requireExecutableRouting(routing);
  } catch (error) {unlock(); throw error;}
  const selectedModel = routing.model, selectedEffort = routing.effort;
  const workerPermission = permission;
  const sandboxPolicy = delegationPolicy(workerPermission, cwd);
  const server = new AppServer(spec, cwd, env, onEvent);
  let started, turnId, timer, abortListener, unlockThread, save, isolation;
  const messages = new Map();
  const observe = server.onEvent;
  server.onEvent = message => {
    observe?.(message);
    if (message.method === 'item/completed' && message.params?.threadId === threadId && message.params.item.type === 'agentMessage')
      messages.set(message.params.item.id, message.params.item);
  };
  try {
    await server.request('initialize', {clientInfo: {name: 'dsh_codex_delegate', version: '1.0.0'}, capabilities: {}});
    server.send({method: 'initialized'});
    if (selectedModel) {
      const models = await server.request('model/list', {});
      if (!models.data?.some(candidate => candidate.model === selectedModel || candidate.id === selectedModel))
        throw new Error(`Codex model ${selectedModel} is unavailable for this account.`);
    }
    const effective = await server.request('config/read', {includeLayers: true, cwd});
    const config = {};
    // Config overrides interpret keys as dotted paths, not TOML-quoted paths.
    // Refuse unusual IDs instead of accidentally creating a second transport.
    for (const layer of effective.layers || []) for (const name of Object.keys(layer.config?.mcp_servers || {})) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Cannot safely disable an inherited MCP server with an unsupported ID.');
      config[`mcp_servers.${name}.enabled`] = false;
    }
    for (const layer of effective.layers || []) for (const name of Object.keys(layer.config?.plugins || {})) {
      if (!/^[A-Za-z0-9_@/-]+$/.test(name)) throw new Error('Cannot safely disable an inherited plugin with an unsupported ID.');
      config[`plugins.${name}.enabled`] = false;
    }
    started = await server.request(threadId ? 'thread/resume' : 'thread/start', {
      ...(threadId ? {threadId} : {ephemeral: false}), ...(selectedModel ? {model: selectedModel} : {}), cwd, sandbox: workerPermission, approvalPolicy: 'never', config,
      developerInstructions: 'You are a Codex worker delegated by a DSH agent. Complete only the supplied bounded task within the supplied cwd and sandbox. Do not delegate back to DSH or use external app connectors. Return the result and relevant evidence to the calling tool.',
    });
    threadId = started.thread.id;
    if (!UUID.test(threadId)) throw new Error('Codex returned an invalid thread ID.');
    if (started.model !== selectedModel) throw new Error('Codex did not accept the selected routing model.');
    if (started.sandbox?.type !== sandboxPolicy.type || started.approvalPolicy !== 'never')
      throw new Error('Codex did not accept the parent sandbox and non-escalating approval policy.');
    const inventory = await server.request('mcpServerStatus/list', {threadId});
    if (!Array.isArray(inventory.data) || inventory.nextCursor || inventory.data.some(row => row.runtimeStatus !== 'disabled' || Object.keys(row.tools || {}).length || row.resources?.length || row.resourceTemplates?.length))
      throw new Error('Codex worker still exposes inherited MCP servers; refusing recursive or expanded delegation.');
    isolation = {mcp_server_count: 0, configured_mcp_server_count: inventory.data.length, mcp_inventory: inventory.data.map(row => ({name: row.name, runtime_status: row.runtimeStatus, tool_count: Object.keys(row.tools || {}).length})), effective_sandbox: started.sandbox, turn_sandbox: sandboxPolicy, approval_policy: started.approvalPolicy, parent_context_removed: true};
    // A newly minted ID becomes resumable before its first turn settles. Hold
    // its lock too, so another caller cannot race the original worker turn.
    if (!existsSync(join(directory, threadId + '.json'))) unlockThread = acquireLock(join(directory, threadId + '.lock'));
    // Persist before dispatch: an acknowledgement loss does not erase ownership
    // or justify starting another worker for the same task.
    const recordPath = join(directory, threadId + '.json');
    const history = [...(prior?.routing_history || []), routing];
    // Keep legacy evidence if present for historical record compatibility; new
    // delegations no longer generate Astra eligibility or upgrade metadata.
    save = extra => writeFileSync(recordPath, JSON.stringify({owner, cwd, permission: workerPermission, thread_id: threadId, rollout_path: started.thread.path, model: started.model, routing, routing_history: history, ...(prior?.sol_attempt ? {sol_attempt: prior.sol_attempt} : {}), isolation, ...extra}, null, 2) + '\n', {mode: 0o600});
    save({status: 'starting'});
    const completed = new Promise((resolve, reject) => {server.completion = {resolve, reject};});
    // A transport failure can precede awaiting completion below.
    completed.catch(() => {});
    const cancel = reason => {
      if (turnId) server.request('turn/interrupt', {threadId, turnId}, 5000).catch(() => {});
      server.completion.reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    abortListener = () => cancel(signal.reason || new Error('Codex delegation interrupted.'));
    signal?.addEventListener('abort', abortListener, {once: true});
    timer = setTimeout(() => cancel(new Error('Codex delegation timed out; do not replay the task automatically.')), timeoutMs);
    signal?.throwIfAborted();
    const accepted = await server.request('turn/start', {threadId, input: [{type: 'text', text: task}], ...(selectedEffort ? {effort: selectedEffort} : {}), cwd, approvalPolicy: 'never', sandboxPolicy});
    turnId = accepted.turn.id; save({status: 'running', turn_id: turnId});
    const settled = await completed;
    if (settled.threadId !== threadId || settled.turn.id !== turnId) throw new Error('Codex completion does not match the delegated turn.');
    for (const item of settled.turn.items || []) if (item.type === 'agentMessage') messages.set(item.id, item);
    const finals = [...messages.values()].filter(item => item.phase === 'final_answer');
    const answer = (finals.length ? finals : [...messages.values()].filter(item => item.phase !== 'commentary')).map(item => item.text).join('\n');
    const result = {thread_id: threadId, turn_id: turnId, status: settled.turn.status, answer, model: started.model, cwd, permission: workerPermission, routing};
    if (settled.turn.error) result.error = settled.turn.error.message || JSON.stringify(settled.turn.error);
    save(result); return result;
  } catch (error) {
    save?.({status: signal?.aborted ? 'interrupted' : 'error', ...(turnId ? {turn_id: turnId} : {}), error: error.message});
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abortListener);
    try {await server.close();} finally {unlockThread?.(); unlock();}
  }
}
