import {readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parse} from 'smol-toml';

export function contentManifest(root) {
  const files = {};
  function scan(directory, relative = '') {
    for (const name of readdirSync(directory).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const key = relative ? relative + '/' + name : name, path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Release contains a symbolic link: ' + key);
      if (stat.isDirectory()) scan(path, key);
      else files[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  scan(root);
  return files;
}

export function assertUnmodified(record, replaceModified = false) {
  if (!record || replaceModified) return;
  if (!record.integrity) throw new Error('Installed files have no integrity baseline; local changes may be present. Preserve a copy and explicitly use --replace-modified to replace this installation.');
  const actual = contentManifest(record.root);
  const changed = [...new Set([...Object.keys(record.integrity), ...Object.keys(actual)])].filter(key => record.integrity[key] !== actual[key]);
  if (changed.length) throw new Error('Installed files were modified: ' + changed.slice(0, 8).join(', ') + '. Preserve the changes or explicitly use --replace-modified.');
}

export function compareVersions(left, right) {
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(value);
    if (!match) throw new Error('Invalid package version: ' + value);
    return {numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.')};
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i]);
  if (!a.pre || !b.pre) return a.pre === b.pre ? 0 : a.pre ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Math.sign(Number(x) - Number(y));
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function assertUpgrade(current, candidate, {rollback = false} = {}) {
  if (current && !rollback && compareVersions(candidate, current.version) < 0)
    throw new Error(`Refusing downgrade from ${current.version} to ${candidate}. Use an explicit retained-installation rollback instead.`);
}

export function snapshotFile(path) {
  const contents = existsSync(path) ? readFileSync(path) : null;
  return () => {if (contents === null) {if (existsSync(path)) unlinkSync(path);} else writeFileSync(path, contents);};
}

// The parser validates TOML; this lexer only records source spans. Strings are
// atomic, so comments, brackets and fake headers inside them cannot affect scope.
function tomlTokens(text) {
  const tokens = [];
  for (let i = 0; i < text.length;) {
    const start = i, character = text[i];
    if (character === '\n') {tokens.push({start, end: ++i, kind: 'newline'}); continue;}
    if (/\s/.test(character)) {i++; continue;}
    if (character === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      tokens.push({start, end: i, kind: 'comment'}); continue;
    }
    if (character === '"' || character === "'") {
      const triple = text.slice(i, i + 3) === character.repeat(3);
      i += triple ? 3 : 1;
      while (i < text.length) {
        if (character === '"' && text[i] === '\\') {i += 2; continue;}
        if (text[i] === character) {
          if (!triple) {i++; break;}
          let end = i;
          while (text[end] === character) end++;
          if (end - i >= 3) {i = end; break;}
          i = end; continue;
        }
        i++;
      }
      tokens.push({start, end: i, kind: 'string'}); continue;
    }
    if ('[]{}=,.'.includes(character)) {
      tokens.push({start, end: ++i, kind: character}); continue;
    }
    while (i < text.length && !/[\s#"'\[\]{}=,.]/.test(text[i])) i++;
    tokens.push({start, end: i, kind: 'bare'});
  }
  return tokens;
}

function keyPath(key) {
  let value = parse(key + ' = 0'), path = [];
  while (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length !== 1 || Array.isArray(value)) throw new Error('Unsupported TOML key shape.');
    path.push(keys[0]); value = value[keys[0]];
  }
  return path;
}

function tomlStatements(text) {
  const statements = [], headers = [];
  let scope = [], tokens = [], depth = 0;
  function finish(end) {
    const meaningful = tokens.filter(token => !['comment', 'newline'].includes(token.kind));
    if (meaningful.length) {
      if (meaningful[0].kind === '[') {
        const array = meaningful[1]?.kind === '[';
        const left = meaningful[array ? 2 : 1], right = meaningful.at(array ? -3 : -2);
        scope = keyPath(text.slice(left.start, right.end));
        if (array) scope = ['\0array', ...scope];
        headers.push({path: scope, start: meaningful[0].start, end});
      } else {
        const equal = meaningful.findIndex(token => token.kind === '=');
        if (equal < 1) throw new Error('Cannot locate TOML assignment safely.');
        const valueTokens = meaningful.slice(equal + 1);
        statements.push({path: [...scope, ...keyPath(text.slice(meaningful[0].start, meaningful[equal].start))],
          start: valueTokens[0].start, end: valueTokens.at(-1).end, tokens: tokens.filter(token => token.start >= valueTokens[0].start)});
      }
    }
    tokens = [];
  }
  for (const token of tomlTokens(text)) {
    if (token.kind === 'newline' && depth === 0) {finish(token.end); continue;}
    tokens.push(token);
    if (token.kind === '[' || token.kind === '{') depth++;
    if (token.kind === ']' || token.kind === '}') depth--;
  }
  finish(text.length);
  return {statements, headers};
}

const bridgePath = ['mcp_servers', 'dsh_subagent'];
const samePath = (left, right) => left.length === right.length && left.every((key, i) => key === right[i]);
const prefixPath = (prefix, path) => prefix.length <= path.length && prefix.every((key, i) => key === path[i]);
const table = value => value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const quoteKey = key => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);

function parseCodex(text) {
  try {return parse(text, {integersAsBigInt: 'asNeeded'});}
  catch {throw new Error('Invalid Codex TOML; registration was refused before writing.');}
}

function validateBridge(document) {
  const servers = document.mcp_servers, bridge = servers?.dsh_subagent;
  if (servers !== undefined && !table(servers)) throw new Error('Invalid Codex MCP registration shape: mcp_servers must be a table.');
  if (bridge === undefined) return;
  if (!table(bridge) || (bridge.command !== undefined && typeof bridge.command !== 'string') ||
      (bridge.args !== undefined && (!Array.isArray(bridge.args) || bridge.args.some(value => typeof value !== 'string'))) ||
      (bridge.env !== undefined && (!table(bridge.env) || Object.values(bridge.env).some(value => typeof value !== 'string'))))
    throw new Error('Invalid Codex MCP registration shape: bridge command, args or env have invalid types.');
}

// Preserve the original source, including CRLF and unknown values. Replace only
// owned value spans, and independently compare the complete parsed result.
export function updateCodexToml(text, record, config, {completionMode} = {}) {
  if (completionMode !== undefined && !['auto', 'wait', 'native', 'desktop-message'].includes(completionMode))
    throw new Error('Invalid explicit completion mode.');
  const before = parseCodex(text);
  validateBridge(before);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const desired = {command: record.node, args: [join(record.root, 'src/cli.mjs'), 'mcp'],
    DSH_SUBAGENT_STATE: record.state, DSH_SUBAGENT_CONFIG: config};
  if (typeof desired.command !== 'string' || typeof desired.DSH_SUBAGENT_STATE !== 'string' || typeof config !== 'string')
    throw new Error('Invalid bridge launch configuration.');
  function replace(statement, value) {
    // Preserve real comments from inside a replaced multiline value as standalone
    // comments. The trailing comment remains at its original position.
    const comments = statement.tokens.filter(token => token.kind === 'comment' && token.end <= statement.end)
      .map(token => text.slice(token.start, token.end).replace(/\r$/, ''));
    const replacement = JSON.stringify(value) + (comments.length ? newline + comments.join(newline) + newline : '');
    text = text.slice(0, statement.start) + replacement + text.slice(statement.end);
  }
  function set(path, value) {
    const {statements, headers} = tomlStatements(text);
    const existing = statements.find(statement => samePath(statement.path, path));
    if (existing) {replace(existing, value); return;}
    // Inline env is kept inline: update individual members instead of serializing
    // the table, which would discard unknown spelling and formatting.
    const inline = statements.find(statement => samePath(statement.path, path.slice(0, -1)) && text[statement.start] === '{');
    if (inline) {
      const tokens = inline.tokens.filter(token => !['comment', 'newline'].includes(token.kind));
      let depth = 0, member = [];
      const members = [];
      for (const token of tokens.slice(1, -1)) {
        if (token.kind === ',' && depth === 0) {members.push(member); member = []; continue;}
        member.push(token);
        if (token.kind === '[' || token.kind === '{') depth++;
        if (token.kind === ']' || token.kind === '}') depth--;
      }
      if (member.length) members.push(member);
      for (const part of members) {
        const equal = part.findIndex(token => token.kind === '=');
        if (equal < 1) throw new Error('Cannot locate inline env safely.');
        if (samePath(keyPath(text.slice(part[0].start, part[equal].start)), [path.at(-1)])) {
          replace({start: part[equal + 1].start, end: part.at(-1).end, tokens: []}, value); return;
        }
      }
      const close = inline.end - 1;
      text = text.slice(0, close) + (members.length ? ', ' : '') + path.at(-1) + ' = ' + JSON.stringify(value) + text.slice(close);
      return;
    }
    // Other inline parent tables cannot be extended safely with dotted keys.
    if (statements.some(statement => prefixPath(statement.path, path)))
      throw new Error('Unsupported inline bridge parent table; registration was refused before writing.');
    const parent = path.slice(0, -1);
    const explicit = headers.filter(header => prefixPath(header.path, parent)).sort((a, b) => b.path.length - a.path.length)[0];
    if (explicit && (samePath(explicit.path, parent) || statements.some(statement => prefixPath(parent, statement.path)))) {
      const end = headers.find(header => header.start > explicit.start)?.start ?? text.length;
      const assignment = path.slice(explicit.path.length).map(quoteKey).join('.') + ' = ' + JSON.stringify(value);
      text = text.slice(0, end) + (end && text[end - 1] !== '\n' ? newline : '') + assignment + newline + text.slice(end);
    } else if (statements.some(statement => prefixPath(parent, statement.path))) {
      // Existing root dotted keys define an implicit table; keep using that scope.
      const end = headers[0]?.start ?? text.length;
      text = text.slice(0, end) + (end && text[end - 1] !== '\n' ? newline : '') + path.map(quoteKey).join('.') + ' = ' + JSON.stringify(value) + newline + text.slice(end);
    } else {
      text += (text && !text.endsWith('\n') ? newline : '') + newline + '[' + parent.join('.') + ']' + newline + path.at(-1) + ' = ' + JSON.stringify(value) + newline;
    }
  }
  set([...bridgePath, 'command'], desired.command);
  set([...bridgePath, 'args'], desired.args);
  set([...bridgePath, 'env', 'DSH_SUBAGENT_STATE'], desired.DSH_SUBAGENT_STATE);
  set([...bridgePath, 'env', 'DSH_SUBAGENT_CONFIG'], config);
  if (completionMode !== undefined) set([...bridgePath, 'env', 'DSH_COMPLETION_MODE'], completionMode);
  const after = parseCodex(text);
  validateBridge(after);
  const expected = before;
  const newTable = () => Object.create(Object.getPrototypeOf(before));
  expected.mcp_servers ??= newTable();
  expected.mcp_servers.dsh_subagent ??= newTable();
  const bridge = expected.mcp_servers.dsh_subagent;
  bridge.command = desired.command; bridge.args = desired.args;
  bridge.env ??= newTable();
  bridge.env.DSH_SUBAGENT_STATE = desired.DSH_SUBAGENT_STATE; bridge.env.DSH_SUBAGENT_CONFIG = config;
  if (completionMode !== undefined) bridge.env.DSH_COMPLETION_MODE = completionMode;
  if (!isDeepStrictEqual(after, expected)) throw new Error('Codex migration changed an unowned value; registration was refused before writing.');
  return text;
}
