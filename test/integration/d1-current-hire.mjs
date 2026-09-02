import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const config = resolve(root, "dist/server/wrangler.local.json");
const requestId = "d1-current-refusal-lending-0001";
const idempotencyKey = "d1100000-0000-4000-8000-000000000001";
const blockNumber = "60000000";

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

function currentRefusalHire() {
  const observedAt = new Date();
  const requestedAt = observedAt.toISOString();
  const deadline = new Date(observedAt.getTime() + 5 * 60_000).toISOString();
  const sourceId = `venus-mainnet-block-${blockNumber}`;
  const explorerUrl = `https://bscscan.com/block/${blockNumber}`;

  return {
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
    idempotencyKey,
    benchmarkSlug: "lending-rescue",
    providerSlug: "lending-rescue",
    evidenceMode: "CURRENT_BLOCK_PINNED",
    observation: { blockNumber, observedAt: requestedAt, explorerUrl },
    request: {
      schemaVersion: "positioncrew.lending-rescue.request.v1",
      service: "LENDING_RESCUE",
      requestId,
      chainId: 56,
      account: "0x1111111111111111111111111111111111111111",
      protocol: "Venus Classic",
      requestedAt,
      deadline,
      maxDataAgeSeconds: 300,
      maxActionUsd: "1",
      maxGasUsd: "0.01",
      maxSlippageBps: 30,
      sources: [
        {
          sourceId,
          label: "Synthetic local integration observation; no value is moved",
          uri: explorerUrl,
          observedAt: requestedAt,
        },
      ],
      market: "0xfd36e2c2a6789db23113685031d7f16329158384",
      position: {
        collateral: [
          {
            symbol: "WBNB",
            address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
            decimals: 18,
            amount: "2",
            priceUsd: "600",
            sourceId,
            observedAt: requestedAt,
            liquidationThresholdBps: 8_000,
            collateralEnabled: true,
          },
        ],
        debt: [
          {
            symbol: "USDT",
            address: "0x55d398326f99059fF775485246999027B3197955",
            decimals: 18,
            amount: "920",
            priceUsd: "1",
            sourceId,
            observedAt: requestedAt,
          },
        ],
      },
      availableAssets: [
        {
          symbol: "USDT",
          address: "0x55d398326f99059fF775485246999027B3197955",
          decimals: 18,
          availableAmount: "0",
        },
      ],
      allowedActions: ["REPAY_DEBT"],
      targetHealthFactor: "1.25",
      stressPriceDropBps: 1_000,
      oracleDeviationToleranceBps: 100,
      estimatedGasUsd: "0.04",
    },
  };
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

async function requestJson(baseUrl, path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  return { response, body };
}

async function runLifecycle(baseUrl) {
  const created = await requestJson(baseUrl, "/api/benchmark-hires", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(currentRefusalHire()),
  });
  assert.equal(
    created.response.status,
    201,
    `Current hire creation failed: ${JSON.stringify(created.body)}`,
  );
  assert.equal(created.body.hire.evidenceMode, "CURRENT_BLOCK_PINNED");
  assert.equal(created.body.job.state, "CREATED");
  assert.equal(created.body.receipt, null);
  const externalLendingComparison = created.body.hire.evidence.externalLendingComparison;
  assert.equal(
    externalLendingComparison?.schemaVersion,
    "positioncrew.external-lending-comparison-summary.v1",
  );
  assert.equal(externalLendingComparison?.provider?.erc8004TokenId, "315943");
  assert.equal(externalLendingComparison?.account, currentRefusalHire().request.account);
  assert.equal(externalLendingComparison?.eligibleForRescueSelection, false);
  assert.equal(externalLendingComparison?.eligibleForLiveMatch, false);
  assert.ok(Array.isArray(externalLendingComparison?.checks));

  const hireId = created.body.hire.hireId;
  assert.match(hireId, /^[0-9a-f-]{36}$/);
  const started = await requestJson(baseUrl, `/api/benchmark-hires/${hireId}/jobs`, {
    method: "POST",
  });
  assert.equal(started.response.status, 202);

  const expiresAt = Date.now() + 20_000;
  let completed;
  while (Date.now() < expiresAt) {
    const polled = await requestJson(baseUrl, `/api/benchmark-hires/${hireId}`);
    assert.equal(polled.response.status, 200);
    if (polled.body.job.state === "FAILED") {
      assert.fail(`Current D1-backed job failed: ${JSON.stringify(polled.body.job.error)}`);
    }
    if (polled.body.job.state === "COMPLETED") {
      completed = polled.body;
      break;
    }
    await delay(100);
  }
  assert(completed, "Current D1-backed job did not complete before the polling deadline");
  assert(completed.receipt, "Completed D1-backed job did not include a receipt");

  const receipt = await requestJson(baseUrl, completed.receipt.publicUrl);
  assert.equal(receipt.response.status, 200);
  assert.equal(receipt.body.hire.hireId, hireId);
  assert.equal(receipt.body.job.state, "COMPLETED");
  assert.equal(receipt.body.receipt.receiptId, completed.receipt.receiptId);
  assert.equal(
    receipt.body.receipt.response.result.deliverable.status,
    "REFUSED_CONSTRAINTS",
  );
  return { hireId, receiptPath: completed.receipt.publicUrl, externalLendingComparison };
}

const ADDITIONAL_CURRENT_HIRE_CASES = [
  {
    service: "BOUNDED_GRID",
    benchmarkSlug: "bounded-grid",
    providerSlug: "bounded-grid",
    fixturePath: "fixtures/bounded-grid/bnb-usdt-grid.v1.json",
    requestKey: "gridRequest",
    blockNumber: "71000001",
    protocol: "PancakeSwap V3 bounded grid policy",
    sourceId: "pancake-v3-mainnet-block-71000001",
    requestId: "pancake-grid-71000001",
    idempotencyKey: "33333333-3333-4333-8333-444444444444",
  },
  {
    service: "LP_REBALANCE",
    benchmarkSlug: "lp-rebalance",
    providerSlug: "lp-rebalance",
    fixturePath: "fixtures/lp-rebalance/out-of-range-v3-position.v1.json",
    requestKey: "lpRequest",
    blockNumber: "71000002",
    protocol: "PancakeSwap V3 position analysis",
    sourceId: "pancake-position-mainnet-block-71000002",
    requestId: "pancake-position-9000001-71000002",
    idempotencyKey: "44444444-4444-4444-8444-555555555555",
  },
  {
    service: "YIELD_OPTIMIZATION",
    benchmarkSlug: "yield-optimization",
    providerSlug: "yield-optimization",
    fixturePath: "fixtures/yield-optimization/venus-to-beefy.v1.json",
    requestKey: "yieldRequest",
    blockNumber: "71000003",
    protocol: "Venus Core Pool stablecoin supply",
    sourceId: "venus-yield-mainnet-block-71000003",
    requestId: "venus-yield-71000003",
    idempotencyKey: "55555555-5555-4555-8555-666666666666",
  },
];

function rebindSyntheticObservation(value, observedAt, sourceId) {
  if (Array.isArray(value)) {
    return value.map((item) => rebindSyntheticObservation(item, observedAt, sourceId));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "observedAt") return [key, observedAt];
      if (key === "sourceId") return [key, sourceId];
      return [key, rebindSyntheticObservation(child, observedAt, sourceId)];
    }),
  );
}

function syntheticCurrentProbe(definition, ordinal) {
  const now = new Date(Date.now() + ordinal * 10);
  const observedAt = new Date(now.getTime() - 15_000).toISOString();
  const explorerUrl = `https://bscscan.com/block/${definition.blockNumber}`;
  const fixture = JSON.parse(
    readFileSync(resolve(root, definition.fixturePath), "utf8"),
  );
  const request = rebindSyntheticObservation(
    structuredClone(fixture),
    observedAt,
    definition.sourceId,
  );
  request.requestId = definition.requestId;
  request.chainId = 56;
  request.protocol = definition.protocol;
  request.requestedAt = now.toISOString();
  request.deadline = new Date(now.getTime() + 5 * 60_000).toISOString();
  request.sources = [{
    sourceId: definition.sourceId,
    label: `Deterministic offline D1 integration observation for ${definition.service}`,
    uri: explorerUrl,
    observedAt,
  }];

  return {
    schemaVersion: "positioncrew.synthetic-current-probe.test.v1",
    relationship: "TEST_ONLY_SYNTHETIC_OBSERVATION",
    state: "READY",
    [definition.requestKey]: request,
    source: {
      blockNumber: definition.blockNumber,
      blockTimestamp: observedAt,
      explorerUrl,
    },
  };
}

async function runAdditionalCurrentLifecycle(baseUrl, definition, ordinal) {
  const probe = syntheticCurrentProbe(definition, ordinal);
  assert.equal(probe.relationship, "TEST_ONLY_SYNTHETIC_OBSERVATION");
  assert.equal(probe.state, "READY");
  const request = structuredClone(probe[definition.requestKey]);
  assert.equal(request.service, definition.service);
  assert.equal(request.chainId, 56);
  assert.equal(request.protocol, definition.protocol);
  assert.equal(request.requestId, definition.requestId);
  assert.equal(request.sources?.length, 1);

  const blockNumber = String(probe.source.blockNumber);
  const explorerUrl = `https://bscscan.com/block/${blockNumber}`;
  const observedAt = probe.source.blockTimestamp;
  const source = request.sources[0];
  assert.match(blockNumber, /^[1-9]\d*$/);
  assert.equal(probe.source.explorerUrl, explorerUrl);
  assert.equal(source.sourceId, definition.sourceId);
  assert.equal(source.uri, explorerUrl);
  assert.equal(source.observedAt, observedAt);

  const payload = {
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
    idempotencyKey: definition.idempotencyKey,
    benchmarkSlug: definition.benchmarkSlug,
    providerSlug: definition.providerSlug,
    evidenceMode: "CURRENT_BLOCK_PINNED",
    observation: { blockNumber, observedAt, explorerUrl },
    request,
  };
  const created = await requestJson(baseUrl, "/api/benchmark-hires", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify(payload),
  });
  assert.equal(
    created.response.status,
    201,
    `${definition.service} hire was not created: ${JSON.stringify(created.body)}`,
  );
  assert.equal(created.body?.hire?.service, definition.service);
  assert.equal(created.body?.hire?.evidenceMode, "CURRENT_BLOCK_PINNED");
  assert.ok(created.body?.hire?.providerHash);
  assert.ok(created.body?.hire?.evidenceHash);
  assert.equal(created.body?.job?.state, "CREATED");
  assert.equal(created.body?.receipt, null);
  const externalProviderComparison = definition.service === "LP_REBALANCE"
    ? created.body?.hire?.evidence?.externalProviderComparison
    : undefined;
  const externalGridComparison = definition.service === "BOUNDED_GRID"
    ? created.body?.hire?.evidence?.externalGridComparison
    : undefined;
  const externalYieldComparison = definition.service === "YIELD_OPTIMIZATION"
    ? created.body?.hire?.evidence?.externalYieldComparison
    : undefined;
  if (definition.service === "LP_REBALANCE") {
    assert.equal(
      externalProviderComparison?.schemaVersion,
      "positioncrew.external-lp-comparison-summary.v1",
    );
    assert.equal(externalProviderComparison?.provider?.erc8004TokenId, "45650");
    assert.equal(externalProviderComparison?.positionTokenId, "9000001");
    assert.equal(externalProviderComparison?.exactRequestAccepted, false);
    assert.equal(typeof externalProviderComparison?.eligibleForLiveMatch, "boolean");
    assert.ok(Array.isArray(externalProviderComparison?.checks));
  }
  if (definition.service === "BOUNDED_GRID") {
    assert.equal(
      externalGridComparison?.schemaVersion,
      "positioncrew.external-grid-comparison-summary.v1",
    );
    assert.equal(externalGridComparison?.provider?.erc8004TokenId, "302258");
    assert.equal(externalGridComparison?.pool, request.venue);
    assert.equal(externalGridComparison?.exactRequestAccepted, false);
    assert.equal(typeof externalGridComparison?.eligibleForLiveMatch, "boolean");
    assert.ok(Array.isArray(externalGridComparison?.checks));
  }
  if (definition.service === "YIELD_OPTIMIZATION") {
    assert.equal(
      externalYieldComparison?.schemaVersion,
      "positioncrew.external-yield-comparison-summary.v1",
    );
    assert.equal(externalYieldComparison?.provider?.erc8004TokenId, "315946");
    assert.equal(externalYieldComparison?.marketCount, request.opportunities.length);
    assert.equal(externalYieldComparison?.exactRequestAccepted, false);
    assert.equal(typeof externalYieldComparison?.eligibleForLiveMatch, "boolean");
    assert.ok(Array.isArray(externalYieldComparison?.checks));
  }

  const run = await requestJson(
    baseUrl,
    `/api/benchmark-hires/${created.body.hire.hireId}/jobs`,
    { method: "POST", headers: { Origin: baseUrl } },
  );
  assert.equal(run.response.status, 202, `${definition.service} job was not accepted`);

  let completed;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const polled = await requestJson(baseUrl, `/api/benchmark-hires/${created.body.hire.hireId}`);
    assert.equal(polled.response.status, 200);
    assert.notEqual(polled.body?.job?.state, "FAILED", `${definition.service} job failed`);
    if (polled.body?.job?.state === "COMPLETED" && polled.body.receipt) {
      completed = polled.body;
      break;
    }
    await delay(100);
  }
  assert.ok(completed, `${definition.service} job did not complete`);
  assert.equal(completed.hire.providerHash, created.body.hire.providerHash);
  assert.equal(completed.hire.evidenceHash, created.body.hire.evidenceHash);
  assert.deepEqual(completed.receipt.response.result.request, request);
  assert.equal(completed.receipt.response.result.evaluation.score, 100);

  const publicReceipt = await requestJson(baseUrl, completed.receipt.publicUrl);
  assert.equal(publicReceipt.response.status, 200);
  assert.equal(publicReceipt.body?.hire?.hireId, completed.hire.hireId);
  assert.equal(publicReceipt.body?.job?.state, "COMPLETED");
  assert.deepEqual(publicReceipt.body?.receipt, completed.receipt);

  return {
    service: definition.service,
    hireId: completed.hire.hireId,
    receiptId: completed.receipt.receiptId,
    providerHash: completed.hire.providerHash,
    evidenceHash: completed.hire.evidenceHash,
    receipt: completed.receipt,
    externalProviderComparison,
    externalGridComparison,
    externalYieldComparison,
  };
}

async function main() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "positioncrew-d1-integration-"));
  let worker;
  try {
    execFileSync(
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
        stdio: "ignore",
      },
    );

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    worker = startWorker(port, stateDirectory);
    await waitForWorker(baseUrl, worker);
    const localActivationStatus = await requestJson(baseUrl, "/api/activations/venus-testnet-supply/status");
    assert.equal(localActivationStatus.response.status, 200);
    assert.equal(localActivationStatus.body.status, "UNAVAILABLE");
    const persisted = await runLifecycle(baseUrl);
    const additionalLifecycles = [];
    for (const [ordinal, definition] of ADDITIONAL_CURRENT_HIRE_CASES.entries()) {
      additionalLifecycles.push(
        await runAdditionalCurrentLifecycle(baseUrl, definition, ordinal),
      );
    }

    await stopWorker(worker.child);
    worker = startWorker(port, stateDirectory);
    await waitForWorker(baseUrl, worker);

    const reloadedHire = await requestJson(
      baseUrl,
      `/api/benchmark-hires/${persisted.hireId}`,
    );
    assert.equal(reloadedHire.response.status, 200);
    assert.equal(reloadedHire.body.job.state, "COMPLETED");
    assert.deepEqual(
      reloadedHire.body.hire.evidence.externalLendingComparison,
      persisted.externalLendingComparison,
    );

    const reloadedReceipt = await requestJson(baseUrl, persisted.receiptPath);
    assert.equal(reloadedReceipt.response.status, 200);
    assert.equal(reloadedReceipt.body.hire.hireId, persisted.hireId);

    for (const lifecycleResult of additionalLifecycles) {
      const reloadedCategoryHire = await requestJson(
        baseUrl,
        `/api/benchmark-hires/${lifecycleResult.hireId}`,
      );
      assert.equal(reloadedCategoryHire.response.status, 200);
      assert.equal(reloadedCategoryHire.body.job.state, "COMPLETED");
      assert.equal(reloadedCategoryHire.body.hire.service, lifecycleResult.service);
      assert.equal(
        reloadedCategoryHire.body.hire.providerHash,
        lifecycleResult.providerHash,
      );
      assert.equal(
        reloadedCategoryHire.body.hire.evidenceHash,
        lifecycleResult.evidenceHash,
      );
      if (lifecycleResult.service === "LP_REBALANCE") {
        assert.deepEqual(
          reloadedCategoryHire.body.hire.evidence.externalProviderComparison,
          lifecycleResult.externalProviderComparison,
        );
      }
      if (lifecycleResult.service === "BOUNDED_GRID") {
        assert.deepEqual(
          reloadedCategoryHire.body.hire.evidence.externalGridComparison,
          lifecycleResult.externalGridComparison,
        );
      }
      if (lifecycleResult.service === "YIELD_OPTIMIZATION") {
        assert.deepEqual(
          reloadedCategoryHire.body.hire.evidence.externalYieldComparison,
          lifecycleResult.externalYieldComparison,
        );
      }

      const reloadedCategoryReceipt = await requestJson(
        baseUrl,
        `/api/benchmark-receipts/${lifecycleResult.receiptId}`,
      );
      assert.equal(reloadedCategoryReceipt.response.status, 200);
      assert.equal(reloadedCategoryReceipt.body.hire.hireId, lifecycleResult.hireId);
      assert.deepEqual(reloadedCategoryReceipt.body.receipt, lifecycleResult.receipt);
    }

    console.log(
      JSON.stringify({
        status: "PASS",
        lifecycle: "create->run->poll->receipt->restart->reload",
        evidenceMode: "CURRENT_BLOCK_PINNED",
        outcome: "REFUSED_CONSTRAINTS",
        categories: 4,
        persistedAfterRestart: 4,
      }),
    );
  } finally {
    if (worker) await stopWorker(worker.child);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

await main();
