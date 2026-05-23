import { spawn } from 'child_process'

const child = spawn('/Users/yobach/VSCodeProject/sudocode/scode', ['acp', '--output-format', 'json', '--permission-mode', 'danger-full-access', '--auth', 'proxy', '--model', 'gemini-3-flash-preview'], {
  cwd: '/Users/yobach/Downloads/sudowork',
  env: { ...process.env, SCODE_BRIDGE_MODE: '1', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'https://hk.sudorouter.ai/v1' }
})

child.stdout.on('data', data => process.stdout.write(`\nSTDOUT: ${data.toString()}`))
child.stderr.on('data', data => process.stderr.write(`\nSTDERR: ${data.toString()}`))

// Initial hello
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'm-init', method: 'initialize', params: { protocolVersion: '1.0', clientInfo: { name: 'moss-bridge', version: '1.0' } } }) + '\n')

// Give session/new
setTimeout(() => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'm-session-new', method: 'session/new', params: { cwd: '/Users/yobach/Downloads/sudowork', mcpServers: [] } }) + '\n')
}, 1000)

let sessionId = '';
let gotResponse = false;
child.stdout.on('data', (data) => {
    try {
        const lines = data.toString().split('\n').filter(Boolean);
        for(const line of lines) {
            const parsed = JSON.parse(line);
            if (parsed.id === 'm-session-new') {
                sessionId = parsed.result.sessionId;
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'm-3', method: 'session/prompt', params: { sessionId: sessionId, prompt: [{ type: 'text', text: 'shareone skills?' }] } }) + '\n')
            }
            if (parsed.method === 'session/update') {
               gotResponse = true;
            }
        }
    } catch(e) {}
});

setTimeout(() => {
    if (!gotResponse) {
       console.log("No response received!");
    } else {
       console.log("Response received.");
    }
    child.kill()
}, 3000)
