import test from 'node:test';
import assert from 'node:assert/strict';
import {codexCliEnvironment} from '../src/codex-launch.mjs';
import {completionContext} from '../src/completion-policy.mjs';

test('CLI launched from Desktop resolves native mode without inheriting the Desktop parent', () => {
  const parent = {CODEX_APP_TOOLS_PIPE_PATH:'desktop-pipe', CODEX_APP_TOOLS_CALLER_HOST_ID:'desktop-host',
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE:'Codex Desktop', CODEX_THREAD_ID:'desktop-parent', DSH_COMPLETION_MODE:'auto',
    DSH_CODEX_CONNECTION:'cli-connection', CUSTOM:'preserved'};
  const cli = codexCliEnvironment(parent);
  assert.equal(completionContext(parent).dshCompletionMode,'desktop-message');
  assert.equal(completionContext(cli).dshCompletionMode,'native');
  for (const key of ['CODEX_APP_TOOLS_PIPE_PATH','CODEX_APP_TOOLS_CALLER_HOST_ID','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_THREAD_ID']) assert.equal(cli[key],undefined);
  assert.equal(cli.DSH_CODEX_CONNECTION,'cli-connection');
  assert.equal(cli.CUSTOM,'preserved');
  assert.equal(parent.CODEX_THREAD_ID,'desktop-parent');
  assert.equal(codexCliEnvironment({CODEX_INTERNAL_ORIGINATOR_OVERRIDE:'custom-cli'}).CODEX_INTERNAL_ORIGINATOR_OVERRIDE,'custom-cli');
});
