import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const config = resolve(root, "dist/server/wrangler.local.json");
const persistence = await mkdtemp(join(tmpdir(), "positioncrew-shadow-grid-d1-"));
const token = "positioncrew-shadow-grid-integration-token";
const testNow = new Date();
testNow.setUTCMinutes(2, 0, 0);
if (testNow.getTime() > Date.now()) testNow.setUTCHours(testNow.getUTCHours() - 1);

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return address.port;
}

async function waitForWorker(baseUrl) {
  const expiresAt = Date.now() + 20_000;
  while (Date.now() < expiresAt) {
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.fail("Local Worker did not become ready");
}

async function startWorker(port) {
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--local",
      "--config",
      config,
      "--port",
      String(port),
      "--persist-to",
      persistence,
      "--var",
      `SHADOW_GRID_TICK_TOKEN:${token}`,
      "--var",
      `SHADOW_GRID_TEST_NOW:${testNow.toISOString()}`,
    ],
    { cwd: root, stdio: "ignore" },
  );
  await waitForWorker(`http://127.0.0.1:${port}`);
  return child;
}

async function stopWorker(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    child.once("exit", resolvePromise);
    setTimeout(resolvePromise, 2_000);
  });
}

async function requestJson(baseUrl, path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  return { response, body };
}

function expectMutationRejected(sql) {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--config",
      config,
      "--persist-to",
      persistence,
      "--command",
      sql,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, `D1 unexpectedly accepted: ${sql}`);
  assert.match(`${result.stderr}${result.stdout}`, /append|immutable|prohibited|abort/u);
}

let worker;
try {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      config,
      "--persist-to",
      persistence,
    ],
    { cwd: root, stdio: "ignore" },
  );

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port);

  const unauthorized = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST" },
  );
  assert.equal(unauthorized.response.status, 401);

  const historical = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick?runId=historical-repair",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  assert.equal(historical.response.status, 400);

  const headers = {
    Authorization: `Bearer ${token}`,
    "X-GitHub-Event": "schedule",
    "X-GitHub-Repository": "dolepee/positioncrew",
    "X-GitHub-Run-Id": "1001",
    "X-GitHub-Run-Attempt": "1",
    "X-GitHub-Sha": "1".repeat(40),
    "X-GitHub-Workflow-Ref":
      "dolepee/positioncrew/.github/workflows/bounded-grid-shadow-ledger.yml@refs/heads/main",
  };
  const first = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers },
  );
  assert.equal(first.response.status, 200);
  assert.equal(
    first.body.schemaVersion,
    "positioncrew.bounded-grid-forward-shadow-tick.v1",
  );
  assert.equal(first.body.accepted, true);
  assert.match(first.body.headHash, /^sha256:[a-f0-9]{64}$/u);

  const retry = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers },
  );
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.headHash, first.body.headHash);

  const summaryBeforeRestart = await requestJson(
    baseUrl,
    "/api/evidence/bounded-grid-forward-shadow",
  );
  assert.equal(summaryBeforeRestart.response.status, 200);
  assert.equal(
    summaryBeforeRestart.body.schemaVersion,
    "positioncrew.bounded-grid-forward-shadow-ledger.v1",
  );
  assert(summaryBeforeRestart.body.recentWindows.length >= 1);

  const runId = summaryBeforeRestart.body.recentWindows[0].windowId;
  const windowBeforeRestart = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(runId)}`,
  );
  assert.equal(windowBeforeRestart.response.status, 200);
  assert.equal(windowBeforeRestart.body.window.windowId, runId);
  assert(windowBeforeRestart.body.events.length >= 1);

  await stopWorker(worker);
  worker = await startWorker(port);

  const summaryAfterRestart = await requestJson(
    baseUrl,
    "/api/evidence/bounded-grid-forward-shadow",
  );
  assert.equal(summaryAfterRestart.response.status, 200);
  assert(Number.isFinite(Date.parse(summaryBeforeRestart.body.generatedAt)));
  assert(Number.isFinite(Date.parse(summaryAfterRestart.body.generatedAt)));
  const { generatedAt: _summaryBeforeGeneratedAt, ...summaryBeforeDurable } = summaryBeforeRestart.body;
  const { generatedAt: _summaryAfterGeneratedAt, ...summaryAfterDurable } = summaryAfterRestart.body;
  assert.deepEqual(summaryAfterDurable, summaryBeforeDurable);

  const windowAfterRestart = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(runId)}`,
  );
  assert.equal(windowAfterRestart.response.status, 200);
  assert(Number.isFinite(Date.parse(windowBeforeRestart.body.generatedAt)));
  assert(Number.isFinite(Date.parse(windowAfterRestart.body.generatedAt)));
  const { generatedAt: _windowBeforeGeneratedAt, ...windowBeforeDurable } = windowBeforeRestart.body;
  const { generatedAt: _windowAfterGeneratedAt, ...windowAfterDurable } = windowAfterRestart.body;
  assert.deepEqual(windowAfterDurable, windowBeforeDurable);

  await stopWorker(worker);
  worker = undefined;

  expectMutationRejected(
    "UPDATE shadow_grid_events SET recorded_at = recorded_at WHERE event_sequence = 0",
  );
  expectMutationRejected(
    "DELETE FROM shadow_grid_events WHERE event_sequence = 0",
  );

  console.log(
    `D1 forward-shadow integration retained ${windowBeforeRestart.body.events.length} canonical events`,
  );
} finally {
  if (worker) await stopWorker(worker);
  await rm(persistence, { recursive: true, force: true });
}
