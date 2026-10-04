export const DEFAULT_SOL = 'gpt-6.1-sol';
export const DEFAULT_LUNA = 'gpt-6-luna';
export const isAstra = model => typeof model === 'string' && /(?:^|-)astra(?:$|-)/i.test(model.trim());
export const isSol = model => /(?:^|-)sol(?:$|-)/i.test(model || '');
export const isLuna = model => /(?:^|-)luna(?:$|-)/i.test(model || '');
// This boundary applies only to DSH-to-Codex delegation. It does not depend on
// host tool isolation and does not restrict Codex's own built-in subagents.
export function requireExecutableRouting(routing) {
  if (isAstra(routing?.model)) {
    const error = new Error('DSH-to-Codex delegation cannot select or resume Astra. Use Sol/Luna; analysis eligibility, historical sessions and environment defaults cannot bypass this policy.');
    error.code = 'ASTRA_DELEGATION_FORBIDDEN';
    throw error;
  }
}

function reasoningEffort(model, explicit, fallback) {
  const allowed = isLuna(model) ? ['medium', 'high', 'xhigh', 'max'] : ['medium', 'high', 'xhigh', 'max', 'ultra'];
  // Migrate saved installation and old conversation defaults without allowing
  // a new explicit request to bypass the user's minimum reasoning policy.
  const legacy = ['none', 'minimal', 'low'];
  const selected = explicit ?? (legacy.includes(fallback) ? 'medium' : fallback) ?? 'medium';
  if (!allowed.includes(selected)) throw new Error(`Codex ${model} effort must be ${allowed.join(', ')}; minimum reasoning effort is medium.`);
  return selected;
}

// Classification is supplied by the caller, never guessed from task prose and
// never obtained by spending another model request. Unknown complexity is Sol.
export function routeCodex({taskKind, model, effort, prior, env = {}} = {}) {
  if (taskKind !== undefined && !['simple', 'normal', 'ambiguous', 'analysis'].includes(taskKind))
    throw new Error('Unknown Codex task_kind. Use simple, normal, ambiguous or analysis.');
  // Reject saved Astra sessions before any resume, even with a Sol override.
  // Check both historical model fields rather than silently rewriting history.
  requireExecutableRouting(prior);
  requireExecutableRouting(prior?.routing);
  const inherited = taskKind === undefined ? prior?.model ?? prior?.routing?.model : undefined;
  const selected = model ?? inherited ?? (taskKind === 'simple' ? DEFAULT_LUNA : env.DSH_CODEX_MODEL || DEFAULT_SOL);
  requireExecutableRouting({model: selected});
  const reason = model ? 'explicit model override' : inherited ? 'retained prior model' : taskKind === 'simple' ? 'explicit simple mechanical task' : 'normal or uncertain complexity defaults to Sol';
  const fallback = taskKind === 'simple' ? 'medium' : inherited ? prior?.routing?.effort : env.DSH_CODEX_EFFORT;
  return {model: selected, effort: reasoningEffort(selected, effort, fallback),
    task_kind: taskKind ?? (inherited ? prior?.routing?.task_kind || 'normal' : 'normal'), reason};
}
