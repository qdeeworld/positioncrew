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
  return { hireId, receiptPath: completed.receipt.publicUrl };
}

async function main() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "positioncrew-d1-integration-"));
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
    const persisted = await runLifecycle(baseUrl);

    await stopWorker(worker.child);
    worker = startWorker(port, stateDirectory);
    await waitForWorker(baseUrl, worker);

    const reloadedHire = await requestJson(
      baseUrl,
      `/api/benchmark-hires/${persisted.hireId}`,
    );
    assert.equal(reloadedHire.response.status, 200);
    assert.equal(reloadedHire.body.job.state, "COMPLETED");

    const reloadedReceipt = await requestJson(baseUrl, persisted.receiptPath);
    assert.equal(reloadedReceipt.response.status, 200);
    assert.equal(reloadedReceipt.body.hire.hireId, persisted.hireId);

    console.log(
      JSON.stringify({
        status: "PASS",
        lifecycle: "create->run->poll->receipt->restart->reload",
        evidenceMode: "CURRENT_BLOCK_PINNED",
        outcome: "REFUSED_CONSTRAINTS",
      }),
    );
  } finally {
    if (worker) await stopWorker(worker.child);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

await main();
