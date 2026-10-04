import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync, existsSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {prepareWebLaunch, workspaceScope} from '../src/web-launch.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-launch-test-'));
  const workspace = join(root, 'workspace'), outside = join(root, 'outside');
  for (const path of [workspace, outside]) mkdirSync(path);
  const cli = join(root, 'bin.mjs'); writeFileSync(cli, '');
  for (const [name, code] of Object.entries({
    'dsh-home-paths': 'import {resolve} from "node:path"; export const resolveDshHome = (_, env) => resolve(env.DSH_HOME);',
    'dsh-tools': 'export const defineTool = options => options;',
  })) {
    const packagePath = join(root, 'node_modules', '@deepseek-ai', name);
    mkdirSync(packagePath, {recursive: true});
    writeFileSync(join(packagePath, 'package.json'), JSON.stringify({type: 'module', exports: './index.mjs'}));
    writeFileSync(join(packagePath, 'index.mjs'), code);
  }
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {root, workspace, outside, cli};
}

test('Web preparation inserts only the host tool and keeps launch settings process-local', async t => {
  const f = fixture(t), original = {DSH_HOME: join(f.root, 'host'), PATH: 'unchanged'};
  const launch = await prepareWebLaunch(['--codex-workspace', f.outside, '--patch', 'operator.yml', '--port', '0'],
    {cwd: f.workspace, cli: f.cli, env: original, record: {env: {INSTALLED_SETTING: 'yes', DSH_HOME: f.outside}}, provider: {PROVIDER_SETTING: 'yes'}, temporaryRoot: f.root});
  assert.deepEqual(launch.spec, [process.execPath, f.cli]);
  assert.deepEqual(launch.args, ['web', '--patch', launch.patch, '--patch', 'operator.yml', '--port', '0']);
  assert.equal(launch.env.DSH_HOME, original.DSH_HOME); assert.equal(launch.env.DSH_CLI, f.cli);
  assert.equal(launch.env.INSTALLED_SETTING, 'yes'); assert.equal(launch.env.PROVIDER_SETTING, 'yes');
  assert.deepEqual(original, {DSH_HOME: join(f.root, 'host'), PATH: 'unchanged'});
  const patch = readFileSync(launch.patch, 'utf8');
  assert.match(patch, /- insert:/); assert.match(patch, /dsh-codex-tool\.mjs/);
  assert.doesNotMatch(patch, /dsh-plugin|sdk-jsonrpc|permissionPresets|PROVIDER_SETTING|INSTALLED_SETTING/);
  assert.deepEqual(launch.workspaces, [f.workspace, f.outside]);
  assert.equal(existsSync(original.DSH_HOME), false);
  launch.cleanup(); assert.equal(existsSync(launch.patch), false);
});

test('custom profiles and extra workspace flags are explicit; invalid paths fail before launch', async t => {
  const f = fixture(t), options = {cwd: f.workspace, cli: f.cli, env: {DSH_HOME: f.root}, record: {}, provider: {}, temporaryRoot: f.root};
  const launch = await prepareWebLaunch(['--profile', 'isolated', '--from-default-profile', 'web', '--codex-workspace=' + f.outside], options);
  assert.deepEqual(launch.args, ['--profile', 'isolated', '--patch', launch.patch, '--from-default-profile', 'web']);
  launch.cleanup();
  const other = await prepareWebLaunch([], {...options, env: {DSH_HOME: f.outside}});
  assert.notEqual(other.ownerScope, launch.ownerScope); other.cleanup();
  const guarded = await prepareWebLaunch([], options);
  const overlayDirectory = join(guarded.patch, '..');
  rmSync(guarded.patch); rmdirSync(overlayDirectory);
  symlinkSync(f.outside, overlayDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => guarded.cleanup(), /unexpected Web overlay directory/);
  assert.equal(existsSync(f.outside), true); rmSync(overlayDirectory);
  for (const args of [['--codex-workspace', 'relative'], ['--codex-workspace', join(f.root, 'missing')], ['--profile'], ['--profile', 'desktop'], ['--dump-default-config']]) await assert.rejects(prepareWebLaunch(args, options));
  assert.throws(() => workspaceScope([f.cli]), /directory/);
});

test('workspace scope checks lexical descendants and real targets, including junction retargeting', t => {
  const f = fixture(t), child = join(f.workspace, 'child'); mkdirSync(child);
  const check = workspaceScope([f.workspace]);
  assert.equal(check(child), child); assert.throws(() => check(f.outside), /outside/);
  assert.throws(() => check('relative'), /absolute/); assert.throws(() => check(join(f.workspace, 'missing')));
  const escape = join(f.workspace, 'escape'), alias = join(f.outside, 'alias');
  symlinkSync(f.outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(child, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => check(escape), /outside/); assert.throws(() => check(alias), /outside/);
  const approvedLink = join(f.root, 'approved-link');
  symlinkSync(f.workspace, approvedLink, process.platform === 'win32' ? 'junction' : 'dir');
  const checkLink = workspaceScope([approvedLink]); assert.equal(checkLink(approvedLink), f.workspace);
  assert.equal(workspaceScope([approvedLink], [f.workspace])(approvedLink), f.workspace);
  rmSync(approvedLink); symlinkSync(f.outside, approvedLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => checkLink(approvedLink), /outside/);
  assert.throws(() => workspaceScope([approvedLink], [f.workspace]), /changed after launch/);
});

test('simulated Agent lifecycle mounts scoped tools and rechecks cwd, owner and permissions', async t => {
  const f = fixture(t), previous = process.env.DSH_CLI;
  process.env.DSH_CLI = previous || f.cli;
  const {mountCodexTool} = await import('../src/dsh-codex-tool.mjs');
  if (previous === undefined) delete process.env.DSH_CLI; else process.env.DSH_CLI = previous;
  const definitions = new Map(), calls = [], hooks = new Map();
  const agent = (id, cwd = f.workspace, preset = 'standard') => {
    const value = {session: {id, header: {cwd, agentPreset: preset}}, ctx: {inject: (_deps, fn) => fn({tools: {register: tool => definitions.set(value, tool)}})}};
    return value;
  };
  const existing = agent('same-session'), minimal = agent('minimal', f.workspace, 'minimal'), outside = agent('outside', f.outside);
  let permission = 'workspace-write';
  const ctx = {agents: {list: () => [existing, minimal, outside]}, on: (event, fn) => hooks.set(event, fn), permissionPresets: {current: () => permission}};
  const dependencies = {define: options => options, delegate: (input, options) => {calls.push({input, options}); return input;}};
  mountCodexTool(ctx, {workspaceRoots: [f.workspace], ownerScope: 'a'.repeat(64)}, dependencies);
  assert.equal(definitions.size, 1);
  const later = agent('later'); hooks.get('agent/created')({agent: later}); assert.equal(definitions.size, 2);
  const signal = new AbortController().signal;
  const result = definitions.get(existing).execute({task: 'task', task_kind: 'simple'}, {agent: existing, signal});
  assert.equal(result.permission, 'workspace-write'); assert.equal(result.cwd, f.workspace);
  assert.equal(result.owner, 'web:' + 'a'.repeat(64) + ':same-session'); assert.equal(calls[0].options.signal, signal);
  permission = 'read-only'; definitions.get(existing).execute({task: 'follow-up', thread_id: 'owned'}, {agent: existing});
  assert.equal(calls[1].input.permission, 'read-only'); assert.equal(calls[1].input.threadId, 'owned');
  permission = 'unknown'; assert.throws(() => definitions.get(existing).execute({task: 'task'}, {agent: existing}), /known parent permission/);
  permission = 'danger-full-access'; existing.session.header.cwd = f.outside;
  assert.throws(() => definitions.get(existing).execute({task: 'task'}, {agent: existing}), /outside/);
  existing.session.header.cwd = f.workspace; existing.session.header.agentPreset = 'minimal';
  assert.throws(() => definitions.get(existing).execute({task: 'task'}, {agent: existing}), /Minimal/);
  assert.throws(() => definitions.get(later).execute({task: 'task'}, {agent: existing}), /owning/);
  assert.equal(calls.length, 2);
  mountCodexTool(ctx, {workspaceRoots: [f.workspace], ownerScope: 'b'.repeat(64)}, dependencies);
  hooks.get('agent/created')({agent: later});
  assert.equal(definitions.get(later).execute({task: 'task'}, {agent: later}).owner, 'web:' + 'b'.repeat(64) + ':later');
  mountCodexTool(ctx, {}, dependencies);
  hooks.get('agent/created')({agent: later});
  assert.equal(definitions.get(later).execute({task: 'task'}, {agent: later}).owner, 'later');
});

test('installed DSH defineTool accepts the host definition without model execution', {skip: !process.env.DSH_CLI}, async t => {
  const f = fixture(t), requireDsh = createRequire(process.env.DSH_CLI);
  const {defineTool} = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tools')));
  const {mountCodexTool} = await import('../src/dsh-codex-tool.mjs');
  let tool;
  const agent = {session: {id: 'sdk', header: {cwd: f.workspace, agentPreset: 'standard'}}, ctx: {inject: (_deps, fn) => fn({tools: {register: definition => {tool = definition;}}})}};
  mountCodexTool({agents: {list: () => [agent]}, on() {}, permissionPresets: {current: () => 'read-only'}},
    {workspaceRoots: [f.workspace], ownerScope: 'c'.repeat(64)}, {define: defineTool, delegate: input => input});
  assert.equal(tool.name, 'codex_delegate');
  assert.equal((await tool.execute({task: 'no model called'}, {agent})).permission, 'read-only');
  await assert.rejects(tool.execute({}, {agent}), /task/);
});
