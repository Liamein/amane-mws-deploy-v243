import 'dotenv/config';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { startCloudStateSync } from './state-sync.js';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));

export async function startKoyebService({
  port = Number(process.env.PORT || 8080),
  botArgs = [fileURLToPath(new URL('./bot.js', import.meta.url))],
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }

  const stateSync = await startCloudStateSync();
  let stopping = false;
  let child = null;
  let childExited = true;
  let restartTimer = null;
  let childExitPromise = Promise.resolve();
  let resolveClosed;
  const closed = new Promise((resolveResult) => { resolveClosed = resolveResult; });

  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      return response.end('Method Not Allowed');
    }
    const path = request.url?.split('?')[0];
    if (!['/', '/healthz', '/health'].includes(path)) {
      response.writeHead(404);
      return response.end('Not Found');
    }
    if (path === '/health') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.writeHead(childExited ? 503 : 200);
      return response.end(JSON.stringify({ status: childExited ? 'recovering' : 'ok', process: childExited ? 'stopped' : 'running', pid: child?.pid || null, restartScheduled: Boolean(restartTimer), uptimeSeconds: Math.floor(process.uptime()) }));
    }
    // This is a liveness endpoint for Render/UptimeRobot.  It intentionally
    // stays successful while Discord reconnects, so a temporary Gateway
    // failure cannot make the entire service look offline or trigger a sleep.
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.writeHead(200);
    response.end('OK');
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;

  await new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolveListening();
    });
  });

  function scheduleBotRestart() {
    if (stopping || restartTimer) return;
    console.error('Discord bot process stopped. Retrying in 5 minutes while the health endpoint remains available.');
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startBotProcess();
    }, 5 * 60_000);
  }

  function startBotProcess() {
    if (stopping) return;
    childExited = false;
    let resolveChildExit;
    childExitPromise = new Promise((resolveChild) => { resolveChildExit = resolveChild; });
    child = spawn(process.execPath, botArgs, {
      cwd: projectDirectory,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    console.log(`Discord bot process started (pid ${child.pid}).`);
    child.once('error', (error) => {
      console.error(`Discord bot process could not be started: ${error.message}`);
    });
    child.once('close', (code, signal) => {
      childExited = true;
      child = null;
      resolveChildExit();
      if (!stopping) {
        console.error(`Discord bot process exited (code: ${code ?? 'none'}, signal: ${signal ?? 'none'}).`);
        scheduleBotRestart();
      }
    });
  }

  startBotProcess();

  async function stop(exitCode = 0) {
    if (stopping) return closed;
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const serverClosed = new Promise((resolveServer) => server.close(resolveServer));
    server.closeIdleConnections();
    if (!childExited && child) child.kill('SIGTERM');
    const deadline = setTimeout(() => {
      if (!childExited && child) child.kill('SIGKILL');
      server.closeAllConnections();
    }, 10000);
    await Promise.all([serverClosed, childExitPromise]);
    await stateSync.stop();
    clearTimeout(deadline);
    resolveClosed(exitCode);
    return closed;
  }

  server.on('error', () => {
    console.error('HTTP health server failed.');
    void stop(1);
  });
  console.log(`HTTP health server listening on 0.0.0.0:${server.address().port}`);
  return { server, stop, closed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    loadConfig();
    const service = await startKoyebService();
    process.once('SIGTERM', () => void service.stop());
    process.once('SIGINT', () => void service.stop());
    process.exit(await service.closed);
  } catch (error) {
    // Errors raised here contain only configuration names or HTTP status codes.
    // Keep the actionable cause in Render logs without ever printing secret values.
    console.error(`Startup failed: ${error.message}`);
    process.exit(1);
  }
}
