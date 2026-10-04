import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {makeServer} from '../src/server.mjs';

async function connected(t, manager) {
  const server=makeServer(manager), client=new Client({name:'manager-compatibility',version:'1'});
  const [parent,daemon]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await server.connect(daemon);
  await client.connect(parent);
  return client;
}

test('current managers retain the runtime release tool used by agents CLI', async t => {
  let requested;
  const client=await connected(t, {release:async id=>{
    requested=id;
    return {id,status:'completed',released:true};
  }});
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='dsh_release'));
  const result=await client.callTool({name:'dsh_release',arguments:{agent_id:'retained-agent'}});
  assert.equal(result.isError,undefined);
  assert.equal(requested,'retained-agent');
  assert.equal(JSON.parse(result.content[0].text).released,true);
});

test('older installed managers expose supported tools without advertising release', async t => {
  const client=await connected(t, {});
  const catalog=await client.listTools();
  assert.ok(catalog.tools.some(tool=>tool.name==='dsh_start'));
  assert.ok(catalog.tools.some(tool=>tool.name==='dsh_wait'));
  assert.ok(!catalog.tools.some(tool=>tool.name==='dsh_release'));
});
