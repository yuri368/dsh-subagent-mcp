import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {delegateCodex, delegationPolicy, codexWorkerEnvironment} from '../src/codex-delegate.mjs';

const ID = '01a11111-1111-7111-8111-111111111111';
function fixture(t, mode = 'completed') {
  const root = mkdtempSync(join(tmpdir(), 'codex-delegate-'));
  const cli = join(root, 'server.mjs'), calls = join(root, 'calls.jsonl');
  writeFileSync(cli, `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({launch:process.argv.slice(2)})+'\\n');
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+'\\n');
 if(m.id===undefined)return;
 if(m.method==='initialize')return out({id:m.id,result:{}});
 if(m.method==='config/read')return out({id:m.id,result:{layers:[{config:{mcp_servers:{dsh_subagent:{command:'unused'},test_server:{command:'unused'}},plugins:{'worker-plugin@example':{enabled:true}}}}]}});
 if(m.method==='model/list')return out({id:m.id,result:{data:['gpt-6-luna','gpt-6.1-sol','gpt-6-astra'].map(model=>({id:model,model}))}});
 if(m.method==='thread/start'||m.method==='thread/resume')return out({id:m.id,result:{thread:{id:${JSON.stringify(ID)}},model:m.params.model||'configured-default',approvalPolicy:'never',sandbox:{type:m.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly'}}});
 if(m.method==='mcpServerStatus/list')return out({id:m.id,result:{data:${mode === 'unsafe-mcp' ? "[{name:'inherited',runtimeStatus:'connected',tools:{dangerous:{}}}]" : "[{name:'disabled-server',runtimeStatus:'disabled',tools:{},resources:[],resourceTemplates:[]}]"}}});
 if(m.method==='turn/start'){
   out({id:m.id,result:{turn:{id:'turn-1'}}});
   out({method:'turn/started',params:{threadId:${JSON.stringify(ID)},turn:{id:'turn-1'}}});
   if(${JSON.stringify(mode)}==='pending')return;
   out({method:'item/completed',params:{threadId:${JSON.stringify(ID)},turnId:'turn-1',item:{id:'progress',type:'agentMessage',phase:'commentary',text:'progress is not final'}}});
   out({method:'turn/completed',params:{threadId:${JSON.stringify(ID)},turn:{id:'turn-1',status:${JSON.stringify(mode)},items:[{id:'final',type:'agentMessage',phase:'final_answer',text:'result-42'}],error:${mode === 'failed' ? "{message:'real failure'}" : 'null'}}}});
   return;
 }
 if(m.method==='turn/interrupt')return out({id:m.id,result:{}});
 out({id:m.id,error:{message:'unsupported'}});
});`);
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {root, options: {spec: [process.execPath, cli], state: join(root, 'state')}, calls: () => readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)};
}

test('Codex delegation uses public requests, parent sandbox and configured default; resumes only owned threads', async t => {
  const f = fixture(t);
  const input = {task: 'bounded task', cwd: f.root, owner: 'parent-one', permission: 'workspace-write'};
  const first = await delegateCodex(input, f.options);
  assert.equal(first.status, 'completed'); assert.equal(first.answer, 'result-42');
  assert.equal(first.model, 'gpt-6.1-sol'); assert.equal(first.thread_id, ID);
  const calls = f.calls();
  const start = calls.find(m => m.method === 'thread/start');
  assert.equal(start.params.model, 'gpt-6.1-sol');
  assert.equal(start.params.approvalPolicy, 'never'); assert.equal(start.params.sandbox, 'workspace-write');
  assert.equal(start.params.config['mcp_servers.dsh_subagent.enabled'], false);
  assert.equal(start.params.config['mcp_servers.test_server.enabled'], false);
  assert.equal(start.params.config['plugins.worker-plugin@example.enabled'], false);
  assert.ok(calls[0].launch.includes('features.apps=false'));
  const turn = calls.find(m => m.method === 'turn/start');
  assert.equal(turn.params.effort, 'medium');
  assert.deepEqual(turn.params.sandboxPolicy, delegationPolicy('workspace-write', first.cwd));
  const resumed = await delegateCodex({...input, task: 'follow-up', permission: 'read-only', threadId: first.thread_id}, f.options);
  assert.equal(resumed.permission, 'read-only');
  assert.ok(f.calls().some(m => m.method === 'thread/resume'));
  await assert.rejects(delegateCodex({...input, owner: 'other-parent', threadId: first.thread_id}, f.options), /not owned/);
});

test('Codex workers shed Desktop parent identity and DSH credentials while preserving Codex account settings', () => {
  const env = {CODEX_THREAD_ID:'parent', CODEX_SESSION_ID:'parent-session', CODEX_APP_TOOLS_PIPE_PATH:'private-pipe',
    CODEX_APP_TOOLS_CALLER_HOST_ID:'local', CODEX_PERMISSION_PROFILE:'danger-full-access', DSH_CODEX_TOKEN:'private-token',
    DSH_CODEX_CONNECTION:'private-connection', DSH_CODEX_REMOTE:'private-remote', DEEPSEEK_API_KEY:'dsh-secret',
    CODEX_HOME:'codex-account-home', OPENAI_API_KEY:'codex-account-secret', PATH:'bin'};
  assert.deepEqual(codexWorkerEnvironment(env), {CODEX_HOME:'codex-account-home', OPENAI_API_KEY:'codex-account-secret', PATH:'bin'});
  assert.equal(env.CODEX_THREAD_ID, 'parent');
});

test('missing parent permission and malicious thread IDs fail before launching Codex', async t => {
  const f = fixture(t);
  const input = {task: 'task', cwd: f.root, owner: 'parent'};
  await assert.rejects(delegateCodex(input, f.options), /known parent permission/);
  await assert.rejects(delegateCodex({...input, permission: 'custom'}, f.options), /known parent permission/);
  await assert.rejects(delegateCodex({...input, permission: 'read-only', threadId: '../outside'}, f.options), /Invalid.*thread ID/);
  assert.deepEqual(delegationPolicy('read-only', f.root), {type: 'readOnly', networkAccess: false});
  assert.deepEqual(delegationPolicy('danger-full-access', f.root), {type: 'dangerFullAccess'});
});

test('failed Codex turns retain failure status; commentary never becomes the final answer', async t => {
  const f = fixture(t, 'failed');
  const result = await delegateCodex({task: 'task', cwd: f.root, owner: 'parent', permission: 'read-only'}, f.options);
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'real failure');
  assert.equal(result.answer, 'result-42');
});

test('cancelling a Codex delegation interrupts its accepted turn without replay', async t => {
  const f = fixture(t, 'pending'), controller = new AbortController();
  const pending = delegateCodex({task: 'task', cwd: f.root, owner: 'parent', permission: 'read-only'}, {
    ...f.options, signal: controller.signal,
    onEvent: message => {if (message.method === 'test/never') controller.abort();},
    timeoutMs: 150,
  });
  await assert.rejects(pending, /timed out/);
  const calls = f.calls();
  assert.equal(calls.filter(m => m.method === 'turn/start').length, 1);
  assert.equal(calls.filter(m => m.method === 'turn/interrupt').length, 1);
});

test('an explicit DSH stop interrupts the worker once', async t => {
  const f = fixture(t, 'pending'), controller = new AbortController();
  const pending = delegateCodex({task:'task',cwd:f.root,owner:'parent',permission:'read-only'}, {...f.options,signal:controller.signal,
    onEvent: message => {if (message.method === 'turn/started') setImmediate(() => controller.abort(new Error('User stopped DSH.')));}});
  await assert.rejects(pending, /User stopped DSH/);
  assert.equal(f.calls().filter(m => m.method === 'turn/interrupt').length, 1);
});

test('legacy low defaults migrate to medium while owned follow-ups retain the model', async t => {
  const f = fixture(t), input = {task:'task',cwd:f.root,owner:'parent',permission:'read-only'};
  const options = {...f.options,env:{...process.env,DSH_CODEX_MODEL:'gpt-6-luna',DSH_CODEX_EFFORT:'low'}};
  const first = await delegateCodex(input, options);
  assert.equal(first.model, 'gpt-6-luna');
  assert.equal(f.calls().find(m => m.method === 'turn/start').params.effort, 'medium');
  await delegateCodex({...input,threadId:first.thread_id}, {...options,env:{...options.env,DSH_CODEX_MODEL:'unavailable-model'}});
  const resumed = f.calls().find(m => m.method === 'thread/resume');
  assert.equal(resumed.params.model, 'gpt-6-luna');
  await assert.rejects(delegateCodex({...input,owner:'other-parent',model:'unavailable-model'}, f.options), /unavailable for this account/);
});

test('explicit efforts below the policy minimum reject before any worker launch', async t => {
  const f = fixture(t), input = {task:'task',cwd:f.root,owner:'parent',permission:'read-only'};
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) {
    for (const effort of ['minimal', 'low']) await assert.rejects(delegateCodex({...input,model,effort}, f.options), /minimum reasoning effort is medium/);
  }
  assert.equal(existsSync(join(f.root,'calls.jsonl')), false);
});

test('Astra is forbidden regardless of the prior Sol effort before launching another worker', async t => {
  const f = fixture(t), input = {task:'task',cwd:f.root,owner:'parent',permission:'read-only'};
  const sol = await delegateCodex(input, f.options), before = f.calls();
  await assert.rejects(delegateCodex({...input,threadId:sol.thread_id,model:'gpt-6-astra',taskKind:'analysis',
    astra:{sol_thread_id:sol.thread_id,difficulty_reason:'An unresolved cause',analysis_objective:'Analyze the cause'}}, f.options), error => error.code === 'ASTRA_DELEGATION_FORBIDDEN');
  assert.deepEqual(f.calls(), before);
});

test('inherited MCP tools cause refusal before a Codex model turn begins', async t => {
  const f = fixture(t, 'unsafe-mcp');
  await assert.rejects(delegateCodex({task:'task',cwd:f.root,owner:'parent',permission:'read-only'}, f.options), /still exposes inherited MCP/);
  assert.equal(f.calls().filter(m => m.method === 'turn/start').length, 0);
});

test('Astra requests fail before worker spawn without changing Sol history or reserving a turn', async t => {
  const f = fixture(t), input = {task:'bounded extreme task',cwd:f.root,owner:'parent',permission:'workspace-write'};
  const sol = await delegateCodex({...input, effort:'ultra'}, f.options);
  const recordPath = join(f.options.state, createHash('sha256').update(input.owner).digest('hex'), sol.thread_id+'.json');
  const original = readFileSync(recordPath);
  assert.equal(JSON.parse(original).routing.effort, 'ultra');
  assert.equal('sol_attempt' in JSON.parse(original), false);
  const astra = {sol_thread_id: sol.thread_id, difficulty_reason:'Sol could not reliably identify the race cause', analysis_objective:'Analyze the unresolved race and give Sol a fix plan'};
  await assert.rejects(delegateCodex({...input, model:'gpt-6-astra',taskKind:'analysis',astra}, f.options), error => error.code === 'ASTRA_DELEGATION_FORBIDDEN');
  const before = f.calls();
  const analysis = {...input,threadId:sol.thread_id,model:'gpt-6-astra',taskKind:'analysis',astra};
  for (let i = 0; i < 2; i++) {
    await assert.rejects(delegateCodex(analysis, f.options), error => error.code === 'ASTRA_DELEGATION_FORBIDDEN');
    assert.deepEqual(f.calls(), before);
    assert.deepEqual(readFileSync(recordPath), original);
  }
  const handoff = await delegateCodex({...input,threadId:sol.thread_id},f.options);
  assert.equal(handoff.model, 'gpt-6.1-sol'); assert.equal(handoff.permission, 'workspace-write');
  assert.equal('astra_analysis_turns' in handoff.routing, false);
});

test('explicit Astra aliases and Astra environment defaults reject before any worker launch', async t => {
  const f = fixture(t), input = {task:'task',cwd:f.root,owner:'parent',permission:'read-only'};
  for (const model of ['astra', 'GPT-6-ASTRA', 'gpt-6-astra-latest', '  gpt-6-astra  ']) {
    await assert.rejects(delegateCodex({...input,model}, f.options), error => error.code === 'ASTRA_DELEGATION_FORBIDDEN');
    await assert.rejects(delegateCodex(input, {...f.options,env:{...process.env,DSH_CODEX_MODEL:model}}), error => error.code === 'ASTRA_DELEGATION_FORBIDDEN');
  }
  assert.equal(existsSync(join(f.root,'calls.jsonl')), false);
  // Rejections release the start lock; a safe worker can still start.
  const safe = await delegateCodex({...input,model:'gpt-6-luna'}, f.options);
  assert.equal(safe.model, 'gpt-6-luna');
});

test('historical Astra records cannot resume, remain unchanged and release their lock on refusal', async t => {
  const f = fixture(t), input = {task:'task',cwd:f.root,owner:'parent',permission:'read-only'};
  const first = await delegateCodex(input, f.options);
  const recordPath = join(f.options.state, createHash('sha256').update(input.owner).digest('hex'), first.thread_id+'.json');
  const original = JSON.parse(readFileSync(recordPath, 'utf8')), before = f.calls();
  for (const fields of [{model:'GPT-6-ASTRA'}, {routing:{...original.routing,model:'astra',analysis_only:true,astra_analysis_turns:1}}]) {
    writeFileSync(recordPath, JSON.stringify({...original,...fields}));
    const legacy = readFileSync(recordPath);
    for (const change of [{}, {model:'gpt-6.1-sol'}, {taskKind:'simple'}]) {
      await assert.rejects(delegateCodex({...input,threadId:first.thread_id,...change}, f.options), error => error.code === 'ASTRA_DELEGATION_FORBIDDEN');
      assert.deepEqual(f.calls(), before);
      assert.deepEqual(readFileSync(recordPath), legacy);
      assert.equal(existsSync(recordPath.replace(/\.json$/, '.lock')), false);
    }
  }
  // Existing safe history remains readable, including legacy upgrade evidence.
  const sol_attempt = {model:'gpt-6.1-sol',turn_id:'old-turn',status:'completed',effort:'ultra'};
  writeFileSync(recordPath, JSON.stringify({...original,sol_attempt}));
  const safe = await delegateCodex({...input,threadId:first.thread_id}, {...f.options,env:{...process.env,DSH_CODEX_MODEL:'gpt-6-astra'}});
  assert.equal(safe.model, 'gpt-6.1-sol');
  assert.deepEqual(JSON.parse(readFileSync(recordPath,'utf8')).sol_attempt, sol_attempt);
});
