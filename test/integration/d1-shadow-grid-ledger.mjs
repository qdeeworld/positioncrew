import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const config = resolve(root, "dist/server/wrangler.local.json");
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const boundedGridFixture = JSON.parse(
  await readFile(resolve(root, "fixtures/bounded-grid/bnb-usdt-grid.v1.json"), "utf8"),
);
const persistence = await mkdtemp(join(tmpdir(), "positioncrew-shadow-grid-d1-"));
const token = "positioncrew-shadow-grid-integration-token";
const testNow = new Date();
testNow.setUTCMinutes(32, 0, 0);
if (testNow.getTime() > Date.now()) testNow.setUTCHours(testNow.getUTCHours() - 1);

function shadowGridRunId(date) {
  const iso = date.toISOString();
  return `bg-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 13)}`;
}

function deterministicUuid(seed) {
  const digest = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function finiteDate(milliseconds, label) {
  assert(Number.isFinite(milliseconds), `${label} timestamp is not finite`);
  const date = new Date(milliseconds);
  assert(Number.isFinite(date.getTime()), `${label} date is invalid`);
  return date;
}

function normalizeLoopbackUrlOrigins(value) {
  if (Array.isArray(value)) return value.map(normalizeLoopbackUrlOrigins);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeLoopbackUrlOrigins(child)]),
    );
  }
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return value;
    url.protocol = "https:";
    url.hostname = "positioncrew.test";
    url.port = "";
    return url.toString();
  } catch {
    return value;
  }
}

function adversarialGridHire(idempotencyKey) {
  const observedAt = new Date().toISOString();
  const blockNumber = "71009999";
  const sourceId = `pancake-v3-mainnet-block-${blockNumber}`;
  const explorerUrl = `https://bscscan.com/block/${blockNumber}`;
  const request = structuredClone(boundedGridFixture);
  request.requestId = `pancake-grid-${blockNumber}`;
  request.protocol = "PancakeSwap V3 bounded grid policy";
  request.requestedAt = observedAt;
  request.deadline = new Date(Date.parse(observedAt) + 10 * 60_000).toISOString();
  request.sources = [{
    sourceId,
    label: "Adversarial public idempotency-key preseed",
    uri: explorerUrl,
    observedAt,
  }];
  request.marketState.observedAt = observedAt;
  request.marketState.sourceId = sourceId;
  return {
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
    idempotencyKey,
    benchmarkSlug: "bounded-grid",
    providerSlug: "bounded-grid",
    evidenceMode: "CURRENT_BLOCK_PINNED",
    observation: { blockNumber, observedAt, explorerUrl },
    request,
  };
}

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

async function startWorker(port, entryNow = testNow, checkpointNow = null) {
  const args = [
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
    `SHADOW_GRID_TEST_NOW:${entryNow.toISOString()}`,
  ];
  if (checkpointNow) {
    args.push(
      "--var",
      `SHADOW_GRID_TEST_CHECKPOINT_NOW:${checkpointNow.toISOString()}`,
    );
  }
  const child = spawn(
    wrangler,
    args,
    { cwd: root, stdio: "ignore" },
  );
  await waitForWorker(`http://127.0.0.1:${port}`);
  return child;
}

async function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true)));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited,
    new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), 5_000);
      timer.unref();
    }),
  ]);
  if (stopped) return;
  child.kill("SIGKILL");
  await exited;
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

  let port = await availablePort();
  let baseUrl = `http://127.0.0.1:${port}`;
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
  const expectedRunId = shadowGridRunId(testNow);
  const legacyPublicKey = deterministicUuid(
    `positioncrew:${expectedRunId}:current-grid-hire`,
  );
  const adversarial = await requestJson(baseUrl, "/api/benchmark-hires", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify(adversarialGridHire(legacyPublicKey)),
  });
  assert.equal(
    adversarial.response.status,
    201,
    `Adversarial preseed was not created: ${JSON.stringify(adversarial.body)}`,
  );
  assert.equal(adversarial.body.job.state, "CREATED");

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
  const precommitStored = windowBeforeRestart.body.events.find(
    (event) => event.eventType === "PRECOMMITTED",
  );
  assert(precommitStored, "Forward window did not retain a PRECOMMITTED event");
  assert.equal(typeof precommitStored.payload, "object");
  assert.equal(
    windowBeforeRestart.body.window.sourceHireId,
    precommitStored.payload.sourceHireId,
    "Public window source hire differs from its persisted PRECOMMITTED event",
  );
  assert.equal(
    windowBeforeRestart.body.window.sourceRequestHash,
    precommitStored.payload.sourceRequestHash,
    "Public window request hash differs from its persisted PRECOMMITTED event",
  );
  assert.notEqual(
    precommitStored.payload.sourceHireId,
    adversarial.body.hire.hireId,
    "Collector reused a publicly preseeded source hire",
  );
  assert.notEqual(
    precommitStored.payload.sourceRequestHash,
    adversarial.body.hire.requestHash,
    "Collector committed the publicly preseeded request hash",
  );

  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
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
  assert.deepEqual(
    normalizeLoopbackUrlOrigins(summaryAfterDurable),
    normalizeLoopbackUrlOrigins(summaryBeforeDurable),
  );

  const windowAfterRestart = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(runId)}`,
  );
  assert.equal(windowAfterRestart.response.status, 200);
  assert(Number.isFinite(Date.parse(windowBeforeRestart.body.generatedAt)));
  assert(Number.isFinite(Date.parse(windowAfterRestart.body.generatedAt)));
  const { generatedAt: _windowBeforeGeneratedAt, ...windowBeforeDurable } = windowBeforeRestart.body;
  const { generatedAt: _windowAfterGeneratedAt, ...windowAfterDurable } = windowAfterRestart.body;
  assert.deepEqual(
    normalizeLoopbackUrlOrigins(windowAfterDurable),
    normalizeLoopbackUrlOrigins(windowBeforeDurable),
  );

  const epochStartedAt = Date.parse(windowAfterRestart.body.window.startedAt);
  assert(Number.isFinite(epochStartedAt), "Public window startedAt is invalid");
  const nextDue = epochStartedAt + 5 * 60_000;
  const beforeSampleGrace = finiteDate(
    nextDue + 3 * 60_000 - 1_000,
    "pre-grace sample checkpoint",
  );
  const afterSampleGrace = finiteDate(
    nextDue + 3 * 60_000 + 1_000,
    "post-grace sample checkpoint",
  );

  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, beforeSampleGrace, afterSampleGrace);
  const lateSampleTick = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers },
  );
  assert.equal(lateSampleTick.response.status, 200);
  const lateSampleWindow = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(runId)}`,
  );
  assert.equal(lateSampleWindow.response.status, 200);
  assert.equal(
    lateSampleWindow.body.events.filter((event) => event.eventType === "OBSERVED").length,
    0,
    "A sample completed after the grace deadline was retained",
  );
  const lateSampleTerminal = lateSampleWindow.body.events.at(-1);
  assert.equal(lateSampleTerminal.eventType, "VOID_SOURCE_GAP");
  const lateSampleTerminalPayload = lateSampleTerminal.payload;
  assert.match(
    lateSampleTerminalPayload.reason,
    /(?:after|outside).*(?:grace|deadline)|(?:grace|deadline).*after/iu,
  );

  const cutoffHour = finiteDate(beforeSampleGrace.getTime(), "opening-cutoff hour");
  cutoffHour.setUTCMinutes(0, 0, 0);
  cutoffHour.setUTCHours(cutoffHour.getUTCHours() + 2);
  assert(Number.isFinite(cutoffHour.getTime()), "Opening-cutoff hour became invalid");
  const beforeOpeningCutoff = finiteDate(
    cutoffHour.getTime() + 37 * 60_000 + 59_000,
    "pre-opening-cutoff checkpoint",
  );
  const afterOpeningCutoff = finiteDate(
    cutoffHour.getTime() + 38 * 60_000 + 1_000,
    "post-opening-cutoff checkpoint",
  );
  const cutoffRunId = shadowGridRunId(beforeOpeningCutoff);

  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, beforeOpeningCutoff, afterOpeningCutoff);
  const cutoffTick = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers },
  );
  assert.equal(cutoffTick.response.status, 200);
  assert.equal(cutoffTick.body.runId, cutoffRunId);
  assert.equal(cutoffTick.body.state, "LATE_START_SKIPPED");
  assert.equal(cutoffTick.body.headHash, null);
  assert.equal(cutoffTick.body.eventCount, 0);
  const skippedWindow = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(cutoffRunId)}`,
  );
  assert.equal(skippedWindow.response.status, 404);

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
