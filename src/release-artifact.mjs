import {mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {join, basename} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {runCommand} from './commands.mjs';

export function validateSourceLock(source) {
  const pkg = JSON.parse(readFileSync(join(source, 'package.json')));
  const lockBytes = readFileSync(join(source, 'npm-shrinkwrap.json'));
  const lock = JSON.parse(lockBytes);
  const packageLock = JSON.parse(readFileSync(join(source, 'package-lock.json')));
  if (!isDeepStrictEqual(lock, packageLock)) throw new Error('npm-shrinkwrap.json does not match package-lock.json.');
  if (lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version ||
      !isDeepStrictEqual(lock.packages?.['']?.dependencies || {}, pkg.dependencies || {}))
    throw new Error('Release shrinkwrap package identity/dependencies do not match package.json.');
  return {pkg, lockBytes};
}

function tarFile(artifact, requested) {
  const tar = gunzipSync(readFileSync(artifact));
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    const prefix = field(345, 155), name = field(0, 100);
    const path = prefix ? prefix + '/' + name : name;
    const size = Number.parseInt(field(124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid release tar header.');
    if (path === requested) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Release artifact is missing required file: ' + requested);
}

export function assertPackedLock(artifact, sourceLock) {
  const actual = tarFile(artifact, 'package/npm-shrinkwrap.json');
  if (!actual.equals(sourceLock.lockBytes)) throw new Error('Packed npm-shrinkwrap.json differs from the validated source lock.');
  const pkg = JSON.parse(tarFile(artifact, 'package/package.json'));
  if (pkg.name !== sourceLock.pkg.name || pkg.version !== sourceLock.pkg.version) throw new Error('Packed package identity does not match source.');
}

// All acceptance jobs and publication verify the exact downloaded bytes,
// rather than rebuilding a candidate or trusting its filename.
export function verifyReleaseArtifact(artifact, {source} = {}) {
  const manifest = JSON.parse(readFileSync(artifact + '.manifest.json', 'utf8'));
  const expected = readFileSync(artifact + '.sha256', 'utf8').trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual || manifest.sha256 !== actual)
    throw new Error('Release artifact checksum/manifest does not match.');
  const pkg = JSON.parse(tarFile(artifact, 'package/package.json'));
  const lockBytes = tarFile(artifact, 'package/npm-shrinkwrap.json');
  const lock = JSON.parse(lockBytes);
  if (pkg.name !== 'dsh-subagent-mcp' || manifest.name !== pkg.name || manifest.version !== pkg.version ||
      basename(artifact) !== pkg.name + '-' + pkg.version + '.tgz' || manifest.shrinkwrapVerified !== true ||
      !manifest.files?.some(file => file.path === 'npm-shrinkwrap.json') ||
      lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version ||
      !isDeepStrictEqual(lock.packages?.['']?.dependencies || {}, pkg.dependencies || {}))
    throw new Error('Release artifact package/lock/manifest identity does not match.');
  if (source) assertPackedLock(artifact, validateSourceLock(source));
  return {artifact, version: pkg.version, sha256: actual, shrinkwrapVerified: true,
    publicationTag: pkg.version.includes('-') ? 'next' : 'latest'};
}

export function packLocalRelease(source, destination) {
  const sourceLock = validateSourceLock(source);
  mkdirSync(destination, {recursive: true});
  const [packed] = JSON.parse(runCommand('npm', ['pack', source, '--ignore-scripts', '--json', '--pack-destination', destination], {encoding: 'utf8', stdio: 'pipe'}));
  const artifact = join(destination, packed.filename);
  // Never leave success sidecars from an older attempt beside a rejected pack.
  for (const suffix of ['.sha256', '.manifest.json']) rmSync(artifact + suffix, {force: true});
  try {
    if (!packed.files.some(file => file.path === 'npm-shrinkwrap.json')) throw new Error('npm pack file inventory is missing npm-shrinkwrap.json.');
    assertPackedLock(artifact, sourceLock);
    const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
    writeFileSync(artifact + '.sha256', sha256 + '  ' + packed.filename + '\n');
    writeFileSync(artifact + '.manifest.json', JSON.stringify({name: packed.name, version: packed.version, sha256, integrity: packed.integrity, files: packed.files, shrinkwrapVerified: true}, null, 2) + '\n');
    return {artifact, sha256, version: packed.version, shrinkwrapVerified: true};
  } catch (error) {
    for (const suffix of ['', '.sha256', '.manifest.json']) rmSync(artifact + suffix, {force: true});
    throw error;
  }
}
