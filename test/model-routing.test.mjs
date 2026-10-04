import test from 'node:test';
import assert from 'node:assert/strict';
import {routeCodex, isAstra, requireExecutableRouting} from '../src/model-routing.mjs';

test('classification is deterministic and uncertain work uses Sol', () => {
  for (const taskKind of [undefined, 'normal', 'ambiguous']) {
    const route = routeCodex({taskKind});
    assert.equal(route.model, 'gpt-6.1-sol');
    assert.equal(route.effort, 'medium');
    assert.match(route.reason, /defaults to Sol/);
  }
  assert.equal(routeCodex({taskKind: 'simple'}).model, 'gpt-6-luna');
  assert.equal(routeCodex({taskKind: 'simple', env: {DSH_CODEX_EFFORT: 'high'}}).effort, 'medium');
  assert.throws(() => routeCodex({taskKind: 'guess'}), /Unknown/);
});

test('followups retain audited normal selections and simple can explicitly promote', () => {
  const prior = {model: 'gpt-6-luna', routing: {task_kind: 'simple', effort: 'low'}};
  assert.equal(routeCodex({prior}).model, 'gpt-6-luna');
  assert.equal(routeCodex({prior}).effort, 'medium');
  assert.equal(routeCodex({prior, taskKind: 'normal'}).model, 'gpt-6.1-sol');
  assert.equal(routeCodex({model: 'gpt-6-sol'}).model, 'gpt-6-sol');
});

test('Astra models and aliases are forbidden for explicit selection and environment defaults', () => {
  const astra = {sol_thread_id: 'owned-thread', difficulty_reason: 'Sol exhausted the causal hypotheses', analysis_objective: 'Identify the unsolved concurrency invariant'};
  const solRecord = {model: 'gpt-6.1-sol', status: 'completed', turn_id: 'sol-turn', effort: 'ultra'};
  for (const model of ['astra', 'ASTRA', 'gpt-6-astra', 'GPT-6-ASTRA', 'gpt-6-astra-latest', '  gpt-6-astra  ']) {
    assert.equal(isAstra(model), true);
    for (const taskKind of [undefined, 'simple', 'normal', 'ambiguous', 'analysis'])
      assert.throws(() => routeCodex({model, taskKind, astra, solRecord}), error => error.code === 'ASTRA_DELEGATION_FORBIDDEN');
    assert.throws(() => routeCodex({env: {DSH_CODEX_MODEL: model}}), error => error.code === 'ASTRA_DELEGATION_FORBIDDEN');
  }
  for (const model of ['astral', 'gpt-6-astral', 'gpt-6.1-sol', 'gpt-6-luna']) assert.equal(isAstra(model), false);
  // An unused default does not prevent an explicit safe selection.
  assert.equal(routeCodex({taskKind: 'simple', env: {DSH_CODEX_MODEL: 'astra'}}).model, 'gpt-6-luna');
  assert.equal(routeCodex({model: 'gpt-6.1-sol', env: {DSH_CODEX_MODEL: 'astra'}}).model, 'gpt-6.1-sol');
});

test('saved Astra sessions cannot be inherited or resumed with a safe override', () => {
  for (const prior of [
    {model: 'GPT-6-ASTRA'},
    {routing: {model: 'astra', astra_analysis_turns: 1, analysis_only: true}},
    {model: 'gpt-6.1-sol', routing: {model: 'gpt-6-astra'}},
  ]) {
    for (const change of [{}, {model: 'gpt-6.1-sol'}, {taskKind: 'simple'}])
      assert.throws(() => routeCodex({prior, ...change}), error => error.code === 'ASTRA_DELEGATION_FORBIDDEN');
  }
  const safe = routeCodex({prior: {model: 'gpt-6.1-sol', routing: {effort: 'high', astra_analysis_turns: 2}, sol_attempt: {effort: 'ultra'}}});
  assert.equal(safe.effort, 'high');
  assert.equal('astra_analysis_turns' in safe, false);
  assert.equal('analysis_only' in safe, false);
});

test('new explicit efforts enforce the user floor and model-specific maximum', () => {
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) {
    const input = {model};
    for (const effort of ['none', 'minimal', 'low', '', 'invalid'])
      assert.throws(() => routeCodex({...input, effort}), /minimum reasoning effort is medium/);
    for (const effort of ['medium', 'high', 'xhigh', 'max']) assert.equal(routeCodex({...input,effort}).effort, effort);
    if (model === 'gpt-6-luna') assert.throws(() => routeCodex({...input,effort:'ultra'}), /minimum reasoning/);
    else assert.equal(routeCodex({...input,effort:'ultra'}).effort, 'ultra');
  }
});

test('old low defaults migrate but safe saved effort is retained', () => {
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) {
    for (const effort of ['none', 'minimal', 'low']) {
      assert.equal(routeCodex({env:{DSH_CODEX_MODEL:model,DSH_CODEX_EFFORT:effort}}).effort, 'medium');
      assert.equal(routeCodex({prior:{model,routing:{effort}}}).effort, 'medium');
    }
    assert.equal(routeCodex({prior:{model,routing:{effort:'high'}}}).effort, 'high');
  }
});

test('delegation policy is model based and independent of historical isolation flags', () => {
  assert.throws(() => requireExecutableRouting({model: 'gpt-6-astra'}), error => error.code === 'ASTRA_DELEGATION_FORBIDDEN');
  for (const model of ['gpt-6.1-sol', 'gpt-6-luna']) assert.doesNotThrow(() => requireExecutableRouting({model, analysis_only: true}));
});
