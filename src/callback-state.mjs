import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {locations} from './platform.mjs';

// Helpers invoked directly from the installed skill do not carry MCP metadata.
// Read the same durable agent identity without issuing another task or prompt.
export function savedCallbackTurn(agent, state = locations().state) {
  const path=join(state,'state.sqlite');
  if (!existsSync(path)) return 'initial'; // Legacy/non-database bridge integration.
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const row=db.prepare('SELECT data FROM agents WHERE id=?').get(agent);
    if(!row) throw new Error('Unknown persistent agent; refusing callback registration: ' + agent);
    const record=JSON.parse(row.data);
    return callbackTurn(record);
  } finally {db.close();}
}

export function callbackTurn(record) {
  if (record.external) {
    if (record.execution_identity_state !== 'confirmed' || !record.execution_id) throw new Error('External Web execution identity is unknown; refusing callback registration. Keep one dsh_wait pending for the same agent.');
    if (record.pending_requests?.length) throw new Error('External Web queued requests are not yet bound to a confirmed execution; keep one dsh_wait pending and register after their execution identity is confirmed.');
  }
  return record.execution_id || record.message_id || record.created_at || 'initial';
}

export function validatePersistentCallbackTurn(agent,turn,state=locations().state) {
  if (!existsSync(join(state,'state.sqlite'))) return;
  const saved=savedCallbackTurn(agent,state);
  if (saved !== turn) throw new Error('Callback execution identity differs from the persistent agent; refusing registration.');
}
