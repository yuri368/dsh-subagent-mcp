import {dirname, join, resolve} from 'node:path';
import {locations, readJson} from './platform.mjs';
import {registerCallbackInDaemon, persistCancellation} from './notify.mjs';
import {completionPolicy} from './completion-policy.mjs';

function parent(extra, ignoreConnection = false) {
  const thread = extra._meta?.threadId;
  const file = ignoreConnection ? undefined : extra._meta?.dshConnection;
  if (!thread) throw new Error('This client does not identify the parent Codex thread. Keep one dsh_wait pending to receive the result, or use the companion callback helper from the parent session.');
  if (!file) {
    return {thread, directory: join(locations().state, 'callbacks')};
  }
  if (dirname(dirname(resolve(file))) !== join(locations().state, 'codex')) throw new Error('Invalid parent connection path.');
  const connection = readJson(file);
  if (!connection) throw new Error('The explicitly configured Codex connection is no longer available; the DSH task remains available.');
  return {thread, file, connection, directory: join(locations().state, 'callbacks')};
}

export async function watchFromMcp(agent, extra, {turn = 'initial'} = {}) {
  const policy = completionPolicy(extra);
  if (policy.mode === 'wait') return {
    agent_id: agent, thread_id: extra._meta?.threadId,
    status: 'wait_required', delivery: 'wait', ...policy,
  };
  const {thread, file, directory} = parent(extra, policy.mode === 'desktop-message');
  const env = {...process.env};
  delete env.DSH_CODEX_TOKEN; delete env.DSH_CODEX_REMOTE; delete env.DSH_CODEX_CONNECTION;
  if (file) {
    env.DSH_CODEX_CONNECTION = file;
  }
  const delivery = policy.mode === 'desktop-message' ? 'desktop-message' : 'tool-output';
  if (delivery === 'desktop-message') {
    if (!extra._meta?.dshDesktopPipe) return {
      agent_id:agent,thread_id:thread,status:'setup_failed',delivery,
      next_action:'wait_for_completion',instructions:'Desktop app-tools pipe is unavailable. Keep one dsh_wait without seconds pending for the same agent.',
    };
    env.CODEX_APP_TOOLS_PIPE_PATH = extra._meta.dshDesktopPipe;
    if (extra._meta.dshDesktopHost) env.CODEX_APP_TOOLS_CALLER_HOST_ID = extra._meta.dshDesktopHost;
    else delete env.CODEX_APP_TOOLS_CALLER_HOST_ID;
    // The caller may choose its Desktop pipe, but cannot select executable code
    // for this privileged host-side listener through untrusted MCP metadata.
    delete env.DSH_DESKTOP_MCP_SERVER; delete env.DSH_DESKTOP_MCP_NODE;
  }
  const receipt = await registerCallbackInDaemon({agent, thread, turn, delivery, state: locations().state}, {env, temp: directory});
  if (receipt.status === 'watching') {
    receipt.next_action = 'do_independent_work_or_end_response';
    receipt.instructions = 'When only this result remains pending, end your current response in the final channel now. The callback will wake you for result acceptance. Do not keep the turn open with sleep, wait tools, or polling.';
  } else if (['delivered','queued','delivery_uncertain','delivery_failed','cancelled','stopped','delivery_attempting'].includes(receipt.status)) {
    receipt.next_action = receipt.status === 'delivery_uncertain' || receipt.status === 'delivery_attempting' ? 'inspect_parent_and_saved_result_without_resending' : 'read_saved_result';
    receipt.instructions = 'This execution already has a persistent delivery or cancellation record. Repeated registration does not send it again. Read the saved result; uncertain delivery requires checking the parent chat before any manual decision.';
  } else {
    receipt.next_action = 'wait_for_completion';
    receipt.instructions = 'No completion callback was registered. The DSH task remains available. Keep one dsh_wait without seconds pending until it settles; do not end the parent response expecting an automatic wakeup.';
  }
  return receipt;
}

export function unwatchFromMcp(agent, directory, extra) {
  const {thread, directory: expected} = parent(extra, extra._meta?.dshCompletionMode === 'desktop-message');
  if (dirname(resolve(directory)) !== resolve(expected)) throw new Error('Invalid callback directory.');
  const receipt = readJson(join(directory, 'callback.json'));
  if (receipt?.thread_id !== thread || receipt.agent_id !== agent) throw new Error('The callback belongs to a different parent or agent.');
  persistCancellation(directory);
  return {agent_id: agent, thread_id: thread, status: 'cancellation_requested'};
}
