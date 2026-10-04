import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {installation, temporaryDirectory} from './platform.mjs';
import {installPackage} from './install-package.mjs';
import {runCommand} from './commands.mjs';
import {assertUnmodified, assertUpgrade} from './release-safety.mjs';
import {statusService} from './service.mjs';

export function upgradeSetupFlags(options, current) {
  return [...(options['no-skill'] || current?.skill === false ? ['--no-skill'] : []),
    ...['replace-modified', 'yes', 'no-install-deps'].filter(key => options[key]).map(key => '--' + key)];
}

export async function upgrade(options = {}) {
  let {package: artifact, 'replace-modified': replaceModified = false} = options;
  const status = await statusService();
  if (status.running && status.active?.length) throw new Error('Finish or interrupt active DSH tasks before upgrading.');
  const current = installation();
  assertUnmodified(current, replaceModified);
  const flags = upgradeSetupFlags(options, current);
  if (!artifact) {
    const latest = JSON.parse(runCommand('npm', ['view', 'dsh-subagent-mcp@latest', 'version', '--json'], {encoding: 'utf8', stdio: 'pipe'}));
    assertUpgrade(current, latest);
    return runCommand('npm', ['exec', '--yes', '--package=dsh-subagent-mcp@' + latest, '--', 'dsh-subagent-mcp', 'setup', ...flags]);
  }
  artifact = resolve(artifact);
  if (!existsSync(artifact) || !artifact.endsWith('.tgz')) throw new Error('Local upgrade requires an existing .tgz package.');
  const checksum = artifact + '.sha256';
  if (!existsSync(checksum)) throw new Error('Local package is missing its .sha256 integrity sidecar.');
  const expected = readFileSync(checksum, 'utf8').trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  if (expected !== actual) throw new Error('Local package checksum does not match.');
  const stage = mkdtempSync(join(temporaryDirectory(), 'dsh-upgrade-'));
  try {
    const root = installPackage(artifact, stage);
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    assertUpgrade(current, version);
    runCommand([process.execPath, join(root, 'src/cli.mjs')], ['setup', ...flags]);
  } finally {rmSync(stage, {recursive: true, force: true});}
}
