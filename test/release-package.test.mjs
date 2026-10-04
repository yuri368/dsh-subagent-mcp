import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCommand} from '../src/commands.mjs';
import {installPackage} from '../src/install-package.mjs';
import {projectRoot} from '../src/config.mjs';
import {packLocalRelease, assertPackedLock, validateSourceLock, verifyReleaseArtifact} from '../src/release-artifact.mjs';
import {upgradeSetupFlags} from '../src/local-upgrade.mjs';

test('real npm local artifact installs twice in isolated prefixes without registry dependencies', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-artifact-fixture-'));
  try {
    const source = join(scratch, 'source'); mkdirSync(source);
    writeFileSync(join(source, 'package.json'), JSON.stringify({name: 'dsh-subagent-mcp', version: '0.8.0-rc.1', type: 'module', files: ['fixture.mjs']}));
    writeFileSync(join(source, 'fixture.mjs'), '// packed content\n');
    const [pack] = JSON.parse(runCommand('npm', ['pack', source, '--pack-destination', scratch, '--ignore-scripts', '--json'], {encoding: 'utf8', stdio: 'pipe'}));
    const artifact = join(scratch, pack.filename);
    const prefix = join(scratch, 'installed');
    const first = installPackage(artifact, prefix);
    const second = installPackage(artifact, prefix);
    assert.equal(first, second);
    assert.equal(readFileSync(join(second, 'fixture.mjs'), 'utf8'), '// packed content\n');
    assert.equal(JSON.parse(readFileSync(join(second, 'package.json'))).version, '0.8.0-rc.1');
  } finally {rmSync(scratch, {recursive: true, force: true});}
});

test('official pack path requires an actual unchanged shrinkwrap and reproducible artifact', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-locked-artifact-'));
  try {
    const source = join(scratch, 'source'), destination = join(scratch, 'release'); mkdirSync(source);
    const realPackage = JSON.parse(readFileSync(join(projectRoot, 'package.json')));
    assert.ok(realPackage.files.includes('npm-shrinkwrap.json'), 'Production whitelist must explicitly include the lock.');
    validateSourceLock(projectRoot);
    const pkg = {name: realPackage.name, version: realPackage.version, files: [...realPackage.files, 'fixture.mjs']};
    const lock = {name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {'': {name: pkg.name, version: pkg.version}}};
    const manifest = join(source, 'package.json');
    writeFileSync(manifest, JSON.stringify(pkg)); writeFileSync(join(source, 'fixture.mjs'), '// fixture\n');
    for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) writeFileSync(join(source, name), JSON.stringify(lock));
    const first = packLocalRelease(source, destination);
    assert.equal(first.shrinkwrapVerified, true);
    const sourceLock = validateSourceLock(source);
    assertPackedLock(first.artifact, sourceLock);
    const second = packLocalRelease(source, destination);
    assert.equal(second.sha256, first.sha256, 'Same source must produce the same tarball.');
    const details = JSON.parse(readFileSync(second.artifact + '.manifest.json'));
    assert.equal(details.shrinkwrapVerified, true);
    assert.ok(details.files.some(file => file.path === 'npm-shrinkwrap.json'));
    const verified = verifyReleaseArtifact(second.artifact, {source});
    assert.equal(verified.sha256, first.sha256);
    assert.equal(verified.publicationTag, 'next');
    writeFileSync(second.artifact + '.sha256', '0'.repeat(64));
    assert.throws(() => verifyReleaseArtifact(second.artifact), /checksum/);
    writeFileSync(second.artifact + '.sha256', first.sha256);
    writeFileSync(second.artifact + '.manifest.json', JSON.stringify({...details, version: '99.0.0'}));
    assert.throws(() => verifyReleaseArtifact(second.artifact), /identity/);
    writeFileSync(second.artifact + '.manifest.json', JSON.stringify(details));
    assert.throws(() => assertPackedLock(second.artifact, {...sourceLock, lockBytes: Buffer.from('{}')}), /differs/);
    // Reproduce RC1: file exists in source but whitelist silently excludes it.
    writeFileSync(manifest, JSON.stringify({...pkg, files: ['fixture.mjs']}));
    assert.throws(() => packLocalRelease(source, destination), /missing npm-shrinkwrap/);
    assert.equal(existsSync(first.artifact), false, 'Rejected artifact must be removed.');
    assert.equal(existsSync(first.artifact + '.sha256'), false);
    assert.equal(existsSync(first.artifact + '.manifest.json'), false, 'Rejected pack must not leave a success manifest.');
    writeFileSync(join(source, 'npm-shrinkwrap.json'), '{}');
    assert.throws(() => packLocalRelease(source, destination), /does not match/);
  } finally {rmSync(scratch, {recursive: true, force: true});}
});

test('unattended upgrade explicitly forwards setup choices', () => {
  assert.deepEqual(upgradeSetupFlags({yes: true, 'no-install-deps': true}, {skill: true}), ['--yes', '--no-install-deps']);
  assert.deepEqual(upgradeSetupFlags({'replace-modified': true, yes: true}, {skill: false}), ['--no-skill', '--replace-modified', '--yes']);
});
