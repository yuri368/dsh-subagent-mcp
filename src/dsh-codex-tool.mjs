import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {delegateCodex, delegationPolicy} from './codex-delegate.mjs';
import {workspaceScope} from './web-launch.mjs';

const requireDsh = createRequire(process.env.DSH_CLI);
const {defineTool} = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tools')));
export const name = 'dsh-codex-tool';
export const inject = ['agents', 'permissionPresets'];

export function apply(ctx, config = {}) {
  return mountCodexTool(ctx, config);
}

// Dependency injection here is for focused lifecycle tests, not an alternate
// production tool implementation. apply always uses DSH's real defineTool.
export function mountCodexTool(ctx, config = {}, {define = defineTool, delegate = delegateCodex} = {}) {
  const scoped = config.workspaceRoots !== undefined;
  if (scoped && (typeof config.ownerScope !== 'string' || !/^[a-f0-9]{64}$/.test(config.ownerScope))) throw new Error('Codex Web delegation requires a valid host owner scope.');
  const checkCwd = scoped ? workspaceScope(config.workspaceRoots, config.workspaceTargets) : cwd => cwd;
  const mounted = new WeakSet();
  const install = agent => {
    // Minimal deliberately keeps its one-shell contract. Standard and legacy
    // bridge agents receive a scoped worker tool, owned by their agent lifetime.
    if (mounted.has(agent) || agent.session.header.agentPreset === 'minimal') return;
    if (scoped) {
      try {checkCwd(agent.session.header.cwd);} catch {return;}
    }
    mounted.add(agent);
    agent.ctx.inject(['tools'], runtime => runtime.tools.register(define({
      name: 'codex_delegate',
      description: 'Delegate a bounded task to a real Codex worker and wait for its final result. Save thread_id for owned follow-ups. Explicit simple mechanical tasks use Luna/medium; normal, complex or uncertain work defaults to Sol/medium. Minimum reasoning effort is medium. No extra classifier model is called. DSH-to-Codex delegation cannot select or resume Astra; requests fail before worker launch. Directory and access inherit the parent with no escalation or recursive delegation.',
      parameters: {
        task: {type: 'string', required: true, description: 'Self-contained task, constraints and expected evidence.'},
        thread_id: {type: 'string', description: 'A thread_id returned by an earlier call from this same DSH session; omit for a new worker.'},
        task_kind: {type: 'string', enum: ['simple', 'normal', 'ambiguous', 'analysis'], description: 'simple only for clear mechanical/repetitive work; normal, ambiguous or analysis use Sol by default. Astra is forbidden for every task kind.'},
        model: {type: 'string', description: 'Optional available model override. Astra models and aliases are forbidden for DSH-to-Codex delegation.'},
        astra: {type: 'object', additionalProperties: false, properties: {sol_thread_id: {type: 'string'}, difficulty_reason: {type: 'string'}, analysis_objective: {type: 'string'}, second_analysis_reason: {type: 'string'}}, description: 'Legacy compatibility field; ignored. It never authorizes Astra delegation.'},
        effort: {type: 'string', enum: ['medium','high','xhigh','max','ultra'], description: 'Optional reasoning effort; default medium. Luna allows medium/high/xhigh/max. Sol also allows ultra. Lower efforts are rejected.'},
      },
      timeoutMs: 3600000,
      output: {
        schema: {type: 'object', additionalProperties: false, properties: {
          thread_id: {type: 'string', required: true}, turn_id: {type: 'string', required: true},
          status: {type: 'string', required: true}, answer: {type: 'string', required: true},
          model: {type: 'string', required: true}, cwd: {type: 'string', required: true},
          permission: {type: 'string', required: true}, error: {type: 'string'}, routing: {type: 'object', additionalProperties: true, properties: {}},
        }},
        render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}],
      },
      isConcurrencySafe: () => false,
      execute(args, exec) {
        if (exec.agent !== agent) throw new Error('Codex delegation requires its owning DSH agent.');
        if (agent.session.header.agentPreset === 'minimal') throw new Error('Minimal agents do not support Codex delegation.');
        const cwd = checkCwd(agent.session.header.cwd);
        const permission = ctx.permissionPresets.current(agent.session);
        delegationPolicy(permission, cwd);
        const owner = scoped ? `web:${config.ownerScope}:${String(agent.session.id)}` : String(agent.session.id);
        return delegate({task: args.task, threadId: args.thread_id, cwd,
          owner, permission, model: args.model, effort: args.effort, taskKind: args.task_kind}, {signal: exec.signal});
      },
    })));
  };
  ctx.on('agent/created', ({agent}) => install(agent));
  for (const agent of ctx.agents.list()) install(agent);
}
