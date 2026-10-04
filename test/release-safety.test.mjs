import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'smol-toml';
import {assertUpgrade, assertUnmodified, compareVersions, contentManifest, updateCodexToml, snapshotFile} from '../src/release-safety.mjs';

test('release version ordering prevents latest from downgrading a local RC', () => {
  assert.equal(compareVersions('0.8.0-rc.1', '0.7.0'), 1);
  assert.equal(compareVersions('0.8.0', '0.8.0-rc.1'), 1);
  assert.equal(compareVersions('0.8.0-rc.10', '0.8.0-rc.2'), 1);
  assert.throws(() => assertUpgrade({version: '0.8.0-rc.1'}, '0.7.0'), /Refusing downgrade/);
  assert.doesNotThrow(() => assertUpgrade({version: '0.8.0-rc.1'}, '0.8.0-rc.1'));
});

test('Codex registration retains custom timeouts, model mode, env_vars and completion settings', () => {
  const before = '# User preferences\nmodel = "gpt-6-sol"\n[mcp_servers.dsh_subagent]\ncommand = "old"\nargs = ["old.mjs", "mcp"]\nstartup_timeout_sec = 300\ntool_timeout_sec = 3600\nenv_vars = ["SECRET"]\nmode = "desktop-message"\ncompletion = "native"\n[mcp_servers.dsh_subagent.env]\nCUSTOM = "keep"\nDSH_SUBAGENT_STATE = "old"\n[other]\nflag = true\n';
  const record = {node: 'node', root: '/new', state: '/state'};
  const after = updateCodexToml(before, record, '/config');
  for (const line of ['model = "gpt-6-sol"', 'startup_timeout_sec = 300', 'tool_timeout_sec = 3600', 'env_vars = ["SECRET"]', 'mode = "desktop-message"', 'completion = "native"', 'CUSTOM = "keep"', '[other]\nflag = true']) assert.ok(after.includes(line), line);
  assert.ok(after.includes('DSH_SUBAGENT_STATE = "/state"'));
  assert.equal(updateCodexToml(after, record, '/config'), after);
});

test('explicit auto completion migration changes only the owned policy and preserves other registration settings', () => {
  const before = '# custom\r\nmodel = "gpt-6-sol"\r\n[mcp_servers.dsh_subagent]\r\ncommand = "old"\r\nargs = ["old"]\r\ntool_timeout_sec = 3600\r\nenv_vars = ["CUSTOM"]\r\nenv = { DSH_COMPLETION_MODE = "desktop-message", CUSTOM = "keep" } # comment\r\n';
  const record = {node:'node',root:'/new',state:'/state'};
  assert.equal(parse(updateCodexToml(before,record,'/config')).mcp_servers.dsh_subagent.env.DSH_COMPLETION_MODE,'desktop-message');
  const after = updateCodexToml(before,record,'/config',{completionMode:'auto'});
  const config = parse(after);
  assert.equal(config.mcp_servers.dsh_subagent.env.DSH_COMPLETION_MODE,'auto');
  assert.equal(config.mcp_servers.dsh_subagent.env.CUSTOM,'keep');
  assert.equal(config.mcp_servers.dsh_subagent.tool_timeout_sec,3600);
  assert.deepEqual(config.mcp_servers.dsh_subagent.env_vars,['CUSTOM']);
  assert.equal(config.model,'gpt-6-sol');
  assert.ok(after.includes('# comment'));
  assert.equal(updateCodexToml(after,record,'/config',{completionMode:'auto'}),after);
  assert.throws(()=>updateCodexToml(before,record,'/config',{completionMode:'queue'}),/Invalid explicit completion mode/);
});

test('valid multiline launch values and inline env preserve unknown bytes, comments and CRLF', () => {
  const record = {node: 'C:\\node.exe', root: '/new path', state: '/state'};
  const before = [
    '# global comment', 'model = "gpt-6-sol"',
    'external = [', '  "a", # unrelated array comment', '  "b",', ']',
    'text = """', '[mcp_servers.dsh_subagent.env]', 'DSH_SUBAGENT_STATE = "fake"', '"""',
    'timestamp = 2025-12-02T12:30:00Z', 'large = 9223372036854775807',
    '[mcp_servers."dsh_subagent"] # section comment',
    '"command" = """', 'old executable', '""" # command comment',
    "'args' = [", '  "old", # keep launch comment', '  "mcp",', '] # args comment',
    'env = { "CUSTOM" = "x#y", DSH_SUBAGENT_STATE = "old", DSH_SUBAGENT_CONFIG = "old config", "OTHER" = "value" } # env comment',
    'disabled = false # unknown setting', '[other]', 'dotted.value = [1, 2, 3]', '',
  ].join('\r\n');
  const after = updateCodexToml(before, record, '/config');
  for (const unchanged of ['external = [\r\n  "a", # unrelated array comment\r\n  "b",\r\n]',
    'text = """\r\n[mcp_servers.dsh_subagent.env]\r\nDSH_SUBAGENT_STATE = "fake"\r\n"""',
    'timestamp = 2025-12-02T12:30:00Z', 'large = 9223372036854775807',
    '"CUSTOM" = "x#y"', '"OTHER" = "value"', '# keep launch comment', '# command comment', '# args comment',
    '# env comment', 'disabled = false # unknown setting', '[other]\r\ndotted.value = [1, 2, 3]'])
    assert.ok(after.includes(unchanged), unchanged);
  assert.equal(after.replaceAll('\r\n', '').includes('\n'), false, 'Must preserve CRLF throughout.');
  const bridge = parse(after, {integersAsBigInt: 'asNeeded'}).mcp_servers.dsh_subagent;
  assert.equal(bridge.command, record.node);
  assert.deepEqual(bridge.args, [join(record.root, 'src/cli.mjs'), 'mcp']);
  assert.equal(bridge.env.CUSTOM, 'x#y'); assert.equal(bridge.env.DSH_SUBAGENT_STATE, '/state');
  assert.equal(bridge.env.DSH_SUBAGENT_CONFIG, '/config');
  assert.equal(updateCodexToml(after, record, '/config'), after);
});

test('dotted registration keys, quoted sections, inline env additions and literal strings migrate safely', () => {
  const record = {node: 'node', root: '/new', state: '/state'};
  const fixtures = [
    'mcp_servers.dsh_subagent.command = "old"\nmcp_servers.dsh_subagent.args = ["old",\n"mcp"]\nmcp_servers.dsh_subagent.env.CUSTOM = "keep"\n[other]\nx = true\n',
    "[ 'mcp_servers' . 'dsh_subagent' ]\ncommand = '''old\ncommand'''\nargs = [\"old\"]\nenv = { CUSTOM = 'keep' }\n",
    '[mcp_servers.dsh_subagent]\ncommand = "old"\nargs = ["old"]\nenv = {}\n',
    '[mcp_servers.dsh_subagent.env]\nCUSTOM = "keep"\n',
    '# empty registration\n[unrelated]\nflag = true\n',
    '[mcp_servers.dsh_subagent]\nargs = ["old"]\n[[other]]\ncommand = "unrelated"\n',
  ];
  for (const before of fixtures) {
    const after = updateCodexToml(before, record, '/config');
    const bridge = parse(after).mcp_servers.dsh_subagent;
    assert.equal(bridge.command, 'node'); assert.equal(bridge.env.DSH_SUBAGENT_STATE, '/state');
    assert.equal(bridge.env.DSH_SUBAGENT_CONFIG, '/config');
    assert.equal(updateCodexToml(after, record, '/config'), after);
  }
});

test('invalid syntax, duplicate definitions and invalid registration types refuse before writing', () => {
  const record = {node: 'node', root: '/new', state: '/state'};
  for (const invalid of [
    '[other]\nflag = ["unterminated"\n',
    '[mcp_servers.dsh_subagent]\nargs = ["old"]\nargs = []\n',
    '[mcp_servers.dsh_subagent]\ncommand = "old"\n[mcp_servers.dsh_subagent]\n',
    '[mcp_servers.dsh_subagent]\nenv = { CUSTOM = "x" }\n[mcp_servers.dsh_subagent.env]\nCUSTOM = "y"\n',
    // The pinned parser enforces TOML 1.0, including unrelated user settings.
    'other = {\n key = "value"\n}\n',
    'other = { key = "value", }\n',
    'other = "\\e"\n',
    'other = "\\x41"\n',
  ]) assert.throws(() => updateCodexToml(invalid, record, '/config'), /Invalid Codex TOML/);
  for (const invalid of ['mcp_servers = 1', 'mcp_servers.dsh_subagent = []',
    '[mcp_servers.dsh_subagent]\ncommand = 123', '[mcp_servers.dsh_subagent]\nargs = [1]',
    '[mcp_servers.dsh_subagent]\nenv = "bad"', '[mcp_servers.dsh_subagent]\nenv = { CUSTOM = 2 }'])
    assert.throws(() => updateCodexToml(invalid, record, '/config'), /Invalid Codex MCP registration shape/);
  assert.throws(() => updateCodexToml('mcp_servers = { dsh_subagent = { command = "old" } }', record, '/config'), /Unsupported inline bridge parent/);
});

test('registration rejects an invalid document without modifying its on-disk bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-config-reject-'));
  try {
    const path = join(root, 'config.toml');
    const before = Buffer.from('# preserve exact bytes\r\n[mcp_servers.dsh_subagent]\r\nargs = ["broken"\r\n');
    writeFileSync(path, before);
    assert.throws(() => writeFileSync(path, updateCodexToml(readFileSync(path, 'utf8'),
      {node: 'node', root: '/new', state: '/state'}, '/config')), /Invalid Codex TOML/);
    assert.deepEqual(readFileSync(path), before);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('integrity detects modified, added and removed files; explicit acceptance permits legacy patches', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-integrity-'));
  try {
    mkdirSync(join(root, 'skills')); writeFileSync(join(root, 'skills/custom.md'), 'custom');
    const record = {root, integrity: contentManifest(root)};
    assert.doesNotThrow(() => assertUnmodified(record));
    writeFileSync(join(root, 'skills/custom.md'), 'changed');
    assert.throws(() => assertUnmodified(record), /skills\/custom.md/);
    assert.doesNotThrow(() => assertUnmodified(record, true));
    writeFileSync(join(root, 'skills/custom.md'), 'custom'); writeFileSync(join(root, 'extra'), 'x');
    assert.throws(() => assertUnmodified(record), /extra/);
    rmSync(join(root, 'extra')); rmSync(join(root, 'skills/custom.md'));
    assert.throws(() => assertUnmodified(record), /custom.md/);
    assert.throws(() => assertUnmodified({root}), /no integrity baseline/);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('failure snapshot restores exact config bytes and leaves history untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-snapshot-'));
  try {
    const config = join(root, 'config.toml'), history = join(root, 'history.json');
    writeFileSync(config, '# custom\r\nmode = "desktop-message"\r\n'); writeFileSync(history, 'history');
    const restore = snapshotFile(config), before = readFileSync(config);
    writeFileSync(config, 'replacement'); restore();
    assert.deepEqual(readFileSync(config), before); assert.equal(readFileSync(history, 'utf8'), 'history');
  } finally {rmSync(root, {recursive: true, force: true});}
});
