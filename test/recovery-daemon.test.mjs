import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {control} from '../src/ipc.mjs';
const exec=promisify(execFile);
const server=fileURLToPath(new URL('../src/server.mjs',import.meta.url));
const notify=fileURLToPath(new URL('../src/notify.mjs',import.meta.url));
async function until(fn) {for(let i=0;i<200;i++){const value=await fn();if(value)return value;await delay(25);}throw new Error('Lifecycle deadline expired');}
test('real isolated daemon restart resumes observation and never replays work',async t=>{
 const root=mkdtempSync(join(tmpdir(),'dsh-recovery-daemon-')),state=join(root,'state'),directory=join(root,'callback');
 mkdirSync(state);
 const env={...process.env,DSH_SUBAGENT_STATE:state,DSH_SUBAGENT_CONFIG:join(root,'config'),CODEX_HOME:join(root,'codex'),DSH_CLI:process.execPath};
 const children=[];let diagnostics='';
 const boot=async()=>{
  const child=spawn(process.execPath,[server,'--daemon'],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});children.push(child);
  child.stderr.on('data',chunk=>diagnostics+=chunk);
  await until(async()=>{try{return (await control('status',{state})).pid===child.pid;}catch{return false;}});
  return child;
 };
 t.after(async()=>{for(const child of children)if(child.exitCode===null){child.kill('SIGKILL');await Promise.race([new Promise(resolve=>child.once('close',resolve)),delay(1000)]);}await delay(100);rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const first=await boot();
 const db=new DatabaseSync(join(state,'state.sqlite'));
 // A synthetic persisted active record exercises recovery; no model is invoked.
 const seed={id:'lifecycle-record',status:'running',execution_id:'execution-one',cwd:root,created_at:new Date().toISOString(),answer:'',partial_text:'',persisted:true};
 db.prepare('INSERT INTO agents VALUES (?,?)').run(seed.id,JSON.stringify(seed));db.close();
 const args=[notify,'--agent',seed.id,'--thread','isolated-parent','--turn',seed.execution_id,'--delivery','queue','--state',state,'--output-dir',directory];
 const initial=JSON.parse((await exec(process.execPath,args,{env})).stdout);assert.equal(initial.status,'watching');
 first.kill('SIGKILL');await new Promise(resolve=>first.once('close',resolve));
 await until(()=>JSON.parse(readFileSync(join(directory,'callback.json'),'utf8')).status==='observation_interrupted');
 await delay(150);const second=await boot();assert.notEqual(second.pid,first.pid);
 const current=await control('status',{state});assert.equal(current.active.length,0);assert.deepEqual(current.runtimes,[]);
 const resumed=JSON.parse((await exec(process.execPath,args,{env})).stdout);assert.equal(resumed.status,'watching');
 await until(()=>JSON.parse(readFileSync(join(directory,'callback.json'),'utf8')).status==='stopped');
 const saved=JSON.parse(readFileSync(join(directory,'result.json'),'utf8'));assert.equal(saved.status,'interrupted');assert.equal(saved.execution_id,seed.execution_id);assert.match(saved.error,/not automatically replayed/);
 const verify=new DatabaseSync(join(state,'state.sqlite'));assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM events WHERE type='bridge/prompt'").get().n,0);verify.close();
 assert.equal((await control('status',{state})).runtimes.length,0);
 assert.equal(diagnostics.match(/DSH subagent daemon ready/g).length,2);
});
