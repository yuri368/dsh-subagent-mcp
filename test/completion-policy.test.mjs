import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {completionContext, completionPolicy, forwardMcpMessage, savedCompletionMode} from '../src/completion-policy.mjs';
import {watchFromMcp} from '../src/mcp-callback.mjs';
import {makeServer} from '../src/server.mjs';

test('frontend forwards Desktop message selection and retains parent metadata', () => {
  const message = forwardMcpMessage({method:'tools/call',params:{name:'dsh_watch',_meta:{threadId:'desktop-thread',callId:'call-1',dshCompletionMode:'native'}}}, {CODEX_APP_TOOLS_PIPE_PATH:'desktop-pipe'});
  assert.equal(message.params._meta.threadId,'desktop-thread');
  assert.equal(message.params._meta.callId,'call-1');
  assert.equal(message.params._meta.dshCompletionMode,'desktop-message');
  assert.equal(message.params._meta.dshClient,'codex-desktop');
  assert.equal(message.params._meta.dshDesktopPipe,'desktop-pipe');
});

test('automatic selection uses native for CLI and messages for Desktop even with a connection hint', () => {
  assert.equal(completionContext({}).dshCompletionMode,'native');
  const metadata = forwardMcpMessage({method:'tools/call',params:{}},{CODEX_APP_TOOLS_PIPE_PATH:'desktop-pipe',DSH_CODEX_CONNECTION:'configured-connection'}).params._meta;
  assert.equal(metadata.dshCompletionMode,'desktop-message');
  assert.equal(metadata.dshConnection,'configured-connection');
  assert.equal(completionContext({DSH_COMPLETION_MODE:'wait'}).dshCompletionMode,'wait');
  assert.throws(()=>completionContext({DSH_COMPLETION_MODE:'queue'}),/wait or native/);
});

test('saved installation wait survives a client without the Desktop marker', () => {
  // The MCP environment lost DSH_COMPLETION_MODE; the installation record kept it.
  const context=completionContext({},'wait');
  assert.equal(context.dshCompletionMode,'wait');
  assert.equal(context.dshClient,'mcp');
  const metadata=forwardMcpMessage({method:'tools/call',params:{}},{},'wait').params._meta;
  assert.equal(metadata.dshCompletionMode,'wait');
  assert.equal(metadata.dshClient,'mcp');
});

test('explicit caller environment overrides the saved installation wait default', () => {
  assert.equal(completionContext({DSH_COMPLETION_MODE:'native'},'wait').dshCompletionMode,'native');
  const metadata=forwardMcpMessage({method:'tools/call',params:{}},{DSH_COMPLETION_MODE:'native'},'wait').params._meta;
  assert.equal(metadata.dshCompletionMode,'native');
  // Desktop detection also stays below the explicit caller environment.
  assert.equal(completionContext({CODEX_APP_TOOLS_PIPE_PATH:'desktop-pipe',DSH_COMPLETION_MODE:'native'},'wait').dshCompletionMode,'native');
});

test('missing or auto installation mode selects the appropriate client delivery', () => {
  assert.equal(savedCompletionMode({}),undefined);
  assert.equal(savedCompletionMode(),undefined);
  assert.equal(completionContext({},savedCompletionMode({})).dshCompletionMode,'native');
  assert.equal(completionContext({CODEX_APP_TOOLS_PIPE_PATH:'desktop-pipe'},undefined).dshCompletionMode,'desktop-message');
  assert.equal(completionContext({CODEX_APP_TOOLS_PIPE_PATH:'desktop-pipe'},undefined).dshClient,'codex-desktop');
  assert.equal(completionContext({CODEX_APP_TOOLS_PIPE_PATH:'desktop-pipe',DSH_CODEX_CONNECTION:'configured-connection'},undefined).dshCompletionMode,'desktop-message');
  assert.equal(savedCompletionMode({DSH_COMPLETION_MODE:'auto'}),'auto');
  assert.equal(completionContext({},'auto').dshCompletionMode,'native');
  assert.equal(completionContext({CODEX_APP_TOOLS_PIPE_PATH:'desktop-pipe'},'auto').dshCompletionMode,'desktop-message');
  assert.equal(completionContext({CODEX_INTERNAL_ORIGINATOR_OVERRIDE:'Codex Desktop'},'auto').dshCompletionMode,'desktop-message');
  assert.equal(completionContext({DSH_COMPLETION_MODE:'auto'},'desktop-message').dshCompletionMode,'native');
  assert.equal(completionContext({CODEX_APP_TOOLS_PIPE_PATH:'desktop-pipe',DSH_COMPLETION_MODE:'auto'},'native').dshCompletionMode,'desktop-message');
});

test('an invalid saved installation default is diagnosed instead of silently used', () => {
  assert.throws(()=>savedCompletionMode({DSH_COMPLETION_MODE:'queue'}),/saved installation DSH_COMPLETION_MODE must be auto or wait or native/);
  assert.equal(savedCompletionMode({DSH_COMPLETION_MODE:''}),undefined); // empty is treated as absent
  assert.throws(()=>completionContext({},'queue'),/saved installation DSH_COMPLETION_MODE must be auto or wait or native/);
  assert.throws(()=>completionContext({},'queue'),/queue/);
  assert.throws(()=>forwardMcpMessage({method:'tools/call',params:{}},{},'queue'),/saved installation DSH_COMPLETION_MODE must be auto or wait or native/);
});

test('doctor policy applies the saved default outside a Desktop process and honors an explicit mode', () => {
  const saved=savedCompletionMode({DSH_COMPLETION_MODE:'wait'});
  const policy=completionPolicy({}, {}, saved);
  assert.equal(policy.mode,'wait');
  assert.equal(policy.automatic_wakeup,false);
  assert.equal(completionPolicy({}, {DSH_COMPLETION_MODE:'native'}, saved).mode,'native');
  assert.equal(completionPolicy({_meta:{dshCompletionMode:'native'}}, {}, saved).mode,'native');
});

test('Desktop message delivery is explicit and carries only its parent pipe as callback context',async()=>{
  const env={DSH_COMPLETION_MODE:'desktop-message',CODEX_APP_TOOLS_PIPE_PATH:'desktop-pipe',DEEPSEEK_API_KEY:'private-key'};
  const meta=forwardMcpMessage({method:'tools/call',params:{_meta:{threadId:'parent'}}},env,'wait').params._meta;
  assert.equal(meta.dshCompletionMode,'desktop-message');
  assert.equal(meta.dshDesktopPipe,'desktop-pipe');
  assert.equal(meta.DEEPSEEK_API_KEY,undefined);
  const policy=completionPolicy({_meta:meta});
  assert.equal(policy.automatic_wakeup,true);assert.equal(policy.delivery,'desktop-message');
  assert.equal(policy.next_action,'register_callback');
  const unavailable=await watchFromMcp('agent',{_meta:{threadId:'parent',dshCompletionMode:'desktop-message'}});
  assert.equal(unavailable.status,'setup_failed');assert.equal(unavailable.next_action,'wait_for_completion');
});

test('Desktop watch returns wait_required without any native parent or listener setup', async () => {
  // No parent thread or state directory: a native registration would throw.
  const receipt = await watchFromMcp('agent-1',{_meta:{dshCompletionMode:'wait'}});
  assert.equal(receipt.status,'wait_required');
  assert.equal(receipt.automatic_wakeup,false);
  assert.equal(receipt.next_action,'wait_for_completion');
  assert.equal(receipt.result_path,undefined);
  assert.match(receipt.instructions,/dsh_wait without seconds/);
});

test('MCP start, followup and watch expose the caller policy despite shared daemon environment', async t => {
  const id = 'agent-1';
  const manager = {start:async()=>({id,status:'running'}),followup:async()=>({id,status:'running'}),get:()=>({id,status:'running'})};
  const server=makeServer(manager), client=new Client({name:'policy-regression',version:'1'});
  const [parent,daemon]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await server.connect(daemon);await client.connect(parent);
  for(const [name,args] of [['dsh_start',{cwd:'C:/project',task:'test'}],['dsh_followup',{agent_id:id,task:'continue'}]]) {
    const reply=await client.callTool({name,arguments:args,_meta:{threadId:'desktop-thread',dshCompletionMode:'wait'}});
    assert.equal(reply.isError,undefined);
    const value=JSON.parse(reply.content[0].text);
    assert.equal(value.accepted,true);
    assert.equal(value.agent_id,id);
    assert.equal(value.completion.mode,'wait');
    assert.equal(value.completion.automatic_wakeup,false);
  }
  const watch=await client.callTool({name:'dsh_watch',arguments:{agent_id:id},_meta:{threadId:'desktop-thread',dshCompletionMode:'wait'}});
  assert.equal(JSON.parse(watch.content[0].text).status,'wait_required');
  const native=await client.callTool({name:'dsh_start',arguments:{cwd:'C:/project',task:'test'},_meta:{dshCompletionMode:'native'}});
  assert.equal(JSON.parse(native.content[0].text).completion.mode,'native');
  let dispatched=false;manager.start=async()=>{dispatched=true;return {id,status:'running'};};
  const invalid=await client.callTool({name:'dsh_start',arguments:{cwd:'C:/project',task:'test'},_meta:{dshCompletionMode:'queue'}});
  assert.equal(invalid.isError,true);
  assert.equal(dispatched,false,'Invalid completion policy must be rejected before creating a task');
});
