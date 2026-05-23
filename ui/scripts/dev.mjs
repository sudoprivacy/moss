import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiRoot = path.resolve(__dirname, '..');
const viteBin = path.join(uiRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const electronBin = path.join(uiRoot, 'node_modules', 'electron', 'cli.js');
const watchedFiles = [
  path.join(uiRoot, 'src', 'main.mjs'),
  path.join(uiRoot, 'src', 'preload.mjs'),
  path.join(uiRoot, 'src', 'app-preload.mjs'),
];
const command = process.argv[2] || 'start';

let electronProcess = null;
let shuttingDown = false;
let restartTimer = null;
let devServerUrl = '';

if (command !== 'start') {
  console.error('Usage: node scripts/dev.mjs start');
  process.exit(1);
}

function spawnChild(command, args, extraEnv = {}) {
  return spawn(process.execPath, [command, ...args], {
    cwd: uiRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

function findAvailablePort(preferred, maxAttempts = 20) {
  for (let index = 0; index < maxAttempts; index += 1) {
    const port = preferred + index;
    try {
      execSync(
        `node -e "const s=require('net').createServer();s.listen(${port},'127.0.0.1',()=>{s.close();process.exit(0)});s.on('error',()=>process.exit(1))"`,
        { timeout: 2000, stdio: 'ignore' }
      );
      return port;
    } catch {
      // try next port
    }
  }
  throw new Error(`No available port in range ${preferred}-${preferred + maxAttempts - 1}`);
}

function isServerReady(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve((response.statusCode || 500) < 500);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerReady(url)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for Vite dev server at ${url}`);
}

function stopElectron() {
  if (!electronProcess || electronProcess.killed) return;
  electronProcess.kill('SIGTERM');
}

function startElectron() {
  stopElectron();
  electronProcess = spawnChild(electronBin, ['.'], {
    VITE_DEV_SERVER_URL: devServerUrl,
    NODE_ENV: 'development',
  });

  electronProcess.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (signal === 'SIGTERM') return;
    if (code && code !== 0) {
      console.error(`electron exited with code ${code}`);
    }
  });
}

function scheduleElectronRestart() {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startElectron();
  }, 150);
}

function shutdown(viteProcess) {
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  stopElectron();
  if (viteProcess && !viteProcess.killed) {
    viteProcess.kill('SIGTERM');
  }
}

async function main() {
  let vitePort;
  try {
    vitePort = findAvailablePort(5173, 30);
  } catch {
    vitePort = findAvailablePort(5500, 20);
  }

  devServerUrl = `http://127.0.0.1:${vitePort}`;
  console.log(`Starting dev server at ${devServerUrl}`);

  const viteProcess = spawnChild(viteBin, [], {
    NODE_ENV: 'development',
    VITE_DEV_SERVER_PORT: String(vitePort),
  });

  viteProcess.on('exit', (code) => {
    if (!shuttingDown) {
      shutdown(viteProcess);
      process.exit(code || 0);
    }
  });

  for (const filePath of watchedFiles) {
    fs.watch(filePath, () => {
      scheduleElectronRestart();
    });
  }

  process.on('SIGINT', () => {
    shutdown(viteProcess);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdown(viteProcess);
    process.exit(0);
  });

  await waitForServer(devServerUrl);
  startElectron();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
