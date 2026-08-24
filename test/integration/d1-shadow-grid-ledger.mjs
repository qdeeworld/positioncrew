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

function canonicalJson(value) {
  const canonicalize = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.keys(candidate).sort().map((key) => [key, canonicalize(candidate[key])]),
      );
    }
    return candidate;
  };
  return JSON.stringify(canonicalize(value));
}

function rehashPublicShadowEvent(event) {
  const body = structuredClone(event);
  delete body.eventHash;
  const eventHash = `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
  return { eventHash, eventJson: canonicalJson({ ...body, eventHash }) };
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

function executeD1SetupMutation(sql) {
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
  assert.equal(
    result.status,
    0,
    `D1 genesis-only setup failed: ${result.stderr}${result.stdout}`,
  );
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
      "dolepee/positioncrew/.github/workflows/production-smoke.yml@refs/heads/main",
  };
  const rejectedOldWorkflow = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    {
      method: "POST",
      headers: {
        ...headers,
        "X-GitHub-Workflow-Ref":
          "dolepee/positioncrew/.github/workflows/bounded-grid-shadow-ledger.yml@refs/heads/main",
      },
    },
  );
  assert.equal(rejectedOldWorkflow.response.status, 400);

  const rejectedAttemptTwo = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    {
      method: "POST",
      headers: { ...headers, "X-GitHub-Run-Attempt": "2" },
    },
  );
  assert.equal(rejectedAttemptTwo.response.status, 400);

  const ledgerBeforeAcceptedIdentity = await requestJson(
    baseUrl,
    "/api/evidence/bounded-grid-forward-shadow",
  );
  assert.equal(ledgerBeforeAcceptedIdentity.response.status, 200);
  assert.equal(
    ledgerBeforeAcceptedIdentity.body.recentWindows.length,
    0,
    "Rejected workflow identities must not create shadow-ledger events",
  );

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
  assert(Number.isFinite(Date.parse(first.body.epochStartedAt)));
  assert(Number.isFinite(Date.parse(first.body.horizonEndsAt)));
  assert.equal(
    Date.parse(first.body.horizonEndsAt) - Date.parse(first.body.epochStartedAt),
    15 * 60_000,
  );

  const pinnedHeaders = {
    ...headers,
    "X-PositionCrew-Shadow-Run-Id": first.body.runId,
  };
  const rejectedMismatchedOrigin = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    {
      method: "POST",
      headers: {
        ...pinnedHeaders,
        "X-GitHub-Run-Id": "1002",
        "X-GitHub-Sha": "2".repeat(40),
      },
    },
  );
  assert.equal(rejectedMismatchedOrigin.response.status, 400);

  const unknownExpectedRunId = "bg-19990101-00";
  const rejectedUnknownExpectedRun = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    {
      method: "POST",
      headers: {
        ...headers,
        "X-PositionCrew-Shadow-Run-Id": unknownExpectedRunId,
      },
    },
  );
  assert.equal(rejectedUnknownExpectedRun.response.status, 400);

  const unchangedAfterRejectedFollowUps = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(first.body.runId)}`,
  );
  assert.equal(unchangedAfterRejectedFollowUps.response.status, 200);
  assert.equal(unchangedAfterRejectedFollowUps.body.events.length, first.body.eventCount);
  assert.equal(
    unchangedAfterRejectedFollowUps.body.events.at(-1).eventHash,
    first.body.headHash,
  );
  const unknownExpectedWindow = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(unknownExpectedRunId)}`,
  );
  assert.equal(unknownExpectedWindow.response.status, 404);

  const retry = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: pinnedHeaders },
  );
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.runId, first.body.runId);
  assert.equal(retry.body.headHash, first.body.headHash);
  assert.equal(retry.body.eventCount, first.body.eventCount);
  assert.equal(retry.body.epochStartedAt, first.body.epochStartedAt);
  assert.equal(retry.body.horizonEndsAt, first.body.horizonEndsAt);

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
  assert.equal(windowBeforeRestart.body.window.startedAt, first.body.epochStartedAt);
  assert.equal(
    new Date(
      Date.parse(windowBeforeRestart.body.window.startedAt) +
        windowBeforeRestart.body.window.horizonMinutes * 60_000,
    ).toISOString(),
    first.body.horizonEndsAt,
  );
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
    { method: "POST", headers: pinnedHeaders },
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

  const nextHourNow = finiteDate(
    testNow.getTime() + 60 * 60_000,
    "expected-run next-hour checkpoint",
  );
  const nextHourRunId = shadowGridRunId(nextHourNow);
  assert.notEqual(nextHourRunId, runId);
  const originalHeadBeforeNextHour = lateSampleWindow.body.events.at(-1).eventHash;
  const originalEventCountBeforeNextHour = lateSampleWindow.body.events.length;

  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, nextHourNow);
  const pinnedNextHourTick = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: pinnedHeaders },
  );
  assert.equal(pinnedNextHourTick.response.status, 200);
  assert.equal(pinnedNextHourTick.body.runId, runId);
  assert.equal(pinnedNextHourTick.body.headHash, originalHeadBeforeNextHour);
  assert.equal(pinnedNextHourTick.body.eventCount, originalEventCountBeforeNextHour);
  assert.equal(pinnedNextHourTick.body.epochStartedAt, first.body.epochStartedAt);
  assert.equal(pinnedNextHourTick.body.horizonEndsAt, first.body.horizonEndsAt);

  const nextHourWindow = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(nextHourRunId)}`,
  );
  assert.equal(nextHourWindow.response.status, 404);
  const originalAfterNextHour = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(runId)}`,
  );
  assert.equal(originalAfterNextHour.response.status, 200);
  assert.equal(originalAfterNextHour.body.events.length, originalEventCountBeforeNextHour);
  assert.equal(originalAfterNextHour.body.events.at(-1).eventHash, originalHeadBeforeNextHour);

  const cutoffHour = finiteDate(beforeSampleGrace.getTime(), "opening-cutoff hour");
  cutoffHour.setUTCMinutes(0, 0, 0);
  cutoffHour.setUTCHours(cutoffHour.getUTCHours() + 2);
  assert(Number.isFinite(cutoffHour.getTime()), "Opening-cutoff hour became invalid");
  const beforeOpeningCutoff = finiteDate(
    cutoffHour.getTime() + 43 * 60_000 + 59_000,
    "pre-opening-cutoff checkpoint",
  );
  const afterOpeningCutoff = finiteDate(
    cutoffHour.getTime() + 44 * 60_000 + 1_000,
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
  assert.equal(cutoffTick.body.epochStartedAt, null);
  assert.equal(cutoffTick.body.horizonEndsAt, null);
  const skippedWindow = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(cutoffRunId)}`,
  );
  assert.equal(skippedWindow.response.status, 404);

  const abandonedPriorNow = finiteDate(
    cutoffHour.getTime() + 60 * 60_000 + 2 * 60_000,
    "abandoned prior-hour opening",
  );
  const abandonedPriorRunId = shadowGridRunId(abandonedPriorNow);
  const abandonedPriorHeaders = {
    ...headers,
    "X-GitHub-Run-Id": "2001",
    "X-GitHub-Sha": "3".repeat(40),
  };

  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, abandonedPriorNow);
  const abandonedPriorOpen = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: abandonedPriorHeaders },
  );
  assert.equal(abandonedPriorOpen.response.status, 200);
  assert.equal(abandonedPriorOpen.body.runId, abandonedPriorRunId);
  assert.equal(abandonedPriorOpen.body.state, "PRECOMMITTED");
  assert.match(abandonedPriorOpen.body.headHash, /^sha256:[a-f0-9]{64}$/u);

  const abandonedPriorBefore = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(abandonedPriorRunId)}`,
  );
  assert.equal(abandonedPriorBefore.response.status, 200);
  assert.equal(abandonedPriorBefore.body.events.at(-1).eventType, "PRECOMMITTED");

  const replacementSessionNow = finiteDate(
    abandonedPriorNow.getTime() + 60 * 60_000,
    "replacement current-hour opening",
  );
  const replacementRunId = shadowGridRunId(replacementSessionNow);
  const replacementHeaders = {
    ...headers,
    "X-GitHub-Run-Id": "2002",
    "X-GitHub-Sha": "4".repeat(40),
  };
  assert.notEqual(replacementRunId, abandonedPriorRunId);

  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, replacementSessionNow);
  const replacementOpen = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: replacementHeaders },
  );
  assert.equal(replacementOpen.response.status, 200);
  assert.equal(replacementOpen.body.runId, replacementRunId);
  assert.equal(replacementOpen.body.state, "PRECOMMITTED");
  assert.match(replacementOpen.body.headHash, /^sha256:[a-f0-9]{64}$/u);

  const abandonedPriorAfter = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(abandonedPriorRunId)}`,
  );
  assert.equal(abandonedPriorAfter.response.status, 200);
  assert.equal(abandonedPriorAfter.body.window.state, "VOID_SOURCE_GAP");
  assert.equal(abandonedPriorAfter.body.integrity.valid, true);
  assert.equal(
    abandonedPriorAfter.body.events.filter((event) => event.eventType === "OBSERVED").length,
    0,
    "A replacement workflow identity sampled the abandoned prior epoch",
  );
  assert.equal(
    abandonedPriorAfter.body.events.filter((event) =>
      ["SHADOW_FILL", "CLOSED", "RISK_EXIT"].includes(event.eventType)
    ).length,
    0,
    "A replacement workflow identity completed the abandoned prior epoch",
  );
  const abandonedGenesis = abandonedPriorAfter.body.events.find(
    (event) => event.eventType === "EPOCH_STARTED",
  );
  const abandonedPrecommit = abandonedPriorAfter.body.events.find(
    (event) => event.eventType === "PRECOMMITTED",
  );
  const abandonedTerminal = abandonedPriorAfter.body.events.at(-1);
  assert(abandonedGenesis && abandonedPrecommit);
  for (const provenanceEvent of [abandonedGenesis, abandonedPrecommit]) {
    assert.equal(provenanceEvent.payload.schedule.runId, "2001");
    assert.equal(provenanceEvent.payload.schedule.runAttempt, "1");
    assert.equal(provenanceEvent.payload.schedule.headSha, "3".repeat(40));
    assert.equal(
      provenanceEvent.payload.schedule.workflowRef,
      "dolepee/positioncrew/.github/workflows/production-smoke.yml@refs/heads/main",
    );
  }
  assert.equal(abandonedTerminal.eventType, "VOID_SOURCE_GAP");
  assert.equal(abandonedTerminal.previousEventHash, abandonedPrecommit.eventHash);
  assert.match(abandonedTerminal.payload.reason, /abandon/iu);

  const replacementWindowBeforeExpectedRequest = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(replacementRunId)}`,
  );
  assert.equal(replacementWindowBeforeExpectedRequest.response.status, 200);
  assert.equal(
    replacementWindowBeforeExpectedRequest.body.events.at(-1).eventType,
    "PRECOMMITTED",
  );
  const replacementHeadBeforeExpectedRequest =
    replacementWindowBeforeExpectedRequest.body.events.at(-1).eventHash;
  const replacementCountBeforeExpectedRequest =
    replacementWindowBeforeExpectedRequest.body.events.length;

  const expectedOnlyNow = finiteDate(
    replacementSessionNow.getTime() + 60 * 60_000,
    "expected-run isolation checkpoint",
  );
  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, expectedOnlyNow);
  const expectedAbandonedReplay = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    {
      method: "POST",
      headers: {
        ...abandonedPriorHeaders,
        "X-PositionCrew-Shadow-Run-Id": abandonedPriorRunId,
      },
    },
  );
  assert.equal(expectedAbandonedReplay.response.status, 200);
  assert.equal(expectedAbandonedReplay.body.runId, abandonedPriorRunId);
  assert.equal(expectedAbandonedReplay.body.headHash, abandonedTerminal.eventHash);

  const replacementWindowAfterExpectedRequest = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(replacementRunId)}`,
  );
  assert.equal(replacementWindowAfterExpectedRequest.response.status, 200);
  assert.equal(
    replacementWindowAfterExpectedRequest.body.events.length,
    replacementCountBeforeExpectedRequest,
  );
  assert.equal(
    replacementWindowAfterExpectedRequest.body.events.at(-1).eventHash,
    replacementHeadBeforeExpectedRequest,
  );
  assert.equal(
    replacementWindowAfterExpectedRequest.body.events.at(-1).eventType,
    "PRECOMMITTED",
    "An expected-run request cleaned an unrelated epoch",
  );

  const summaryBeforeGenesisOnlyRecovery = await requestJson(
    baseUrl,
    "/api/evidence/bounded-grid-forward-shadow",
  );
  assert.equal(summaryBeforeGenesisOnlyRecovery.response.status, 200);
  const precommittedCountBeforeGenesisOnlyRecovery =
    summaryBeforeGenesisOnlyRecovery.body.summary.precommittedWindowCount;
  assert(Number.isInteger(precommittedCountBeforeGenesisOnlyRecovery));

  const genesisOnlyNow = finiteDate(
    expectedOnlyNow.getTime() + 60 * 60_000,
    "genesis-only prior-hour opening",
  );
  const genesisOnlyRunId = shadowGridRunId(genesisOnlyNow);
  const genesisOnlyHeaders = {
    ...headers,
    "X-GitHub-Run-Id": "3001",
    "X-GitHub-Sha": "5".repeat(40),
  };

  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, genesisOnlyNow);
  const genesisOnlyOpen = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: genesisOnlyHeaders },
  );
  assert.equal(genesisOnlyOpen.response.status, 200);
  assert.equal(genesisOnlyOpen.body.runId, genesisOnlyRunId);
  assert.equal(genesisOnlyOpen.body.state, "PRECOMMITTED");
  assert.equal(genesisOnlyOpen.body.eventCount, 2);

  await stopWorker(worker);
  worker = undefined;
  assert.match(genesisOnlyRunId, /^bg-[0-9]{8}-[0-9]{2}$/u);
  executeD1SetupMutation("DROP TRIGGER IF EXISTS shadow_grid_events_no_delete");
  executeD1SetupMutation(
    `DELETE FROM shadow_grid_events WHERE run_id = '${genesisOnlyRunId}' AND event_type = 'PRECOMMITTED'`,
  );

  const genesisRecoveryNow = finiteDate(
    genesisOnlyNow.getTime() + 60 * 60_000,
    "genesis-only recovery hour",
  );
  const genesisRecoveryRunId = shadowGridRunId(genesisRecoveryNow);
  const genesisRecoveryHeaders = {
    ...headers,
    "X-GitHub-Run-Id": "3002",
    "X-GitHub-Sha": "6".repeat(40),
  };
  assert.notEqual(genesisRecoveryRunId, genesisOnlyRunId);

  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, genesisRecoveryNow);
  const genesisRecoveryOpen = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: genesisRecoveryHeaders },
  );
  assert.equal(genesisRecoveryOpen.response.status, 200);
  assert.equal(genesisRecoveryOpen.body.runId, genesisRecoveryRunId);
  assert.equal(genesisRecoveryOpen.body.state, "PRECOMMITTED");

  const recoveredGenesisOnlyWindow = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(genesisOnlyRunId)}`,
  );
  assert.equal(recoveredGenesisOnlyWindow.response.status, 200);
  assert.equal(recoveredGenesisOnlyWindow.body.window.state, "VOID_SOURCE_GAP");
  assert.equal(
    recoveredGenesisOnlyWindow.body.window.initializationState,
    "VOIDED_BEFORE_PRECOMMIT",
  );
  assert.equal(recoveredGenesisOnlyWindow.body.window.precommitPersisted, false);
  assert.equal(recoveredGenesisOnlyWindow.body.window.sourceHireId, null);
  assert.equal(recoveredGenesisOnlyWindow.body.window.sourceRequestHash, null);
  assert.equal(recoveredGenesisOnlyWindow.body.window.sourceReceiptUrl, null);
  assert.equal(recoveredGenesisOnlyWindow.body.window.sourceBlockNumber, null);
  assert.equal(recoveredGenesisOnlyWindow.body.integrity.valid, true);
  assert.equal(recoveredGenesisOnlyWindow.body.events.length, 2);
  const recoveredGenesis = recoveredGenesisOnlyWindow.body.events[0];
  const recoveredGenesisTerminal = recoveredGenesisOnlyWindow.body.events[1];
  assert.equal(recoveredGenesis.eventType, "EPOCH_STARTED");
  assert.equal(recoveredGenesis.payload.schedule.runId, "3001");
  assert.equal(recoveredGenesis.payload.schedule.runAttempt, "1");
  assert.equal(recoveredGenesis.payload.schedule.headSha, "5".repeat(40));
  assert.equal(
    recoveredGenesis.payload.schedule.workflowRef,
    "dolepee/positioncrew/.github/workflows/production-smoke.yml@refs/heads/main",
  );
  assert.equal(recoveredGenesisTerminal.eventType, "VOID_SOURCE_GAP");
  assert.equal(recoveredGenesisTerminal.previousEventHash, recoveredGenesis.eventHash);
  assert.match(recoveredGenesisTerminal.payload.reason, /abandon/iu);
  assert.equal(
    recoveredGenesisOnlyWindow.body.events.filter((event) =>
      ["PRECOMMITTED", "OBSERVED", "SHADOW_FILL", "CLOSED", "RISK_EXIT"].includes(event.eventType)
    ).length,
    0,
    "Genesis-only recovery appended work from the replacement identity",
  );
  const recoveredGenesisSummary = await requestJson(
    baseUrl,
    "/api/evidence/bounded-grid-forward-shadow",
  );
  assert.equal(recoveredGenesisSummary.response.status, 200);
  assert.equal(
    recoveredGenesisSummary.body.recentWindows.find(
      (window) => window.windowId === genesisOnlyRunId,
    )?.state,
    "VOID_SOURCE_GAP",
    "Genesis-only epoch remained permanently nonterminal",
  );
  const normalReplacementSummaryWindow = recoveredGenesisSummary.body.recentWindows.find(
    (window) => window.windowId === genesisRecoveryRunId,
  );
  assert.equal(
    normalReplacementSummaryWindow?.state,
    "PRECOMMITTED",
    "Normally precommitted replacement run is absent from the public summary",
  );
  assert.equal(normalReplacementSummaryWindow?.initializationState, "PRECOMMITTED");
  assert.equal(normalReplacementSummaryWindow?.precommitPersisted, true);
  assert(normalReplacementSummaryWindow);
  assert.match(normalReplacementSummaryWindow.sourceHireId, /^[0-9a-f-]{36}$/iu);
  assert.match(normalReplacementSummaryWindow.sourceRequestHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(normalReplacementSummaryWindow.sourceReceiptUrl, /^https?:\/\//u);
  assert.match(normalReplacementSummaryWindow.sourceBlockNumber, /^[1-9][0-9]*$/u);
  assert.equal(
    recoveredGenesisSummary.body.summary.precommittedWindowCount,
    precommittedCountBeforeGenesisOnlyRecovery + 1,
    "Genesis-only void was counted as precommitted or the normal replacement was omitted",
  );
  assert.equal(
    recoveredGenesisSummary.body.summary.openedWindowCount,
    recoveredGenesisSummary.body.summary.initializationVoidWindowCount +
      recoveredGenesisSummary.body.summary.precommittedWindowCount,
    "Opened windows do not reconcile to initialization voids plus persisted precommits",
  );
  assert.equal(
    recoveredGenesisSummary.body.summary.terminalWindowCount,
    recoveredGenesisSummary.body.summary.initializationVoidWindowCount +
      recoveredGenesisSummary.body.summary.precommittedTerminalWindowCount,
    "Terminal windows do not reconcile to initialization voids plus precommitted terminals",
  );

  const legacyOpeningNow = finiteDate(
    genesisRecoveryNow.getTime() + 2 * 60 * 60_000,
    "legacy-provenance opening hour",
  );
  const legacyRunId = shadowGridRunId(legacyOpeningNow);
  const legacyOriginHeaders = {
    ...headers,
    "X-GitHub-Run-Id": "4001",
    "X-GitHub-Sha": "7".repeat(40),
  };

  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, legacyOpeningNow);
  const legacyOpen = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: legacyOriginHeaders },
  );
  assert.equal(legacyOpen.response.status, 200);
  assert.equal(legacyOpen.body.runId, legacyRunId);
  assert.equal(legacyOpen.body.state, "PRECOMMITTED");
  const legacyWindowBeforeRewrite = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(legacyRunId)}`,
  );
  assert.equal(legacyWindowBeforeRewrite.response.status, 200);
  const legacyGenesis = structuredClone(
    legacyWindowBeforeRewrite.body.events.find((event) => event.eventType === "EPOCH_STARTED"),
  );
  assert(legacyGenesis);
  legacyGenesis.payload.schedule.workflowPath =
    ".github/workflows/bounded-grid-shadow-ledger.yml";
  legacyGenesis.payload.schedule.workflowRef =
    "dolepee/positioncrew/.github/workflows/bounded-grid-shadow-ledger.yml@refs/heads/main";
  const rewrittenLegacyGenesis = rehashPublicShadowEvent(legacyGenesis);

  await stopWorker(worker);
  worker = undefined;
  executeD1SetupMutation("DROP TRIGGER IF EXISTS shadow_grid_events_no_delete");
  executeD1SetupMutation("DROP TRIGGER IF EXISTS shadow_grid_events_no_update");
  executeD1SetupMutation(
    `DELETE FROM shadow_grid_events WHERE run_id = ${sqlLiteral(legacyRunId)} AND event_type = 'PRECOMMITTED'`,
  );
  executeD1SetupMutation(
    [
      "UPDATE shadow_grid_events SET",
      `event_json = ${sqlLiteral(rewrittenLegacyGenesis.eventJson)},`,
      `event_hash = ${sqlLiteral(rewrittenLegacyGenesis.eventHash)}`,
      `WHERE run_id = ${sqlLiteral(legacyRunId)} AND event_type = 'EPOCH_STARTED'`,
    ].join(" "),
  );

  const legacyRecoveryNow = finiteDate(
    legacyOpeningNow.getTime() + 60 * 60_000,
    "legacy-provenance recovery hour",
  );
  const legacyReplacementRunId = shadowGridRunId(legacyRecoveryNow);
  const rejectedLegacyHeaders = {
    ...legacyOriginHeaders,
    "X-GitHub-Workflow-Ref":
      "dolepee/positioncrew/.github/workflows/bounded-grid-shadow-ledger.yml@refs/heads/main",
  };
  const legacyReplacementHeaders = {
    ...headers,
    "X-GitHub-Run-Id": "4002",
    "X-GitHub-Sha": "8".repeat(40),
  };

  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, legacyRecoveryNow);
  const rejectedIncomingLegacy = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: rejectedLegacyHeaders },
  );
  assert.equal(rejectedIncomingLegacy.response.status, 400);
  const legacyReplacementOpen = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: legacyReplacementHeaders },
  );
  assert.equal(legacyReplacementOpen.response.status, 200);
  assert.equal(legacyReplacementOpen.body.runId, legacyReplacementRunId);
  assert.equal(legacyReplacementOpen.body.state, "PRECOMMITTED");

  const recoveredLegacyWindow = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(legacyRunId)}`,
  );
  assert.equal(recoveredLegacyWindow.response.status, 200);
  assert.equal(recoveredLegacyWindow.body.window.state, "VOID_SOURCE_GAP");
  assert.equal(recoveredLegacyWindow.body.integrity.valid, true);
  assert.equal(recoveredLegacyWindow.body.events.length, 2);
  assert.equal(recoveredLegacyWindow.body.events[0].eventType, "EPOCH_STARTED");
  assert.equal(
    recoveredLegacyWindow.body.events[0].payload.schedule.workflowPath,
    ".github/workflows/bounded-grid-shadow-ledger.yml",
  );
  assert.equal(
    recoveredLegacyWindow.body.events[0].payload.schedule.workflowRef,
    "dolepee/positioncrew/.github/workflows/bounded-grid-shadow-ledger.yml@refs/heads/main",
  );
  assert.equal(recoveredLegacyWindow.body.events[0].payload.schedule.runId, "4001");
  assert.equal(recoveredLegacyWindow.body.events.at(-1).eventType, "VOID_SOURCE_GAP");
  assert.equal(
    recoveredLegacyWindow.body.events.filter((event) =>
      ["PRECOMMITTED", "OBSERVED", "SHADOW_FILL", "CLOSED", "RISK_EXIT"].includes(event.eventType)
    ).length,
    0,
    "Legacy stored provenance was sampled or completed by the replacement session",
  );

  const secondExpiredNow = finiteDate(
    legacyRecoveryNow.getTime() + 60 * 60_000,
    "second expired-run opening",
  );
  const secondExpiredRunId = shadowGridRunId(secondExpiredNow);
  const secondExpiredHeaders = {
    ...headers,
    "X-GitHub-Run-Id": "4003",
    "X-GitHub-Sha": "9".repeat(40),
  };
  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, secondExpiredNow);
  const secondExpiredOpen = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: secondExpiredHeaders },
  );
  assert.equal(secondExpiredOpen.response.status, 200);
  assert.equal(secondExpiredOpen.body.runId, secondExpiredRunId);
  assert.equal(secondExpiredOpen.body.state, "PRECOMMITTED");

  const thirdExpiredNow = finiteDate(
    secondExpiredNow.getTime() + 60 * 60_000,
    "third expired-run opening",
  );
  const thirdExpiredRunId = shadowGridRunId(thirdExpiredNow);
  const thirdExpiredHeaders = {
    ...headers,
    "X-GitHub-Run-Id": "4004",
    "X-GitHub-Sha": "a".repeat(40),
  };
  await stopWorker(worker);
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, thirdExpiredNow);
  const thirdExpiredOpen = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: thirdExpiredHeaders },
  );
  assert.equal(thirdExpiredOpen.response.status, 200);
  assert.equal(thirdExpiredOpen.body.runId, thirdExpiredRunId);
  assert.equal(thirdExpiredOpen.body.state, "PRECOMMITTED");

  await stopWorker(worker);
  worker = undefined;
  executeD1SetupMutation("DROP TRIGGER IF EXISTS shadow_grid_events_no_delete");
  executeD1SetupMutation(
    [legacyReplacementRunId, secondExpiredRunId]
      .map((expiredRunId) =>
        `DELETE FROM shadow_grid_events WHERE run_id = ${sqlLiteral(expiredRunId)} AND event_type = 'VOID_SOURCE_GAP'`
      )
      .join("; "),
  );

  const sweepNow = finiteDate(
    thirdExpiredNow.getTime() + 3 * 60 * 60_000,
    "multi-run expiry sweep",
  );
  const sweepRunId = shadowGridRunId(sweepNow);
  const sweepHeaders = {
    ...headers,
    "X-GitHub-Run-Id": "4005",
    "X-GitHub-Sha": "b".repeat(40),
  };
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, sweepNow);
  const sweepOpen = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: sweepHeaders },
  );
  assert.equal(sweepOpen.response.status, 200);
  assert.equal(sweepOpen.body.runId, sweepRunId);
  assert.equal(sweepOpen.body.state, "PRECOMMITTED");

  for (const expiredRunId of [legacyReplacementRunId, secondExpiredRunId, thirdExpiredRunId]) {
    const expiredWindow = await requestJson(
      baseUrl,
      `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(expiredRunId)}`,
    );
    assert.equal(expiredWindow.response.status, 200);
    assert.equal(expiredWindow.body.window.state, "VOID_SOURCE_GAP");
    assert.equal(expiredWindow.body.integrity.valid, true);
    assert.equal(
      expiredWindow.body.events.filter((event) =>
        ["OBSERVED", "SHADOW_FILL", "CLOSED", "RISK_EXIT"].includes(event.eventType)
      ).length,
      0,
      `Expired run ${expiredRunId} was sampled or closed during the sweep`,
    );
  }

  const sweepWindowBeforeNonexpiredRetry = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(sweepRunId)}`,
  );
  assert.equal(sweepWindowBeforeNonexpiredRetry.response.status, 200);
  assert.equal(sweepWindowBeforeNonexpiredRetry.body.window.state, "PRECOMMITTED");
  const sweepHeadBeforeNonexpiredRetry = sweepWindowBeforeNonexpiredRetry.body.events.at(-1).eventHash;
  const sweepCountBeforeNonexpiredRetry = sweepWindowBeforeNonexpiredRetry.body.events.length;

  await stopWorker(worker);
  worker = undefined;
  executeD1SetupMutation("DROP TRIGGER IF EXISTS shadow_grid_events_no_update");
  const nonexpiredEpochStartedAt = sweepNow.toISOString();
  const nonexpiredHorizonEndsAt = finiteDate(
    sweepNow.getTime() + 15 * 60_000,
    "nonexpired current horizon",
  ).toISOString();
  executeD1SetupMutation(
    [
      "UPDATE shadow_grid_events SET",
      `epoch_started_at = ${sqlLiteral(nonexpiredEpochStartedAt)},`,
      `horizon_ends_at = ${sqlLiteral(nonexpiredHorizonEndsAt)}`,
      `WHERE run_id = ${sqlLiteral(sweepRunId)}`,
    ].join(" "),
  );

  const nonexpiredRetryNow = finiteDate(
    sweepNow.getTime() + 30_000,
    "nonexpired current retry",
  );
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = await startWorker(port, nonexpiredRetryNow);
  const nonexpiredRetry = await requestJson(
    baseUrl,
    "/api/internal/bounded-grid-forward-shadow/tick",
    { method: "POST", headers: sweepHeaders },
  );
  assert.equal(nonexpiredRetry.response.status, 200);
  assert.equal(nonexpiredRetry.body.runId, sweepRunId);
  assert.equal(nonexpiredRetry.body.state, "PRECOMMITTED");
  assert.equal(nonexpiredRetry.body.headHash, sweepHeadBeforeNonexpiredRetry);
  assert.equal(nonexpiredRetry.body.eventCount, sweepCountBeforeNonexpiredRetry);
  const nonexpiredWindowAfterRetry = await requestJson(
    baseUrl,
    `/api/evidence/bounded-grid-forward-shadow/windows/${encodeURIComponent(sweepRunId)}`,
  );
  assert.equal(nonexpiredWindowAfterRetry.response.status, 200);
  assert.equal(nonexpiredWindowAfterRetry.body.window.state, "PRECOMMITTED");
  assert.equal(
    nonexpiredWindowAfterRetry.body.events.at(-1).eventHash,
    sweepHeadBeforeNonexpiredRetry,
    "Nonexpired current epoch was cleaned",
  );

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
