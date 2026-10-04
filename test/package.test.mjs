import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {projectRoot} from '../src/config.mjs';
import {runCommand} from '../src/commands.mjs';
import {temporaryDirectory} from '../src/platform.mjs';
import {nativeServiceConflict} from '../src/service.mjs';

for (const service of process.env.DSH_NATIVE_SERVICE_TEST === '1' ? ['background', 'auto'] : ['background'])
test(`packed ${service} installation survives cache removal, rolls back failed upgrade, and uninstalls without losing history`, {skip: process.env.DSH_PACKAGE_TEST !== '1', timeout: 180000}, () => {
  const root = mkdtempSync(join(temporaryDirectory(), 'dsh-package-'));
  const folder = join(root, 'User space 雪 & data'); mkdirSync(folder);
  const config = join(folder, 'config'), state = join(folder, 'state');
  const codexState = join(folder, 'codex-home/config.toml');
  const launches = join(folder, 'launches.json');
  const dsh = join(folder, 'dsh.mjs'), codex = join(folder, 'codex.mjs');
  const terminal = join(folder, 'terminal.mjs');
  writeFileSync(terminal, "Object.defineProperty(process.stdin, 'isTTY', {value: true});\n");
  writeFileSync(dsh, `import {createInterface} from 'node:readline';
if(process.argv.includes('--patch'))createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{}}));
 if(request.method==='shutdown')process.exit(0);
});\n`);
  writeFileSync(codex, `import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {WebSocketServer} from ${JSON.stringify(import.meta.resolve('ws'))};
const a=process.argv.slice(2), path=${JSON.stringify(codexState)};
if(a[0]==='--version')console.log('codex-cli 0.158.0');
else if(a[0]==='mcp'&&a[1]==='list'){
 const text=existsSync(path)?readFileSync(path,'utf8'):'';
 const command=text.match(/^command = (.+)$/m), args=text.match(/^args = (.+)$/m);
 console.log(JSON.stringify(command&&args?[{name:'dsh_subagent',transport:{command:JSON.parse(command[1]),args:JSON.parse(args[1])}}]:[]));
}
else if(a[0]==='mcp'&&a[1]==='remove')unlinkSync(path);
else if(a[0]==='app-server'&&a[1]==='daemon'&&a[2]==='version')console.log(JSON.stringify({status:'running',managedCodexVersion:'0.158.0'}));
else if(a[0]==='app-server'){
 const endpoint=new URL(a[a.indexOf('--listen')+1]);
 const token=readFileSync(a[a.indexOf('--ws-token-file')+1],'utf8').trim();
 new WebSocketServer({host:endpoint.hostname,port:Number(endpoint.port),verifyClient:info=>info.req.headers.authorization==='Bearer '+token});
}else if(a[0]==='--remote'){
 if(!existsSync(path))throw new Error('Codex opened before MCP registration');
 const launchPath=${JSON.stringify(launches)};
 const previous=existsSync(launchPath)?JSON.parse(readFileSync(launchPath,'utf8')):[];
 writeFileSync(launchPath,JSON.stringify([...previous,a]));
}
else process.exit(3);
`);
  const env = {...process.env, DSH_SUBAGENT_DATA: join(folder, 'data'), DSH_SUBAGENT_CONFIG: config, DSH_SUBAGENT_STATE: state,
    DSH_HOME: join(folder, 'dsh-home'), CODEX_HOME: join(folder, 'codex-home'), DSH_CLI: dsh, DSH_CODEX_CLI: codex, DEEPSEEK_API_KEY: 'fixture-private-key'};
  for (const key of ['CODEX_THREAD_ID', 'DSH_CODEX_REMOTE', 'DSH_CODEX_TOKEN', 'DSH_CODEX_CONNECTION']) delete env[key];
  const run = (entry, ...args) => execFileSync(process.execPath, [entry, ...args], {env, encoding: 'utf8', stdio: 'pipe', timeout: 120000});
  const open = entry => execFileSync(process.execPath, ['--import', pathToFileURL(terminal).href, entry], {env, encoding: 'utf8', stdio: 'pipe', timeout: 120000});
  let installed;
  try {
    const [pack] = JSON.parse(runCommand('npm', ['pack', projectRoot, '--pack-destination', root, '--json', '--ignore-scripts'], {stdio: 'pipe', encoding: 'utf8'}));
    const cache = join(folder, 'npx cache'); mkdirSync(cache);
    runCommand('npm', ['install', '--prefix', cache, '--ignore-scripts', '--no-audit', '--no-fund', join(root, pack.filename)], {stdio: 'pipe'});
    const entry = join(cache, 'node_modules/dsh-subagent-mcp/src/cli.mjs');
    // The native-service case uses the public single-command onboarding path.
    const output = service === 'auto' ? open(entry)
      : run(entry, 'setup', '--service', service, '--capture-key', '--no-install-deps');
    assert.match(output, /Installation complete/); assert.ok(!output.includes('fixture-private-key'));
    const record = JSON.parse(readFileSync(join(config, 'installation.json'), 'utf8'));
    installed = join(record.root, 'src/cli.mjs');
    if (service === 'background') assert.equal(record.backend, 'background');
    else assert.equal(record.backend, {linux: 'systemd', darwin: 'launchd', win32: 'task-scheduler'}[process.platform]);
    console.log('Validated service backend:', record.backend, 'on', process.platform);
    assert.equal(nativeServiceConflict(record, {config: join(config, 'installation.json')}), false,
      'The service must recognize its own configuration after registration.');
    if (service === 'auto') assert.equal(nativeServiceConflict(record, {config: join(folder, 'other-config/installation.json')}), true);
    assert.ok(record.root.startsWith(join(env.DSH_SUBAGENT_DATA, 'versions')));
    assert.equal(realpathSync(join(env.CODEX_HOME, 'skills/dsh-subagent')), realpathSync(join(record.root, 'skills/dsh-subagent')));
    assert.ok(!readFileSync(join(config, 'installation.json'), 'utf8').includes('fixture-private-key'));
    if (service === 'background') assert.equal(JSON.parse(readFileSync(join(config, 'provider.json'), 'utf8')).DEEPSEEK_API_KEY, 'fixture-private-key');
    assert.equal(existsSync(launches), false, 'Installing must not launch a coding session.');
    for (const again of [open(entry), run(entry)]) {
      assert.match(again, /already installed/);
      assert.ok(!again.includes('Preparing installation'));
      assert.deepEqual(JSON.parse(readFileSync(join(config, 'installation.json'), 'utf8')), record);
      assert.equal(existsSync(launches), false, 'Repeating installation must return to the terminal.');
    }
    assert.equal(JSON.parse(run(installed, 'doctor', '--json')).ok, true);
    const healthyCodexConfig = readFileSync(codexState, 'utf8');
    // A genuinely invalid env value fails during actual registration, after new
    // service activation, and
    // verifies the complete TOML/record/skill rollback instead of a dead CLI stub.
    const customCodexConfig = 'model = "gpt-6-sol"\n' + healthyCodexConfig
      .replace(/\[mcp_servers\.dsh_subagent\.env\][\s\S]*$/, '')
      + 'startup_timeout_sec = 300\ntool_timeout_sec = 3600\nenv_vars = ["CUSTOM_TOKEN"]\nmode = "desktop-message"\n'
      + 'env = { CUSTOM = "preserved", INVALID_VALUE = 123 }\n';
    writeFileSync(codexState, customCodexConfig);
    assert.throws(() => run(entry, 'setup', '--service', service, '--no-install-deps'), error => {
      assert.match(error.stderr, /Invalid Codex MCP registration shape/);
      assert.match(error.stderr, /The previous installation was restored/, error.stdout + error.stderr);
      return true;
    });
    assert.deepEqual(JSON.parse(readFileSync(join(config, 'installation.json'), 'utf8')), record);
    assert.equal(readFileSync(codexState, 'utf8'), customCodexConfig, 'Rollback must restore every custom TOML byte.');
    assert.equal(realpathSync(join(env.CODEX_HOME, 'skills/dsh-subagent')), realpathSync(join(record.root, 'skills/dsh-subagent')), 'Rollback must retain the prior skill target.');
    assert.equal(JSON.parse(run(installed, 'status', '--json')).running, true);
    writeFileSync(codexState, healthyCodexConfig);
    rmSync(cache, {recursive: true});
    run(installed, 'stop'); run(installed, 'start');
    assert.equal(JSON.parse(run(installed, 'doctor', '--json')).ok, true);
    writeFileSync(join(state, 'retained-evidence.txt'), 'keep');
    // Users can remove the MCP entry themselves before uninstalling.
    if (service === 'background') rmSync(codexState);
    run(installed, 'uninstall');
    assert.ok(!existsSync(join(config, 'installation.json')));
    assert.ok(!existsSync(join(env.CODEX_HOME, 'skills/dsh-subagent')));
    assert.ok(!existsSync(codexState));
    assert.equal(readFileSync(join(state, 'retained-evidence.txt'), 'utf8'), 'keep');
    if (service === 'background') assert.ok(existsSync(join(config, 'provider.json')));
    assert.ok(!existsSync(join(state, 'daemon.lock')));
  } catch(error) {
    const log=join(state,'daemon.log');
    if(existsSync(log))console.error('Service diagnostic:',readFileSync(log,'utf8'));
    throw error;
  } finally {
    if (installed && existsSync(installed)) {try {run(installed, 'stop', '--force');} catch {}}
    rmSync(root, {recursive: true, force: true});
  }
});
