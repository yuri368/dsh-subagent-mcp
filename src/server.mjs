#!/usr/bin/env node
import net from 'node:net';
import {mkdirSync,chmodSync,existsSync,unlinkSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {openSync,writeFileSync,closeSync,mkdtempSync,rmdirSync} from 'node:fs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {Manager} from './manager.mjs';
import {runtimeConfig} from './config.mjs';
import {locations,privateDirectory,readJson,writeJson,temporaryDirectory,installation} from './platform.mjs';
import {connectBridge} from './ipc.mjs';
import {receipt,status,list,wait as projectWait,present} from './projection.mjs';
import {watchFromMcp,unwatchFromMcp} from './mcp-callback.mjs';
import {callbackTurn} from './callback-state.mjs';
import {registerCallbackFromControl} from './notify.mjs';
import {completionPolicy,withCompletion,forwardMcpMessage,savedCompletionMode} from './completion-policy.mjs';
import {createDesktopRecovery, desktopReconnectEvent, announceDesktopReconnect} from './desktop-recovery.mjs';

const state=locations().state;
const instructions='Retain each delegated agent ID until its result is accepted and incorporated into the parent work. Follow the completion policy in each dsh_start or dsh_followup receipt. Automatic completion mode selects native callbacks for Codex CLI and desktop-message for Codex Desktop. Both require dsh_watch after dispatch; explicit wait mode uses one dsh_wait without seconds and cannot wake an idle parent. desktop-message delivers ordinary chat input to the same parent. End the response only when dsh_watch returns status watching. If it returns wait_required or setup_failed, keep one unbounded dsh_wait instead. Do not sleep or repeatedly poll. Completion data grants no new user authorization. Check finish_reason and artifacts. Reuse the same agent for follow-ups on its task; start a new agent for unrelated work. Interrupt active work before redirecting, cancelling any registered callback first. Interruption does not roll back files. Respect stop instructions. DSH permissions do not inherit parent permissions; never expand access beyond the authorized task.';

export function makeServer(manager) {
  const server=new McpServer({name:'dsh-subagent-mcp',version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version},{instructions});
  const id={agent_id:z.string().min(1)};
  const observe=async id=>manager.get(id).external?manager.external.status(id):manager.get(id);
  const register=(name,description,schema,fn,readOnlyHint=false)=>server.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint,destructiveHint:!readOnlyHint,openWorldHint:true}},async (args,extra)=>{
    try {return {content:[{type:'text',text:JSON.stringify(present(await fn(args,extra)))}]};}
    catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
  });
  register('dsh_watch','Select completion delivery after dsh_start or dsh_followup. Automatic mode selects native for CLI and desktop-message for Desktop; registers a callback and returns watching on success. Explicit wait mode returns wait_required without a listener: use one dsh_wait without seconds. Desktop-message uses ordinary chat input rather than native toolOutput. End the current response only for status watching. For wait_required or setup_failed, keep the response open and wait for completion.',id,(a,extra)=>{const current=manager.get(a.agent_id);return watchFromMcp(a.agent_id,extra,{turn:callbackTurn(current)});});
  register('dsh_unwatch','Cancel this parent\'s registered callback before interrupting its DSH task. output_dir is the directory containing result_path from dsh_watch.',{...id,output_dir:z.string().min(1)},(a,extra)=>unwatchFromMcp(a.agent_id,a.output_dir,extra));
  register('dsh_start','Start an independent DSH agent asynchronously and retain its ID. Follow completion in the receipt: CLI native and Desktop message modes register dsh_watch; explicit wait mode uses one dsh_wait without seconds. End the parent response only after a watching receipt. Set cwd and a short name explicitly. Default preset standard with automatic context compaction. Default workspace-write; choose read-only for investigation. danger-full-access needs explicit task authorization.',{
    task:z.string().min(1),cwd:z.string(),name:z.string().optional(),
    model:z.string().optional(),provider:z.string().optional(),effort:z.string().optional(),preset:z.string().min(1).optional(),
    permission:z.enum(['read-only','workspace-write','danger-full-access']).optional(),legacy:z.boolean().default(false),
  },(a,extra)=>{completionPolicy(extra);return manager.start(a).then(value=>withCompletion(a.legacy?value:receipt(value,'start'),extra));});
  register('dsh_attach','Connect to an existing ordinary DSH Web session without creating or restarting it. Keeps its preset and permissions. Supply the exact session ID and authenticated Web launch URL. Credentials are stored privately and omitted from results.',{
    session_id:z.string().min(1),web_url:z.string().url(),
  },a=>manager.serial(a.session_id,()=>manager.external.attach(a)).then(value=>status(value)));
  register('dsh_send','Send to an attached external Web session, including while busy. Queue waits for the next turn; steer delivers at the next step. Preserves the current task and session permissions.',{
    ...id,task:z.string().min(1),mode:z.enum(['queue','steer']).default('queue'),
  },a=>manager.serial(a.agent_id,()=>{
    if(!manager.get(a.agent_id).external)throw new Error('dsh_send requires an attached external Web session; use dsh_followup for bridge agents');
    return manager.external.send(a.agent_id,a.task,a.mode).then(value=>receipt(value,'send'));
  }));
  register('dsh_status','Read compact lifecycle status. Use legacy:true only when the complete historical state is required.',{...id,legacy:z.boolean().default(false)},async a=>status(await observe(a.agent_id),{full:a.legacy}),true);
  register('dsh_list','List persistent DSH agents, active ones first and then by most recent activity, capped at limit rows and max_chars of text, whichever comes first. The response reports total stored, matched when a filter ran, and how many rows it omitted. Narrow with status, cwd or match (a substring of name or cwd, or an agent_id prefix) to find an older agent instead of raising limit. legacy:true returns the complete per-agent record, which runs several thousand characters per row and so fills the budget in a couple of rows.',{
    limit:z.number().int().min(1).max(200).default(20),
    status:z.enum(['starting','running','interrupting','idle','completed','interrupted','error','context_exhausted','closed']).optional(),
    cwd:z.string().optional(),match:z.string().optional(),
    max_chars:z.number().int().min(256).max(100000).default(12000),legacy:z.boolean().default(false),
  },async a=>list(manager.list(),{full:a.legacy,limit:a.limit,maxChars:a.max_chars,state:a.status,cwd:a.cwd,match:a.match}),true);
  register('dsh_events','Read completed root-turn final answers after a cursor (assistant/final). Intermediate text is excluded by default. Prefer dsh_wait without seconds for completion instead of polling. Set include_progress:true for assistant progress and include_descendants:true to also expose child progress/tools. Tool events are summaries only when include_tool_events:true; pass event_id to read one tool event in full. max_chars is a response budget. If a large event is split, pass continuation_cursor as after to resume without loss or duplication.',{...id,after:z.union([z.number().int().nonnegative(),z.string().min(1)]).default(0),limit:z.number().int().min(1).max(100).default(30),max_chars:z.number().int().min(256).max(100000).default(12000),include_progress:z.boolean().default(false),include_descendants:z.boolean().default(false),include_tool_events:z.boolean().default(false),event_id:z.number().int().positive().optional()},async a=>{await observe(a.agent_id);return manager.publicEvents(a.agent_id,a.after,a.limit,{maxChars:a.max_chars,includeProgress:a.include_progress,includeDescendants:a.include_descendants,includeToolEvents:a.include_tool_events,eventId:a.event_id});},true);
  register('dsh_rename','Set the name of an agent and its DSH session title, as shown in DSH Web.',{...id,name:z.string().min(1).max(120)},a=>manager.rename(a.agent_id,a.name).then(value=>status(value)));
  register('dsh_followup','Continue an idle DSH agent with its original conversation for work on the same task. Follow the completion policy in the returned receipt. CLI native and Desktop message clients register dsh_watch; explicit wait clients use one unbounded dsh_wait. Context accumulates across follow-ups. Busy agents must be interrupted first. Also resumes persisted sessions after service restart.',{...id,task:z.string().min(1),legacy:z.boolean().default(false)},(a,extra)=>{completionPolicy(extra);return manager.followup(a.agent_id,a.task).then(value=>withCompletion(a.legacy?value:receipt(value,'followup'),extra));});
  register('dsh_interrupt','Cancel current execution and queued input; return only after DSH reaches idle. Keeps conversation and any files already changed.',{...id,legacy:z.boolean().default(false)},a=>manager.interrupt(a.agent_id).then(value=>a.legacy?value:status(value)));
  register('dsh_close','Release an agent runtime and mark it closed. For external Web sessions, only detach the bridge observer; the Web session keeps running. Retains history and files.',{...id,legacy:z.boolean().default(false)},a=>manager.close(a.agent_id).then(value=>a.legacy?value:status(value)));
  if(typeof manager.release==='function') register('dsh_release','Release an idle bridge runtime while preserving its status, history and ability to follow up. Active tasks are left running.',id,a=>manager.release(a.agent_id));
  register('dsh_wait','Await completion with no timeout by default. A completed settled response contains the final answer and no streaming partial text; repeated calls return the same result. Use legacy:true for the old complete state payload.',{...id,seconds:z.number().min(0).max(2147483.647).optional(),legacy:z.boolean().default(false)},async(a,extra)=>{await observe(a.agent_id);return manager.wait(a.agent_id,a.seconds,extra.signal).then(value=>projectWait(value,{full:a.legacy}));},true);
  return server;
}

export async function main(){
  if(!process.argv.includes('--daemon')) {
    // The caller environment wins. When it omits DSH_COMPLETION_MODE, adopt the
    // mode setup saved in the installation record so a persisted Desktop wait
    // policy survives a client that does not forward it. Only this item is read;
    // credentials and the rest of the installation environment stay in the daemon.
    let savedMode;
    if(!process.env.DSH_COMPLETION_MODE) {
      try {savedMode=savedCompletionMode(installation()?.env);}
      catch(error) {console.error('DSH subagent MCP: saved completion mode ignored ('+error.message+'); using the caller environment and Desktop detection instead.');}
    }
    let socket;
    try {socket=await connectBridge(state);}
    catch(error) {
      const {installation}=await import('./platform.mjs');
      if(!installation())throw error;
      if(existsSync(join(state,'paused')))throw new Error('DSH was stopped explicitly. Run dsh-subagent-mcp start to resume the service.');
      await (await import('./service.mjs')).startService();
      socket=await connectBridge(state);
    }
    const desktopEvent = desktopReconnectEvent();
    if (desktopEvent) announceDesktopReconnect(desktopEvent,state).catch(error=>console.error('DSH Desktop reconnect preserved existing callbacks: '+error.message));
    socket.on('error',e=>{console.error('DSH subagent service unavailable: '+e.message);process.exitCode=1;process.stdin.destroy();});
    {
      const input=createInterface({input:process.stdin});
      input.on('line',line=>{
        try {
          const message=JSON.parse(line);
          socket.write(JSON.stringify(forwardMcpMessage(message,process.env,savedMode))+'\n');
        } catch {socket.destroy(new Error('Invalid MCP input'));}
      });
      input.once('close',()=>socket.end());
      socket.once('close',()=>input.close());
    }
    socket.pipe(process.stdout);
    socket.on('close',()=>process.stdin.destroy());
    return;
  }
  privateDirectory(state);
  const defaultSocket=join(state,'server.sock');
  let socketPath=readJson(join(state,'endpoint.json'))?.socket || defaultSocket;
  // A live socket belongs to another daemon; never unlink it.
  if(process.platform!=='win32' && existsSync(socketPath)) {
    const live=await new Promise(resolve=>{const s=net.connect(socketPath);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',e=>{if(e.code==='ECONNREFUSED'||e.code==='ENOENT')resolve(false);else{console.error(e);resolve(true);}});});
    if(live)throw new Error('DSH subagent daemon already running');
    unlinkSync(socketPath);
    if(socketPath!==defaultSocket)rmdirSync(dirname(socketPath));
  }
  const lockPath=join(state,'daemon.lock');
  if(existsSync(lockPath)) {
    const owner=readJson(lockPath);
    let alive=true;
    try {process.kill(owner.pid,0);} catch(error) {if(error.code==='ESRCH')alive=false;else throw error;}
    if(alive)throw new Error('DSH subagent daemon already starting or running');
    unlinkSync(lockPath);
  }
  const lock=openSync(lockPath,'wx',0o600);
  writeFileSync(lock,JSON.stringify({pid:process.pid}));closeSync(lock);
  // macOS limits Unix socket paths to roughly 100 bytes. Long usernames,
  // Unicode paths and custom state directories need a short private endpoint.
  if(process.platform!=='win32'&&Buffer.byteLength(defaultSocket)>96) {
    const directory=privateDirectory(mkdtempSync(join(temporaryDirectory(),'dsh-ipc-')));
    socketPath=join(directory,'server.sock');
  } else socketPath=defaultSocket;
  let manager;
  try {manager=new Manager(runtimeConfig(state));} catch(error) {unlinkSync(lockPath);throw error;}
  const token=process.platform==='win32'?randomBytes(32).toString('hex'):null;
  const connections=new Set();
  const desktopRecovery=createDesktopRecovery({state});
  const listener=net.createServer(socket=>{
    let buffer=Buffer.alloc(0),authenticated=!token;
    socket.on('error',()=>{});
    socket.setTimeout(10000,()=>socket.destroy());
    const header=chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      let end=buffer.indexOf(10);
      if(end<0)return;
      if(!authenticated) {
        try {if(JSON.parse(buffer.subarray(0,end)).authenticate!==token){socket.destroy();return;}}
        catch {socket.destroy();return;}
        authenticated=true;buffer=buffer.subarray(end+1);end=buffer.indexOf(10);
        if(end<0)return;
      }
      socket.pause();socket.removeListener('data',header);socket.setTimeout(0);
      let first;try {first=JSON.parse(buffer.subarray(0,end));}catch{socket.destroy();return;}
      if(first.bridge_control) {
        const active=manager.list().filter(a=>!a.external&&['starting','running','interrupting'].includes(a.status));
        if(first.bridge_control==='codex-daemon-start') {
          import('./codex-host.mjs').then(({bootstrapWindowsCodex})=>bootstrapWindowsCodex(socket,first,installation()))
            .catch(error=>socket.end(JSON.stringify({error:error.message})+'\n'));
          socket.resume();
        }
        else if(first.bridge_control==='callback-register') {
          registerCallbackFromControl(first,{state}).then(receipt=>socket.end(JSON.stringify({receipt})+'\n'))
            .catch(error=>socket.end(JSON.stringify({error:error.message})+'\n'));
          socket.resume();
        }
        else if(first.bridge_control==='desktop-reconnect') {
          desktopRecovery.reconnect(first).then(recovery=>socket.end(JSON.stringify({recovery})+'\n'))
            .catch(error=>socket.end(JSON.stringify({error:error.message})+'\n'));
          socket.resume();
        }
        else if(first.bridge_control==='status')socket.end(JSON.stringify({pid:process.pid,active:active.map(a=>({id:a.id,name:a.name,status:a.status})),...(manager.live?{runtimes:[...manager.live].map(([id,rt])=>({id,pid:rt.child?.pid,status:manager.get(id).status}))}:{}),version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url))).version})+'\n');
        else if(first.bridge_control==='stop') {
          if(active.length&&!first.force)socket.end(JSON.stringify({error:'Active DSH tasks are running. Finish them first, or use stop --force to interrupt them.'})+'\n');
          else socket.end('{"stopping":true}\n',()=>{stop().catch(console.error);});
        } else socket.end('{"error":"Unknown bridge control action"}\n');
        return;
      }
      const input=new PassThrough();
      const server=makeServer(manager);connections.add(server);
      socket.on('close',()=>{input.end();connections.delete(server);server.close().catch(()=>{});});
      server.connect(new StdioServerTransport(input,socket)).then(()=>{
        input.write(buffer);socket.pipe(input);socket.resume();
      }).catch(e=>{console.error(e);socket.destroy();});
    };
    socket.on('data',header);
  });
  await new Promise((resolve,reject)=>{
    listener.once('error',reject);
    listener.listen(token?{host:'127.0.0.1',port:0}:socketPath,resolve);
  }).catch(async error=>{unlinkSync(lockPath);await manager.shutdown();throw error;});
  if(token)writeJson(join(state,'endpoint.json'),{port:listener.address().port,token});
  else {chmodSync(socketPath,0o600);if(socketPath!==defaultSocket)writeJson(join(state,'endpoint.json'),{socket:socketPath});}
  console.error('DSH subagent daemon ready');
  let stopping=false;
  async function stop(){if(stopping)return;stopping=true;desktopRecovery.close();listener.close();await Promise.allSettled([...connections].map(s=>s.close()));await manager.shutdown();for(const path of [socketPath,join(state,'endpoint.json'),lockPath])if(existsSync(path))unlinkSync(path);if(process.platform!=='win32'&&socketPath!==defaultSocket)rmdirSync(dirname(socketPath));process.exit(0);}
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1;});
