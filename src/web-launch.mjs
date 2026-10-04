import {mkdtempSync, writeFileSync, rmSync, realpathSync, statSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, isAbsolute, resolve, relative, dirname, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {projectRoot, resolveDshCli} from './config.mjs';
import {commandSpec, runCommand} from './commands.mjs';
import {installation, providerEnvironment} from './platform.mjs';

const normalized = path => process.platform === 'win32' ? path.toLowerCase() : path;
const within = (root, path) => {
  const suffix = relative(normalized(root), normalized(path));
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')));
};

// Both the entered path and its filesystem target must stay in the approved
// root. Re-resolve at invocation time so a retargeted junction fails closed.
export function workspaceScope(roots, expectedTargets) {
  if (!Array.isArray(roots) || roots.length === 0) throw new Error('Codex Web delegation requires at least one workspace.');
  if (expectedTargets !== undefined && (!Array.isArray(expectedTargets) || expectedTargets.length !== roots.length)) throw new Error('Codex Web workspace targets do not match the approved roots.');
  const approved = roots.map((root, index) => {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Codex workspace must be an absolute existing directory.');
    const path = resolve(root), real = realpathSync(path);
    if (!statSync(real).isDirectory()) throw new Error('Codex workspace must be an existing directory.');
    if (expectedTargets && normalized(real) !== normalized(expectedTargets[index])) throw new Error('Codex Web workspace target changed after launch preparation.');
    return {path, real};
  });
  return cwd => {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Codex delegation requires an absolute session directory.');
    const path = resolve(cwd), real = realpathSync(path);
    if (!statSync(real).isDirectory()) throw new Error('Codex session directory must be an existing directory.');
    if (!approved.some(root => within(root.path, path) && normalized(realpathSync(root.path)) === normalized(root.real) && within(root.real, real))) {
      throw new Error('DSH session directory is outside the Codex Web workspaces.');
    }
    return real;
  };
}

// DSH_HOME may be new. Canonicalize its existing ancestor without creating or
// changing any profile. File ancestors and filesystem errors are rejected.
function canonicalHome(home) {
  let current = home;
  const suffix = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('DSH home has no existing ancestor.');
    suffix.unshift(basename(current)); current = parent;
  }
  if (!statSync(current).isDirectory()) throw new Error('DSH home must be a directory.');
  return join(realpathSync(current), ...suffix);
}

export function webOverlay({workspaces, workspaceTargets = workspaces.map(path => realpathSync(path)), ownerScope, toolPath = join(projectRoot, 'src', 'dsh-codex-tool.mjs')}) {
  return `- insert:\n    - id: dsh-codex-tool\n      name: ${JSON.stringify(toolPath)}\n      config:\n        workspaceRoots: ${JSON.stringify(workspaces)}\n        workspaceTargets: ${JSON.stringify(workspaceTargets)}\n        ownerScope: ${JSON.stringify(ownerScope)}\n`;
}

// Preparation is separate from execution for isolated host acceptance. The
// caller owns cleanup after the child exits; no credentials enter the patch.
export async function prepareWebLaunch(args = [], options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const cli = options.cli ?? resolveDshCli();
  const callerEnvironment = options.env ?? process.env;
  const env = {...callerEnvironment, ...(options.record ?? installation())?.env,
    ...(options.provider ?? providerEnvironment()), DSH_CLI: cli};
  // An explicit host home in this launching shell wins over a remembered
  // installation home, so isolated launches keep their intended session scope.
  if (typeof callerEnvironment.DSH_HOME === 'string' && callerEnvironment.DSH_HOME.trim()) env.DSH_HOME = callerEnvironment.DSH_HOME;
  const forwarded = [], workspaces = [resolve(cwd)];
  let profile;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {forwarded.push(...args.slice(i)); break;}
    const workspaceFlag = arg === '--codex-workspace' || arg.startsWith('--codex-workspace=');
    const profileFlag = arg === '--profile' || arg.startsWith('--profile=');
    if (!workspaceFlag && !profileFlag) {forwarded.push(arg); continue;}
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${workspaceFlag ? '--codex-workspace' : '--profile'} requires a value.`);
    if (workspaceFlag) workspaces.push(value);
    else {
      if (profile !== undefined) throw new Error('--profile may be specified only once.');
      if (value.toLowerCase() === 'desktop') throw new Error('The desktop profile is managed by DSH Desktop.');
      profile = value;
    }
  }
  if (forwarded.includes('--dump-default-config')) throw new Error('Use --dump-config to inspect the Web composition including the Codex overlay.');
  workspaceScope(workspaces);
  const requireDsh = createRequire(cli);
  const {resolveDshHome} = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-home-paths')));
  const home = canonicalHome(resolveDshHome(undefined, env));
  const ownerScope = createHash('sha256').update(normalized(home)).digest('hex');
  const temporaryRoot = realpathSync(options.temporaryRoot ?? tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'dsh-web-codex-'));
  const patch = join(directory, 'codex.patch.yml');
  const cleanup = () => {
    if (!existsSync(directory)) return;
    if (dirname(resolve(directory)) !== temporaryRoot || !basename(directory).startsWith('dsh-web-codex-') || normalized(realpathSync(directory)) !== normalized(resolve(directory))) throw new Error('Refusing to remove an unexpected Web overlay directory.');
    rmSync(directory, {recursive: true, force: true});
  };
  try {
    writeFileSync(patch, webOverlay({workspaces, ownerScope}), {mode: 0o600});
    return {spec: commandSpec('dsh', {explicit: cli}),
      args: [...(profile ? ['--profile', profile] : ['web']), '--patch', patch, ...forwarded],
      env, cwd, patch, workspaces, ownerScope, cleanup};
  } catch (error) {cleanup(); throw error;}
}

export async function launchWeb(args) {
  const launch = await prepareWebLaunch(args);
  try {return runCommand(launch.spec, launch.args, {env: launch.env, cwd: launch.cwd});}
  finally {launch.cleanup();}
}
