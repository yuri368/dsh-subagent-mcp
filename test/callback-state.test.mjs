import test from 'node:test';
import assert from 'node:assert/strict';
import {callbackTurn} from '../src/callback-state.mjs';

test('external callback identity requires a confirmed execution and no unbound queued requests',()=>{
 for(const record of [{external:true,created_at:'legacy-date'},{external:true,execution_identity_state:'unknown',message_id:'request-id'},{external:true,execution_identity_state:'confirmed'},{external:true,execution_identity_state:'confirmed',execution_id:'turn:1',pending_requests:[{request_id:'future'}]}]) assert.throws(()=>callbackTurn(record),/identity|queued requests/);
 assert.equal(callbackTurn({external:true,execution_identity_state:'confirmed',execution_id:'turn:1',pending_requests:[]}), 'turn:1');
 assert.equal(callbackTurn({execution_id:'managed-execution'}),'managed-execution');
});
