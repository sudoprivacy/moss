// Controlled protocol producer, not a model or production worker.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [profile, workspace, completion] = process.argv.slice(2);
if (!['plain', 'recoverable'].includes(profile) || !workspace) process.exit(2);
const id = `fixture-${profile}`;
let pending;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const finish = reason => { if (pending) { clearTimeout(pending.timer); send({ id: pending.id, result: { stopReason: reason } }); pending = undefined; } };
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), params = message.params;
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: profile === 'recoverable' } } });
  else if (message.method === 'session/new' && params.cwd === workspace) {
    writeFileSync(join(workspace, 'native-session.json'), JSON.stringify({ sessionId: id }));
    if (completion === 'lost-open') process.exit(0);
    send({ id: message.id, result: { sessionId: id } });
  } else if (message.method === 'session/load' && profile === 'recoverable' && params.cwd === workspace &&
      params.sessionId === JSON.parse(readFileSync(join(workspace, 'native-session.json'), 'utf8')).sessionId) send({ id: message.id, result: {} });
  else if (message.method === 'session/prompt' && params.sessionId === id && !pending) {
    writeFileSync(join(workspace, 'literal-input.json'), JSON.stringify(params.prompt));
    send({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'controlled partial' } } } });
    if (completion === 'crash-turn') process.exit(0);
    pending = { id: message.id, timer: completion === 'finish' ? setTimeout(() => finish('end_turn'), 10) : undefined };
  } else if (message.method === 'session/cancel' && params.sessionId === id) finish('cancelled');
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32602, message: 'Invalid controlled fixture operation' } });
}).on('close', () => { if (pending) clearTimeout(pending.timer); });
// Test-only readiness stays out of the ACP stream and adds no live IPC handle.
if (process.send) process.send({ type: 'standard-acp-fixture-ready' }, () => {
  if (process.connected) process.disconnect();
});
