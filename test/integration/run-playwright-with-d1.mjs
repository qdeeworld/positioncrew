import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const playwright = resolve(root, "node_modules/.bin/playwright");
const config = resolve(root, "dist/server/wrangler.local.json");

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object", "Expected an allocated local TCP port");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

function startWorker(port, stateDirectory) {
  const output = [];
  const child = spawn(
    wrangler,
    [
      "dev",
      "--local",
      "--config",
      config,
      "--persist-to",
      stateDirectory,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "error",
    ],
    {
      cwd: root,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output.push(chunk);
      if (output.join("").length > 20_000) output.shift();
    });
  }
  return { child, output };
}

async function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(3_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function waitForWorker(baseUrl, worker) {
  const expiresAt = Date.now() + 20_000;
  while (Date.now() < expiresAt) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(`Local Worker exited before readiness:\n${worker.output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/providers`);
      if (response.ok) return;
    } catch {
      // Wrangler is still starting.
    }
    await delay(100);
  }
  throw new Error(`Local Worker did not become ready:\n${worker.output.join("")}`);
}

async function runPlaywright(baseUrl, worker) {
  const child = spawn(playwright, ["test"], {
    cwd: root,
    env: { ...process.env, CI: "1", PLAYWRIGHT_BASE_URL: baseUrl },
    stdio: "inherit",
  });
  const result = await new Promise((resolveResult, rejectResult) => {
    child.once("error", rejectResult);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) {
    const workerExited = worker.child.exitCode !== null || worker.child.signalCode !== null;
    const workerFailure = workerExited
      ? `\nLocal Worker exited during Playwright with ${
          worker.child.exitCode === null ? `signal ${worker.child.signalCode}` : `code ${worker.child.exitCode}`
        }:\n${worker.output.join("")}`
      : "";
    throw new Error(
      `Playwright exited with ${result.code === null ? `signal ${result.signal}` : `code ${result.code}`}${workerFailure}`,
    );
  }
}

async function main() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "positioncrew-playwright-d1-"));
  let worker;
  try {
    await execFileAsync(
      wrangler,
      [
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--config",
        config,
        "--persist-to",
        stateDirectory,
      ],
      {
        cwd: root,
        env: { ...process.env, CI: "1" },
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    worker = startWorker(port, stateDirectory);
    await waitForWorker(baseUrl, worker);
    console.log(`Running Playwright against isolated local D1 at ${baseUrl}`);
    await runPlaywright(baseUrl, worker);
  } finally {
    if (worker) await stopWorker(worker.child);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

await main();
