import {spawn} from 'node:child_process';
import {Duplex} from 'node:stream';
import WebSocket from 'ws';
import {installation} from './platform.mjs';
import {commandSpec} from './commands.mjs';

// Windows exposes the existing Codex daemon through the official proxy.
// The proxy carries raw WebSocket bytes; it does not own the daemon.
export function openNativeCodexSocket({env = process.env, spec = installation()?.codex || commandSpec('codex')} = {}) {
  const [file, ...prefix] = spec;
  const child = spawn(file, [...prefix, 'app-server', 'proxy'], {env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  let stderr = '';
  child.stderr.on('data', data => {stderr = (stderr + data.toString()).slice(-4000);});
  const tunnel = new Duplex({
    read() {child.stdout.resume();},
    write(data, encoding, done) {child.stdin.write(data, encoding, done);},
    final(done) {child.stdin.end(); done();},
    destroy(error, done) {child.kill(); done(error);},
  });
  child.stdout.on('data', data => {if (!tunnel.push(data)) child.stdout.pause();});
  child.stdin.on('error', error => tunnel.destroy(error));
  child.stdout.on('error', error => tunnel.destroy(error));
  // Wait for close, which follows stderr draining, before turning proxy EOF
  // into a WebSocket handshake error. Keep the actual failure diagnostic.
  child.once('close', (code, signal) => {
    if (tunnel.destroyed) return;
    if (code !== 0) tunnel.destroy(new Error(`Codex app-server proxy exited (${code ?? signal}): ${stderr.trim() || 'No diagnostic output'}`));
    else tunnel.push(null);
  });
  const socket = new WebSocket('ws://localhost/', {createConnection: () => tunnel, handshakeTimeout: 10000});
  child.once('error', error => tunnel.destroy(error));
  socket.once('close', () => {tunnel.destroy(); child.kill();});
  return socket;
}
