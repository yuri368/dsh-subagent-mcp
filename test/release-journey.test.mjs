import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {contentManifest} from '../src/release-safety.mjs';
import {parse} from 'smol-toml';

// Isolate setup's OS/service/provider dependencies. The production setup,
// registration, integrity checks, rollback and filesystem writes still run.
test('isolated setup: successful upgrade, repeat install, failed rollback recovery, retained rollback, active refusal', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-release-journey-'));
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  const paths = Object.fromEntries(['data', 'state', 'config', 'codex'].map(name => [name, join(workspace, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, {recursive: true});
  const fakeCli = join(workspace, 'fake-cli.mjs'); writeFileSync(fakeCli, 'console.log("codex 0.158.0")');
  const recordPath = join(paths.config, 'installation.json');
  const oldRoot = join(paths.data, 'versions/0.7.0-local/node_modules/dsh-subagent-mcp');
  mkdirSync(oldRoot, {recursive: true}); writeFileSync(join(oldRoot, 'package.json'), '{"version":"0.7.0"}');
  writeFileSync(join(oldRoot, 'local-patch.mjs'), '// actual local patch');
  const old = {version: '0.7.0', root: oldRoot, node: process.execPath, backend: 'background', state: paths.state, skill: false, env: {CUSTOM_POLICY: 'sol', COMPLETION_MODE: 'desktop-message', DSH_COMPLETION_MODE: 'desktop-message'}, dsh: fakeCli, codex: [process.execPath, fakeCli]};
  writeFileSync(recordPath, JSON.stringify(old));
  const toml = '# custom\r\n[mcp_servers.dsh_subagent]\r\ncommand = """old\r\nexecutable"""\r\nargs = [\r\n"old", # launch comment\r\n]\r\nenv = { CUSTOM = "keep", DSH_SUBAGENT_STATE = "old" } # inline env comment\r\nstartup_timeout_sec = 300\r\ntool_timeout_sec = 3600\r\nenv_vars = ["TOKEN"]\r\nmode = "desktop-message"\r\n';
  writeFileSync(join(paths.codex, 'config.toml'), toml);
  mkdirSync(join(paths.codex, 'skills/dsh-subagent'), {recursive: true});
  writeFileSync(join(paths.codex, 'skills/dsh-subagent/SKILL.md'), 'user custom skill');
  writeFileSync(join(paths.state, 'history.json'), 'retained history');
  globalThis.releaseFixture = {active: [], fail: false, starts: 0, stops: 0, paths, recordPath, source, fakeCli};
  const originalEnv = {DSH_CLI: process.env.DSH_CLI, DSH_CODEX_CLI: process.env.DSH_CODEX_CLI};
  process.env.DSH_CLI = fakeCli; process.env.DSH_CODEX_CLI = fakeCli;
  const stubs = {
    'platform.mjs': `import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'; const f=globalThis.releaseFixture; export const locations=()=>f.paths; export const installationFile=()=>f.recordPath; export const installation=()=>existsSync(f.recordPath)?JSON.parse(readFileSync(f.recordPath)):null; export const writeJson=(p,v)=>writeFileSync(p,JSON.stringify(v)); export const privateDirectory=p=>mkdirSync(p,{recursive:true}); export const readableProgramDirectory=p=>p;`,
    'config.mjs': `const f=globalThis.releaseFixture; export const projectRoot=f.source; export const resolveDshCli=()=>f.fakeCli;`,
    'commands.mjs': `const f=globalThis.releaseFixture; export const commandSpec=()=>[process.execPath,f.fakeCli]; export const packageEntry=()=>f.fakeCli; export function runCommand(spec,args=[]) {if(args[0]==='mcp'&&args[1]==='list')return '[]'; if(Array.isArray(spec)&&String(spec.at(-1)).includes('uninstall-web')&&f.fail)throw new Error('injected post-registration failure'); return '';}`,
    'accounts.mjs': `export const accountStatus=()=>({}); export const printAccounts=()=>{}; export const captureProvider=()=>{}; export const guideDeepseek=async()=>{}; export const installCommand='fixture';`,
    'service.mjs': `const f=globalThis.releaseFixture; export const backendDefault=()=> 'background'; export const statusService=async()=>({running:true,active:f.active}); export const startService=async()=>{f.starts++}; export const stopService=async()=>{f.stops++}; export const installService=()=>{}; export const removeService=async()=>{}; export const nativeServiceConflict=()=>false; export const systemdQuote=x=>x;`,
    'bridge-client.mjs': `export const bridgeClient=async()=>{throw new Error('unexpected legacy client')};`,
    'codex-host.mjs': `export const prepareWindowsCodexDaemon=async()=>{};`,
    'probe-runtime.mjs': `export const probeRuntime=async()=>{};`,
    'doctor.mjs': `export const doctor=async()=>({ok:true,accounts:{},checks:[]});`,
    'install-package.mjs': `import {mkdirSync,cpSync} from 'node:fs'; import {join} from 'node:path'; export function installPackage(source,prefix){const root=join(prefix,'node_modules/dsh-subagent-mcp'); mkdirSync(root,{recursive:true}); for(const item of ['package.json','src','skills'])cpSync(join(source,item),join(root,item),{recursive:true});return root;}`,
  };
  const hooks = registerHooks({resolve(specifier, context, next) {
    const name = specifier.split('/').at(-1);
    if (context.parentURL?.includes('/src/') && stubs[name]) return {url: 'data:text/javascript,' + encodeURIComponent(stubs[name]), shortCircuit: true};
    return next(specifier, context);
  }});
  try {
    const {setup, rollback} = await import('../src/setup.mjs');
    await assert.rejects(setup(['--yes', '--no-skill']), /no integrity baseline/);
    await assert.rejects(setup(['--yes', '--replace-modified']), /custom skill exists/);
    const stopsBefore = globalThis.releaseFixture.stops;
    globalThis.releaseFixture.active = [{}];
    await assert.rejects(setup(['--yes', '--no-skill', '--replace-modified']), /Active DSH tasks/);
    assert.equal(globalThis.releaseFixture.stops, stopsBefore);
    globalThis.releaseFixture.active = [];
    await setup(['--yes', '--no-skill', '--replace-modified', '--completion-mode', 'auto']);
    let current = JSON.parse(readFileSync(recordPath));
    assert.equal(current.version, JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version);
    assert.equal(current.env.CUSTOM_POLICY, 'sol');
    assert.equal(current.env.COMPLETION_MODE, 'desktop-message');
    assert.equal(current.env.DSH_COMPLETION_MODE, 'auto');
    const registeredMode = () => parse(readFileSync(join(paths.codex, 'config.toml'), 'utf8')).mcp_servers.dsh_subagent.env.DSH_COMPLETION_MODE;
    assert.equal(registeredMode(), 'auto');
    assert.equal(current.previousInstallation.root, oldRoot);
    assert.deepEqual(current.previousInstallation.integrity, contentManifest(oldRoot));
    for (const custom of ['startup_timeout_sec = 300', 'tool_timeout_sec = 3600', 'env_vars = ["TOKEN"]', 'mode = "desktop-message"', 'CUSTOM = "keep"', '# launch comment', '# inline env comment']) assert.ok(readFileSync(join(paths.codex, 'config.toml'), 'utf8').includes(custom));
    const firstRoot = current.root;
    await setup(['--yes', '--no-skill']);
    current = JSON.parse(readFileSync(recordPath));
    assert.notEqual(current.root, firstRoot);
    const recordBefore = readFileSync(recordPath), configBefore = readFileSync(join(paths.codex, 'config.toml'));
    globalThis.releaseFixture.fail = true;
    await assert.rejects(setup(['--yes', '--no-skill']), /injected post-registration failure/);
    assert.deepEqual(readFileSync(recordPath), recordBefore);
    assert.deepEqual(readFileSync(join(paths.codex, 'config.toml')), configBefore);
    globalThis.releaseFixture.fail = false;
    // Exercise real migration rejection as well as the post-registration failure.
    // The exact invalid bytes must survive and the prior service must restart.
    const invalidConfig = Buffer.from('# invalid user config\r\n[mcp_servers.dsh_subagent]\r\nargs = ["unterminated"\r\n');
    writeFileSync(join(paths.codex, 'config.toml'), invalidConfig);
    const startsBefore = globalThis.releaseFixture.starts;
    await assert.rejects(setup(['--yes', '--no-skill']), /Invalid Codex TOML/);
    assert.deepEqual(readFileSync(recordPath), recordBefore);
    assert.deepEqual(readFileSync(join(paths.codex, 'config.toml')), invalidConfig);
    assert.ok(globalThis.releaseFixture.starts >= startsBefore + 2, 'New activation and previous service restoration must both run.');
    assert.equal(readFileSync(join(paths.state, 'history.json'), 'utf8'), 'retained history');
    assert.equal(readFileSync(join(paths.codex, 'skills/dsh-subagent/SKILL.md'), 'utf8'), 'user custom skill');
    writeFileSync(join(paths.codex, 'config.toml'), configBefore);
    await rollback();
    assert.equal(JSON.parse(readFileSync(recordPath)).root, firstRoot);
    assert.equal(registeredMode(), 'auto');
    await rollback(); // toggle forward to the second RC install
    // Select its retained legacy local patch for the explicit rollback journey.
    current = JSON.parse(readFileSync(recordPath));
    current.previousInstallation = {...old, integrity: contentManifest(oldRoot)};
    writeFileSync(recordPath, JSON.stringify(current));
    await rollback();
    assert.equal(JSON.parse(readFileSync(recordPath)).root, oldRoot);
    assert.equal(registeredMode(), 'desktop-message', 'Old frontends must not inherit auto from the newer registration.');
    assert.equal(readFileSync(join(oldRoot, 'local-patch.mjs'), 'utf8'), '// actual local patch');
    assert.equal(readFileSync(join(paths.state, 'history.json'), 'utf8'), 'retained history');
    assert.equal(readFileSync(join(paths.codex, 'skills/dsh-subagent/SKILL.md'), 'utf8'), 'user custom skill');
    // Older installations without a saved policy used native. They also must
    // not receive the newer auto value on an explicit retained rollback.
    await rollback();
    current = JSON.parse(readFileSync(recordPath));
    const legacyEnv = {...old.env}; delete legacyEnv.DSH_COMPLETION_MODE;
    current.previousInstallation = {...old, env: legacyEnv, integrity: contentManifest(oldRoot)};
    writeFileSync(recordPath, JSON.stringify(current));
    assert.equal(registeredMode(), 'auto');
    await rollback();
    assert.equal(registeredMode(), 'native');
  } finally {
    hooks.deregister(); delete globalThis.releaseFixture;
    for (const [key, value] of Object.entries(originalEnv)) {if(value === undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(workspace, {recursive: true, force: true});
  }
});
