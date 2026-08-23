import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const TRANSIENT_REQUEST_ERROR = /socket hang up|ECONNRESET|ECONNREFUSED|fetch failed/i;

async function getWithTransportRetry(request: APIRequestContext, url: string) {
  try {
    return await request.get(url);
  } catch (error) {
    if (!TRANSIENT_REQUEST_ERROR.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return request.get(url);
  }
}

const lendingFixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/lending-rescue/stressed-venus-position.v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const lpFixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/lp-rebalance/out-of-range-v3-position.v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const gridFixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/bounded-grid/bnb-usdt-grid.v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const yieldFixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/yield-optimization/venus-to-beefy.v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

function freshProbeRequest(
  fixture: Record<string, unknown>,
  now: Date,
  sourceId: string,
  sourceLabel: string,
  blockNumber: string,
) {
  const observedAt = new Date(now.getTime() - 5_000).toISOString();
  const rebase = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rebase);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === "observedAt") return [key, observedAt];
      if (key === "sourceId") return [key, sourceId];
      return [key, rebase(child)];
    }));
  };
  const request = rebase(structuredClone(fixture)) as Record<string, unknown>;
  request.requestId = `browser-probe-${now.getTime()}-${String(request.service).toLowerCase()}`;
  request.requestedAt = now.toISOString();
  request.deadline = new Date(now.getTime() + 5 * 60_000).toISOString();
  request.sources = [{
    sourceId,
    label: sourceLabel,
    uri: `https://bscscan.com/block/${blockNumber}`,
    observedAt,
  }];
  return request;
}

async function installDeterministicLiveProbeRoutes(page: Page) {
  const now = new Date();
  const blockNumber = "117112307";
  const gridSourceId = `pancake-v3-mainnet-block-${blockNumber}`;
  const yieldSourceId = `venus-yield-mainnet-block-${blockNumber}`;
  const gridRequest = freshProbeRequest(
    gridFixture,
    now,
    gridSourceId,
    `PancakeSwap V3 market at BSC block ${blockNumber}`,
    blockNumber,
  );
  const yieldRequest = freshProbeRequest(
    yieldFixture,
    now,
    yieldSourceId,
    `Venus stablecoin markets at BSC block ${blockNumber}`,
    blockNumber,
  );

  await page.route("**/api/status", async (route) => {
    const chain = (chainId: 56 | 97, name: string) => ({
      chainId,
      name,
      blockNumber,
      blockTimestamp: now.toISOString(),
      blockAgeSeconds: 1,
      gasPriceGwei: "0.1",
      rpcLatencyMs: 42,
      rpcUrl: "https://bsc-dataseed.bnbchain.org",
      explorerUrl: `https://bscscan.com/block/${blockNumber}`,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "positioncrew.system-telemetry.v1",
        generatedAt: now.toISOString(),
        mainnet: chain(56, "BNB Smart Chain"),
        testnet: chain(97, "BNB Smart Chain Testnet"),
        market: {
          pair: "WBNB/USDT",
          venue: "PancakeSwap V3",
          poolAddress: "0x36696169C63e42cd08ce11f5deeBbCeBae652050",
          feeTier: 100,
          spotPriceUsd: "860",
          tick: 0,
          liquidityRaw: "1000000",
          observedAt: now.toISOString(),
          explorerUrl: `https://bscscan.com/block/${blockNumber}`,
        },
        venus: {
          market: "vUSDT",
          address: "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
          supplyAprPct: "3.25",
          borrowAprPct: "5.5",
          availableLiquidityUsd: "10000000",
          totalBorrowsUsd: "5000000",
          observedAt: now.toISOString(),
          explorerUrl: `https://bscscan.com/block/${blockNumber}`,
        },
      }),
    });
  });
  await page.route(/\/api\/wallets\/[^/]+\/venus(?:\?.*)?$/, async (route) => {
    const account = route.request().url().split("/wallets/")[1]?.split("/")[0] ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "positioncrew.venus-account-probe.v1",
        generatedAt: now.toISOString(),
        chainId: 56,
        account,
        state: "NO_POSITION",
        nativeBalanceBnb: "0",
        usdtBalance: "0",
        liquidityUsd: "0",
        shortfallUsd: "0",
        enteredMarkets: [],
        position: {
          collateralValueUsd: "0",
          liquidationWeightedCollateralUsd: "0",
          debtValueUsd: "0",
          healthFactor: null,
          markets: [],
        },
        rescueRequest: null,
        source: {
          comptroller: "0xfD36E2c2a6789Db23113685031d7F16329158384",
          blockNumber,
          explorerUrl: `https://bscscan.com/block/${blockNumber}`,
        },
        boundary: "Deterministic block-pinned browser fixture.",
      }),
    });
  });
  await page.route("**/api/markets/pancake/wbnb-usdt/grid", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "positioncrew.pancake-grid-probe.v1",
        generatedAt: now.toISOString(),
        chainId: 56,
        state: "READY",
        market: {
          pair: "WBNB/USDT",
          poolAddress: "0x36696169C63e42cd08ce11f5deeBbCeBae652050",
          feeTier: 100,
          spotPriceUsd: "10",
          activeLiquidityUsd: "1000000",
          reserveValueUsd: "1000000",
          realizedVolatilityBps: 300,
          volatilityWindowSeconds: 3600,
          volatilitySampleCount: 4,
        },
        gridRequest,
        source: {
          blockNumber,
          blockTimestamp: now.toISOString(),
          explorerUrl: `https://bscscan.com/block/${blockNumber}`,
          poolExplorerUrl: "https://bscscan.com/address/0x36696169C63e42cd08ce11f5deeBbCeBae652050",
        },
        boundary: "Deterministic block-pinned PancakeSwap browser fixture.",
      }),
    });
  });
  await page.route("**/api/markets/venus/stable-yields", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "positioncrew.venus-yield-probe.v1",
        generatedAt: now.toISOString(),
        chainId: 56,
        state: "READY",
        markets: [
          { opportunityId: "venus-usdt", symbol: "USDT", vToken: "0x1111111111111111111111111111111111111111", underlying: "0x55d398326f99059fF775485246999027B3197955", baseSupplyApyBps: 400, availableLiquidityUsd: "10000000" },
          { opportunityId: "venus-usdc", symbol: "USDC", vToken: "0x2222222222222222222222222222222222222222", underlying: "0x3333333333333333333333333333333333333333", baseSupplyApyBps: 350, availableLiquidityUsd: "9000000" },
          { opportunityId: "venus-lisusd", symbol: "lisUSD", vToken: "0x4444444444444444444444444444444444444444", underlying: "0x5555555555555555555555555555555555555555", baseSupplyApyBps: 300, availableLiquidityUsd: "8000000" },
          { opportunityId: "venus-usdf", symbol: "USDF", vToken: "0x6666666666666666666666666666666666666666", underlying: "0x7777777777777777777777777777777777777777", baseSupplyApyBps: 250, availableLiquidityUsd: "7000000" },
        ],
        yieldRequest,
        source: {
          comptroller: "0xfD36E2c2a6789Db23113685031d7F16329158384",
          oracle: "0x8888888888888888888888888888888888888888",
          blockNumber,
          blockTimestamp: now.toISOString(),
          measuredSecondsPerBlock: 3,
          explorerUrl: `https://bscscan.com/block/${blockNumber}`,
        },
        boundary: "Deterministic block-pinned Venus browser fixture.",
      }),
    });
  });
}

function liveLendingRequest(now: Date, account: string, blockNumber: string) {
  const observedAt = new Date(now.getTime() - 5_000).toISOString();
  const sourceId = `venus-mainnet-block-${blockNumber}`;
  const rebase = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rebase);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === "observedAt") return [key, observedAt];
      if (key === "sourceId") return [key, sourceId];
      return [key, rebase(child)];
    }));
  };
  const request = rebase(structuredClone(lendingFixture)) as Record<string, unknown>;
  request.requestId = `venus-live-e2e-${now.getTime()}`;
  request.account = account;
  request.requestedAt = now.toISOString();
  request.deadline = new Date(now.getTime() + 5 * 60_000).toISOString();
  request.sources = [{
    sourceId,
    label: `Venus Classic account and oracle snapshot at BSC block ${blockNumber}`,
    uri: `https://bscscan.com/block/${blockNumber}`,
    observedAt,
  }];
  return request;
}

function liveLpRequest(now: Date, tokenId: string, blockNumber: string) {
  const observedAt = new Date(now.getTime() - 5_000).toISOString();
  const sourceId = `pancake-position-mainnet-block-${blockNumber}`;
  const rebase = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rebase);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === "observedAt") return [key, observedAt];
      if (key === "sourceId") return [key, sourceId];
      return [key, rebase(child)];
    }));
  };
  const request = rebase(structuredClone(lpFixture)) as Record<string, unknown>;
  request.requestId = `pancake-position-live-e2e-${now.getTime()}`;
  request.protocol = "PancakeSwap V3 position analysis";
  request.requestedAt = now.toISOString();
  request.deadline = new Date(now.getTime() + 5 * 60_000).toISOString();
  request.sources = [{
    sourceId,
    label: `PancakeSwap V3 position at BSC block ${blockNumber}`,
    uri: `https://bscscan.com/block/${blockNumber}`,
    observedAt,
  }];
  return request;
}

function currentLendingResponse(
  request: Record<string, unknown>,
  now: Date,
  refused = false,
) {
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const recommendation = refused ? null : {
    kind: "REPAY_DEBT",
    amount: "152",
    amountBaseUnits: "152000000000000000000",
    amountUsd: "152",
    asset: {
      symbol: "USDT",
      address: "0x55d398326f99059fF775485246999027B3197955",
      decimals: 18,
    },
    projectedHealthFactor: "1.25",
    estimatedGasUsd: "0.05",
    executeBefore: expiresAt,
    maxSlippageBps: 30,
    preconditions: ["Revalidate the Venus position before execution."],
  };
  return {
    schemaVersion: "positioncrew.fixture-job-response.v1",
    evidenceMode: "CALLER_SUPPLIED_OBSERVATIONS",
    commerceMode: "IN_MEMORY_CONFORMANCE",
    advantageStatus: "PENDING_INDEPENDENT_BLIND_EVALUATION",
    generatedAt: now.toISOString(),
    claimBoundary: ["Unsigned provider output.", "No wallet transaction or payment."],
    benchmarkLock: null,
    receipt: {
      mode: "SESSION_EMBEDDED",
      path: null,
      evaluationHash: `sha256:${"e".repeat(64)}`,
    },
    result: {
      job: {
        jobId: "22222222-2222-4222-8222-222222222222",
        state: "COMPLETED",
        envelopeHash: `sha256:${"a".repeat(64)}`,
        providerId: "positioncrew:lending-rescue:v1",
        evaluatorId: "positioncrew:conformance:v1",
        history: [
          { state: "CREATED", at: now.toISOString(), reference: `sha256:${"a".repeat(64)}` },
          { state: "COMPLETED", at: now.toISOString(), reference: `sha256:${"b".repeat(64)}` },
        ],
        deliverable: { deliverableHash: `sha256:${"b".repeat(64)}` },
      },
      request,
      deliverable: {
        service: "LENDING_RESCUE",
        status: refused ? "REFUSED_CONSTRAINTS" : "ACTIONABLE",
        decision: refused ? "REFUSED_CONSTRAINTS" : "RESCUE",
        summary: refused
          ? "No allowed rescue action fits the wallet inventory and safety limits."
          : "A bounded debt repayment restores the requested health factor.",
        expiresAt,
        recommendation,
        alternatives: [],
        position: {
          collateralValueUsd: "1200",
          debtValueUsd: "920",
          currentHealthFactor: "1.04347826",
          stressedHealthFactor: "0.93913043",
          targetHealthFactor: "1.25",
        },
        invalidationConditions: ["Position state changes after the pinned block."],
      },
      evaluation: {
        score: 100,
        passed: true,
        evaluationHash: `sha256:${"e".repeat(64)}`,
        checks: [],
      },
    },
  };
}

async function installCurrentLendingHireRoutes(
  page: Page,
  options: { abortCreate?: boolean; abortRun?: boolean; refused?: boolean } = {},
) {
  const now = new Date();
  const account = "0x1111111111111111111111111111111111111111";
  const blockNumber = "115607036";
  const hireId = "11111111-1111-4111-8111-111111111111";
  const receiptId = "33333333-3333-4333-8333-333333333333";
  const rescueRequest = liveLendingRequest(now, account, blockNumber);
  const source = (rescueRequest.sources as Array<Record<string, unknown>>)[0];
  const observation = {
    blockNumber,
    observedAt: String(source.observedAt),
    explorerUrl: `https://bscscan.com/block/${blockNumber}`,
  };
  const response = currentLendingResponse(rescueRequest, now, options.refused);
  const createBodies: Array<Record<string, unknown>> = [];
  let runCount = 0;
  let receiptLoadCount = 0;

  const chain = (state: "CREATED" | "RUNNING" | "COMPLETED") => ({
    schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
    claimBoundary: [
      "Current block-pinned input.",
      "$0 and no wallet.",
      "Unsigned plan or refusal only.",
      "No payment or transaction execution.",
    ],
    hire: {
      hireId,
      idempotencyKey: String(createBodies.at(-1)?.idempotencyKey ?? "44444444-4444-4444-8444-444444444444"),
      providerSlug: "lending-rescue",
      providerId: "positioncrew:lending-rescue:v1",
      benchmarkSlug: "lending-rescue",
      service: "LENDING_RESCUE",
      evidenceMode: "CURRENT_BLOCK_PINNED",
      commerce: { directCostUsd: "0.00", walletRequired: false, settlement: "NO_PAYMENT" },
      request: rescueRequest,
      requestHash: `sha256:${"c".repeat(64)}`,
      evidence: observation,
      evidenceHash: `sha256:${"d".repeat(64)}`,
      providerHash: `sha256:${"f".repeat(64)}`,
      createdAt: now.toISOString(),
    },
    job: {
      jobId: "22222222-2222-4222-8222-222222222222",
      state,
      status: state === "CREATED" ? "HIRE_RECORDED" : state,
      createdAt: now.toISOString(),
      startedAt: state === "CREATED" ? null : now.toISOString(),
      completedAt: state === "COMPLETED" ? now.toISOString() : null,
      apiDurationMilliseconds: state === "COMPLETED" ? 43 : null,
      error: null,
    },
    receipt: state === "COMPLETED" ? {
      receiptId,
      publicUrl: `/api/benchmark-receipts/${receiptId}`,
      responseHash: `sha256:${"9".repeat(64)}`,
      deliverableHash: `sha256:${"b".repeat(64)}`,
      evaluationHash: `sha256:${"e".repeat(64)}`,
      createdAt: now.toISOString(),
      response,
    } : null,
  });

  await page.route("**/api/wallets/*/venus", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "positioncrew.venus-account-probe.v1",
        generatedAt: now.toISOString(),
        chainId: 56,
        account,
        state: "LIQUID",
        nativeBalanceBnb: "0.25",
        usdtBalance: "200",
        liquidityUsd: "40",
        shortfallUsd: "0",
        enteredMarkets: [
          "0xA07c5b74C9B40447a954e1466938b865b6BBea36",
          "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
        ],
        position: {
          collateralValueUsd: "1200",
          liquidationWeightedCollateralUsd: "960",
          debtValueUsd: "920",
          healthFactor: "1.04347826",
          markets: [{
            vToken: "0xA07c5b74C9B40447a954e1466938b865b6BBea36",
            symbol: "WBNB",
            underlying: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
            decimals: 18,
            suppliedAmount: "2",
            borrowedAmount: "0",
            walletAmount: "0.5",
            priceUsd: "600",
            collateralFactorBps: 8000,
            liquidationThresholdBps: 8000,
            collateralEnabled: true,
          }],
        },
        rescueRequest,
        source: {
          comptroller: "0xfD36E2c2a6789Db23113685031d7F16329158384",
          blockNumber,
          explorerUrl: observation.explorerUrl,
        },
        boundary: "Block-pinned Venus Classic reconstruction.",
      }),
    });
  });
  await page.route(/\/api\/benchmark-hires$/, async (route) => {
    createBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (options.abortCreate) return route.abort("connectionreset");
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(chain("CREATED")) });
  });
  await page.route(new RegExp(`/api/benchmark-hires/${hireId}/jobs$`), async (route) => {
    runCount += 1;
    if (options.abortRun) return route.abort("connectionreset");
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(chain("RUNNING")) });
  });
  await page.route(new RegExp(`/api/benchmark-hires/${hireId}$`), async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(chain("COMPLETED")) });
  });
  await page.context().route(`**/api/benchmark-receipts/${receiptId}`, async (route) => {
    receiptLoadCount += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(chain("COMPLETED")) });
  });

  return {
    account,
    blockNumber,
    hireId,
    receiptId,
    rescueRequest,
    observation,
    createBodies,
    get runCount() { return runCount; },
    get receiptLoadCount() { return receiptLoadCount; },
  };
}

test("a cold buyer can discover, hire, and inspect the lending provider", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page);
  await page.goto("/#marketplace");
  await expect(page.getByRole("heading", { name: "Hire a capital operator." })).toBeVisible();
  await expect(page.getByText("4/4", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: /Lending Rescue v1/ })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Load current position and hire" }).click();
  await expect(page.getByRole("heading", { name: "Define the job. Inspect the action." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Historical replay in Evidence" })).toHaveAttribute("href", "#evidence");
  await expect(page.getByText(/Hire remains disabled until the exact request and block evidence are ready/)).toBeVisible();
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  await expect(page.getByText("Current request loaded", { exact: true })).toBeVisible();
  await expect(page.getByText(`Block-pinned Venus position from BSC block ${mockedHire.blockNumber}`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Hire and run current position" }).click();

  await expect(page.getByRole("heading", { name: "Repay 152 USDT" })).toBeVisible();
  await expect(page.locator(".result-boundary")).toContainText(
    "Block-pinned Venus input. The provider output is unsigned and must be revalidated against current protocol state before execution.",
  );
  await expect(page.getByText("100/100", { exact: true }).first()).toBeVisible();
  const advantageStatus = page.getByRole("region", { name: "Founder Agent Advantage comparison status" });
  await expect(advantageStatus.getByText("Founder comparison published", { exact: true })).toBeVisible();
  await expect(advantageStatus).toContainText("3/3 frozen tasks record exact canonical output parity");
  await expect(advantageStatus.getByRole("link", { name: "Open founder report" })).toHaveAttribute(
    "href",
    "/evidence/agent-advantage-founder/",
  );
  await page.getByRole("button", { name: "JSON" }).click();
  await expect(page.getByText("application/json", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Receipt", exact: true }).click();
  await expect(page.getByText("Score receipt", { exact: true })).toBeVisible();
  await expect(page.getByText("SESSION EMBEDDED", { exact: true })).toBeVisible();
  await expect(page.getByText("CURRENT BLOCK PINNED", { exact: true })).toBeVisible();
  await expect(page.getByText("43 ms", { exact: true })).toBeVisible();
  expect(mockedHire.createBodies).toHaveLength(1);
  expect(mockedHire.createBodies[0]).toMatchObject({
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
    benchmarkSlug: "lending-rescue",
    providerSlug: "lending-rescue",
    evidenceMode: "CURRENT_BLOCK_PINNED",
    observation: mockedHire.observation,
  });
  expect(mockedHire.createBodies[0].request).toEqual(mockedHire.rescueRequest);
  const [receiptPage] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("link", { name: "Reload durable receipt" }).click(),
  ]);
  await expect(receiptPage.locator("body")).toContainText(mockedHire.hireId);
  await receiptPage.reload();
  await expect(receiptPage.locator("body")).toContainText(`sha256:${"9".repeat(64)}`);
  expect(mockedHire.receiptLoadCount).toBe(2);
});

test("a lost hire response reuses the unresolved idempotency key", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page, { abortCreate: true });
  await page.goto("/#marketplace");
  await page.getByRole("button", { name: "Load current position and hire" }).click();
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  const hireButton = page.getByRole("button", { name: "Hire and run current position" });
  await hireButton.click();
  await expect.poll(() => mockedHire.createBodies.length).toBe(1);
  await expect(hireButton).toBeEnabled();
  await hireButton.click();
  await expect.poll(() => mockedHire.createBodies.length).toBe(2);
  expect(mockedHire.createBodies[1].idempotencyKey).toBe(mockedHire.createBodies[0].idempotencyKey);
});

test("a lost job response resumes the persisted hire instead of creating another", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page, { abortRun: true });
  await page.goto("/#marketplace");
  await page.getByRole("button", { name: "Load current position and hire" }).click();
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  const hireButton = page.getByRole("button", { name: "Hire and run current position" });
  await hireButton.click();
  await expect.poll(() => mockedHire.runCount).toBe(1);
  await expect(hireButton).toBeEnabled();
  await hireButton.click();
  await expect.poll(() => mockedHire.runCount).toBe(2);
  expect(mockedHire.createBodies).toHaveLength(1);
});

test("slow remote hydration never blocks provider discovery", async ({ page }) => {
  await page.route(/\/api\/(providers|commerce\/aacp)(\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await route.abort("timedout");
  });

  await page.goto("/#marketplace");
  await expect(page.getByRole("button", { name: /Lending Rescue v1/ })).toBeVisible({
    timeout: 3_000,
  });
  await expect(page.getByRole("button", { name: "Load current position and hire" })).toBeVisible();
  await expect(page.getByRole("button", { name: /LP Range Operator v1/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Yield Allocator v1/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Bounded Grid Builder v1/ })).toBeVisible();
  await expect(page.getByText("Connecting", { exact: true })).toHaveText("Connecting");
});

test("BSC telemetry and Venus wallet risk are independently inspectable", async ({ page }) => {
  await installDeterministicLiveProbeRoutes(page);
  await page.goto("/#marketplace");
  await expect(page.getByText("LIVE BSC DATA", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".market-system-panel").getByText("4/4", { exact: true })).toBeVisible();

  await page.goto("/#jobs");
  await page.getByPlaceholder("0x account address").fill("0x0000000000000000000000000000000000000001");
  await page.getByRole("button", { name: "Load position" }).click();
  await expect(page.getByText("NO POSITION", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: /Block [0-9,]+/ })).toHaveAttribute("href", /bscscan\.com\/block/);
});

test("a block-pinned Venus position can become the provider request", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page);
  await page.goto("/#jobs");
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  await expect(page.getByText("1.04347826", { exact: true })).toBeVisible();
  await expect(page.getByText(`Block-pinned Venus position from BSC block ${mockedHire.blockNumber}`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Hire and run current position" }).click();
  await expect(page.getByRole("heading", { name: "Repay 152 USDT" })).toBeVisible();
  await expect(page.getByText(/Block-pinned Venus input/)).toBeVisible();
  expect(mockedHire.createBodies[0].request).toEqual(mockedHire.rescueRequest);
});

test("a block-pinned Pancake market can become a bounded grid request", async ({ page }) => {
  await installDeterministicLiveProbeRoutes(page);
  await page.goto("/#jobs");
  await page.getByRole("combobox", { name: "Provider" }).selectOption("BOUNDED_GRID");
  await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("PancakeSwap market probe", { exact: true })).toBeVisible();
  await expect(page.getByText(/Block-pinned PancakeSwap market from BSC block/)).toBeVisible();
  await page.getByRole("button", { name: "Run bounded grid simulation" }).click();
  await expect(page.getByRole("heading", { name: /Build [45] bounded orders/ })).toBeVisible();
  await expect(page.getByText(/Block-pinned PancakeSwap input/)).toBeVisible();

});

test("a block-pinned Pancake position can become an LP rebalance request", async ({ page }) => {
  const tokenId = "1456267";
  const blockNumber = "115618500";
  const now = new Date();
  const lpRequest = liveLpRequest(now, tokenId, blockNumber);
  await page.route(`**/api/positions/pancake/${tokenId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "positioncrew.pancake-position-probe.v1",
        generatedAt: now.toISOString(),
        chainId: 56,
        state: "READY",
        position: {
          tokenId,
          owner: "0x556B9306565093C855AEA9AE92A594704c2Cd59e",
          custody: "MASTER_CHEF_V3",
          positionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
          pool: "0x36696169C63e42cd08ce11f5deeBbCeBae652050",
          pair: "USDT/WBNB",
          feeTier: 500,
          lowerTick: -120,
          upperTick: 120,
          currentTick: 150,
          inRange: false,
          liquidity: "1000000",
          token0Amount: "10000",
          token1Amount: "0",
          positionValueUsd: "10000",
          uncollectedFeesUsd: "42",
        },
        market: {
          activeLiquidityUsd: "1000000",
          realizedVolatilityBps: 400,
          volumeRunRate24hUsd: "5000000",
          feesRunRate24hUsd: "2000",
          measurementWindowSeconds: 3600,
          swapCount: 240,
        },
        lpRequest,
        source: {
          blockNumber,
          blockTimestamp: now.toISOString(),
          explorerUrl: `https://bscscan.com/block/${blockNumber}`,
          positionExplorerUrl: `https://bscscan.com/nft/0x46A15B0b27311cedF172AB29E4f4766fbE7F4364/${tokenId}`,
          poolExplorerUrl: "https://bscscan.com/address/0x36696169C63e42cd08ce11f5deeBbCeBae652050",
        },
        boundary: "Read-only block-pinned position reconstruction with an exact swap window.",
      }),
    });
  });

  await page.goto("/#jobs");
  await page.getByRole("combobox", { name: "Provider" }).selectOption("LP_REBALANCE");
  await expect(page.getByRole("heading", { name: "PancakeSwap LP position" })).toBeVisible();
  await expect(page.getByLabel("PancakeSwap position NFT ID")).toHaveValue(tokenId);
  await page.getByRole("button", { name: "Inspect" }).click();
  await expect(page.getByText("OUT OF RANGE", { exact: true })).toBeVisible();
  await expect(page.getByText("$10,000", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use live position" }).click();
  await expect(page.getByText(`Block-pinned PancakeSwap position from BSC block ${blockNumber}`, { exact: false })).toBeVisible();
  await expect(page.getByLabel("Current tick")).toBeDisabled();
  await page.getByRole("button", { name: "Run lp rebalance" }).click();
  await expect(page.getByRole("heading", { name: "SHIFT range to 0...240" })).toBeVisible();
  await expect(page.locator(".result-boundary")).toContainText("Block-pinned PancakeSwap position");
});

test("block-pinned Venus stablecoin rates can become a yield request", async ({ page }) => {
  await installDeterministicLiveProbeRoutes(page);
  await page.goto("/#jobs");
  await page.getByRole("combobox", { name: "Provider" }).selectOption("YIELD_OPTIMIZATION");
  await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Venus stablecoin probe", { exact: true })).toBeVisible();
  await expect(page.getByText(/Block-pinned Venus yield market from BSC block/)).toBeVisible();
  await expect(page.getByLabel("Leading base APY (bps)")).toBeDisabled();
  await page.getByRole("button", { name: "Run yield optimisation simulation" }).click();
  await expect(page.getByRole("heading", { name: /to beefy-usdt-vault/ })).toBeVisible();
  await expect(page.getByText(/Block-pinned Venus yield input/)).toBeVisible();

});

test("all four mandatory capital jobs return category-specific results", async ({ page }) => {
  await installDeterministicLiveProbeRoutes(page);
  await page.goto("/#jobs");
  const provider = page.getByRole("combobox", { name: "Provider" });
  await expect(provider).toBeVisible();
  const cases = [
    { value: "LP_REBALANCE", button: "Run lp rebalance simulation", output: "SHIFT range to 0...240" },
    { value: "YIELD_OPTIMIZATION", button: "Run yield optimisation simulation", output: /to beefy-usdt-vault/ },
    { value: "BOUNDED_GRID", button: "Run bounded grid simulation", output: "Build 4 bounded orders" },
  ];
  for (const candidate of cases) {
    await provider.selectOption(candidate.value);
    if (candidate.value === "LP_REBALANCE") {
      await page.getByRole("button", { name: "Interactive" }).click();
    }
    if (candidate.value === "BOUNDED_GRID" || candidate.value === "YIELD_OPTIMIZATION") {
      await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 20_000 });
    }
    await page.getByRole("button", { name: candidate.button }).click();
    await expect(page.getByRole("heading", {
      name: candidate.value === "BOUNDED_GRID" ? /Build [45] bounded orders/ : candidate.output,
    })).toBeVisible();
  }
  await expect(page.getByText("3 jobs", { exact: true })).toBeVisible();
});

test("a current lending refusal persists and remains inspectable", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page, { refused: true });
  await page.goto("/#jobs");
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  await page.getByRole("button", { name: "Hire and run current position" }).click();
  const durableResult = page.locator(".job-result");
  await expect(durableResult.getByRole("heading", { name: "REFUSED CONSTRAINTS", exact: true })).toBeVisible();
  await expect(durableResult.getByText("No allowed rescue action fits the wallet inventory and safety limits.", { exact: true })).toBeVisible();
  const durableStatus = page.locator('.request-boundary[role="status"]');
  await expect(durableStatus.getByRole("link", { name: "Public receipt" })).toHaveAttribute(
    "href",
    `/api/benchmark-receipts/${mockedHire.receiptId}`,
  );
});

test("every non-lending provider accepts custom bounds and fails closed", async ({ page }) => {
  await installDeterministicLiveProbeRoutes(page);
  await page.goto("/#jobs");
  const provider = page.getByRole("combobox", { name: "Provider" });
  const cases = [
    {
      service: "LP_REBALANCE",
      field: "Minimum net benefit (USD)",
      value: "1000",
      button: "Run lp rebalance simulation",
      decision: "HOLD",
    },
    {
      service: "YIELD_OPTIMIZATION",
      field: "Minimum net benefit (USD)",
      value: "1000",
      button: "Run yield optimisation simulation",
      decision: "HOLD",
    },
    {
      service: "BOUNDED_GRID",
      field: "Maximum loss (USD)",
      value: "1",
      button: "Run bounded grid simulation",
      decision: "NO GRID",
    },
  ];

  for (const candidate of cases) {
    await provider.selectOption(candidate.service);
    if (candidate.service === "LP_REBALANCE") {
      await page.getByRole("button", { name: "Interactive" }).click();
    }
    if (candidate.service === "BOUNDED_GRID" || candidate.service === "YIELD_OPTIMIZATION") {
      await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 20_000 });
    }
    await page.getByLabel(candidate.field).fill(candidate.value);
    await expect(page.getByText(
      candidate.service === "BOUNDED_GRID"
        ? /Block-pinned PancakeSwap market/
        : candidate.service === "YIELD_OPTIMIZATION"
          ? /Block-pinned Venus yield market/
          : /Current-clock scenario with custom bounds|Block-pinned PancakeSwap LP position/,
    )).toBeVisible();
    await page.getByRole("button", { name: candidate.button }).click();
    await expect(page.getByRole("heading", { name: candidate.decision })).toBeVisible();
    await page.getByTitle("Reset interactive bounds").click();
    await expect(page.getByText(
      candidate.service === "BOUNDED_GRID"
        ? /Block-pinned PancakeSwap market/
        : candidate.service === "YIELD_OPTIMIZATION"
          ? /Block-pinned Venus yield market/
          : /Current-clock simulation seeded from the August 12 fixture|Block-pinned PancakeSwap LP position/,
    )).toBeVisible();
  }
});

test("the evidence page separates conformance from advantage claims", async ({ page, request }) => {
  test.setTimeout(60_000);
  const publicationResponse = await getWithTransportRetry(request, "/evidence/agent-advantage-status.json");
  expect(publicationResponse.ok()).toBe(true);
  expect(await publicationResponse.json()).toMatchObject({
    schemaVersion: "positioncrew.agent-advantage-publication.v1",
    status: "PENDING_INDEPENDENT_BLIND_EVALUATION",
    taskCount: 3,
    supportedAdvantageCount: null,
  });
  await page.goto("/#evidence");
  await expect(page.getByRole("heading", { name: "Evidence register" })).toBeVisible();
  await expect(page.getByText("4/4", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("3/3", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("6", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("OBSERVED", { exact: true })).toHaveCount(3);
  await expect(page.getByText("source-committed agent runs", { exact: true })).toBeVisible();
  await expect(page.getByText(/source 3b28703/).first()).toBeVisible();
  await expect(page.getByText("No independent/blind result is claimed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Funded provider receipts" })).toBeVisible();
  await expect(page.getByText("0.6 U", { exact: true })).toBeVisible();
  await expect(page.getByText("Verified integration, disclosed operator.", { exact: true })).toBeVisible();
  await expect(page.getByText(/not external purchases, revenue, or the pending blind Agent Advantage result/)).toBeVisible();
  const aacpSection = page.getByRole("region", { name: "AACP deployment and provider onboarding" });
  await expect(aacpSection).toBeVisible();
  await expect(
    aacpSection.locator(".aacp-facts > div").filter({ hasText: "mainnet identities" }).getByText("4/4", { exact: true }),
  ).toBeVisible();
  await expect(
    aacpSection.locator(".aacp-facts > div").filter({ hasText: "public listings" }).getByText("4/4", { exact: true }),
  ).toBeVisible();
  await expect(
    aacpSection.locator(".aacp-facts > div").filter({ hasText: "dedicated flagship" }).locator("strong"),
  ).toBeVisible();
  await expect(
    aacpSection.getByText(/Original fleet \d\/4; reported separately|Expiring A2A presence; reported separately from core health/),
  ).toBeVisible();

  const commerceResponse = await getWithTransportRetry(page.request, "/api/commerce/erc8183");
  expect(commerceResponse.status()).toBe(200);
  const commerce = await commerceResponse.json();
  expect(commerce.schemaVersion).toBe("positioncrew.erc8183-testnet-ledger.v1");
  expect(commerce.summary).toMatchObject({
    completedLifecycles: 7,
    fundedCompletedJobs: 6,
    mandatoryCategoriesCovered: 4,
    totalEscrowDisplay: "0.6 U",
    externalBuyerJobs: 0,
    externalRevenue: "0",
  });
  expect(commerce.jobs.filter((job: { runType: string }) => job.runType === "FUNDED_CATEGORY_RECEIPT")).toHaveLength(4);

  const benchmarkResponse = await getWithTransportRetry(page.request, "/api/benchmarks/repeatability");
  expect(benchmarkResponse.status()).toBe(200);
  const benchmark = await benchmarkResponse.json();
  expect(benchmark.schemaVersion).toBe("positioncrew.benchmark-repeatability-matrix.v1");
  expect(benchmark.records).toHaveLength(3);
  expect(benchmark.records.every((record: { runs: unknown[] }) => record.runs.length === 2)).toBe(true);

  const captureResponse = await getWithTransportRetry(page.request, "/api/benchmarks/captures");
  expect(captureResponse.status()).toBe(200);
  const captures = await captureResponse.json();
  expect(captures.manifestHash).toBe("sha256:2ea15ab328fba502d17e55a27a574cfc31b1d2f4bd04a3c23f8f79d003c9e9a1");
  expect(captures.benchmarks.flatMap((item: { candidates: unknown[] }) => item.candidates)).toHaveLength(6);
});

test("direct product links resolve to their canonical application views", async ({ page }) => {
  for (const view of ["marketplace", "jobs", "evidence"] as const) {
    await page.goto(`/${view}`);
    await expect(page).toHaveURL(new RegExp(`/#${view}$`));
  }
});

test("the evidence page exposes the precommitted public marketplace deliveries", async ({ page, request }) => {
  const response = await getWithTransportRetry(request, "/api/benchmarks/marketplace-provenance");
  expect(response.ok()).toBeTruthy();
  const provenance = await response.json();
  expect(provenance.aggregate).toMatchObject({
    plannedAttemptCount: 6,
    recordedAttemptCount: 6,
    successCount: 6,
    allAttemptsSucceeded: true,
  });

  await page.goto("/#evidence");
  const deliverySection = page.getByRole("region", { name: "Delivered through public Provider endpoints" });
  await expect(deliverySection).toBeVisible();
  await expect(deliverySection.getByText("6/6", { exact: true }).first()).toBeVisible();
  await expect(deliverySection.getByText("controlled endpoint observations", { exact: true })).toBeVisible();
  await expect(deliverySection.getByText("0", { exact: true })).toBeVisible();
  await expect(deliverySection.getByText("retries or replacements", { exact: true })).toBeVisible();
  await expect(deliverySection.getByText("3/3", { exact: true })).toBeVisible();
  await expect(deliverySection.getByText("exact output pairs", { exact: true })).toBeVisible();
  await expect(deliverySection.getByRole("link", { name: /Raw record/ })).toHaveAttribute(
    "href",
    "/api/benchmarks/marketplace-provenance",
  );
});

test("a published Agent Advantage status exposes the committed report without changing its scope", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page);
  await page.route("**/api/benchmarks/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "positioncrew.agent-advantage-publication.v1",
        status: "PUBLISHED",
        reportUrl: "/evidence/agent-advantage/",
        reportHash: `sha256:${"1".repeat(64)}`,
        evidenceManifestHash: `sha256:${"2".repeat(64)}`,
        publishedAt: "2026-08-13T03:30:00.000Z",
        taskCount: 3,
        supportedAdvantageCount: 2,
        agentBlindQualityScore: 287,
        boundary:
          "This fixture verifies the published user interface only and is not a real Agent Advantage result.",
      }),
    });
  });
  await page.goto("/#evidence");
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  await expect(page.getByText("Independent result published.")).toBeVisible();
  await expect(page.getByText(/2\/3 frozen tasks support the pre-registered advantage rule/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open independently scored report" })).toHaveAttribute(
    "href",
    "/evidence/agent-advantage/",
  );
  await expect(page.getByText(/scope remains limited to the published report/)).toBeVisible();

  await page.goto("/#jobs");
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  await page.getByRole("button", { name: "Hire and run current position" }).click();
  const resultStatus = page.getByRole("region", { name: "Agent Advantage status" });
  await expect(resultStatus.getByText("Independent report published", { exact: true })).toBeVisible();
  await expect(resultStatus).toContainText("2/3 frozen tasks support the pre-registered advantage rule");
  await expect(resultStatus.getByRole("link", { name: "Open report" })).toHaveAttribute(
    "href",
    "/evidence/agent-advantage/",
  );
});

test("the evidence page exposes every scheduled production outcome after the fixed epoch", async ({ page }) => {
  await page.route("**/api/operations/production**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "positioncrew.production-track-record.v1",
        generatedAt: "2026-08-13T07:30:00.000Z",
        status: "DEGRADED",
        epoch: {
          schemaVersion: "positioncrew.production-monitor-epoch.v1",
          startedAt: "2026-08-13T04:00:00.000Z",
          baseUrl: "https://positioncrew.dolepee.com",
          workflow: {
            owner: "dolepee",
            repository: "positioncrew",
            file: "production-smoke.yml",
            url: "https://github.com/dolepee/positioncrew/actions/workflows/production-smoke.yml",
            snapshotUrl:
              "https://raw.githubusercontent.com/dolepee/positioncrew/production-monitor/evidence/production-track-record.json",
            event: "schedule",
            cadenceMinutes: 30,
          },
          verification: {
            expectedCheckCountAtEpoch: 57,
            scope: ["Providers and public receipts"],
          },
          aggregation: {
            coverage: "LATEST_100_SCHEDULED_RUNS",
            excludeEvents: ["push", "workflow_dispatch"],
          },
          boundary: "Production verification only.",
        },
        source: {
          provider: "GITHUB_ACTIONS_SNAPSHOT",
          snapshotUrl:
            "https://raw.githubusercontent.com/dolepee/positioncrew/production-monitor/evidence/production-track-record.json",
          workflowUrl: "https://github.com/dolepee/positioncrew/actions/workflows/production-smoke.yml",
          sourceStatus: "AVAILABLE",
        },
        summary: {
          totalScheduledRunsSinceEpoch: 2,
          observedRunCount: 2,
          completedRuns: 2,
          successfulRuns: 1,
          unsuccessfulRuns: 1,
          pendingRuns: 0,
          rollingPassRatePct: 50,
          rollingWindowStartedAt: "2026-08-13T05:47:00.000Z",
          rollingWindowEndedAt: "2026-08-13T06:17:00.000Z",
        },
        runs: [
          {
            runId: 102,
            status: "completed",
            conclusion: "failure",
            createdAt: "2026-08-13T06:17:00.000Z",
            completedAt: "2026-08-13T06:20:00.000Z",
            headSha: "2".repeat(40),
            url: "https://github.com/dolepee/positioncrew/actions/runs/102",
          },
          {
            runId: 101,
            status: "completed",
            conclusion: "success",
            createdAt: "2026-08-13T05:47:00.000Z",
            completedAt: "2026-08-13T05:50:00.000Z",
            headSha: "1".repeat(40),
            url: "https://github.com/dolepee/positioncrew/actions/runs/101",
          },
        ],
        boundary: "Not financial performance or Agent Advantage.",
      }),
    });
  });

  await page.goto("/#evidence");
  await expect(page.getByRole("heading", { name: "Production verification record" })).toBeVisible();
  await expect(page.getByText("1 unsuccessful", { exact: true })).toBeVisible();
  await expect(page.getByText("50%", { exact: true })).toBeVisible();
  await expect(page.getByText("failures remain visible", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: /Run #102/ })).toHaveAttribute(
    "href",
    "https://github.com/dolepee/positioncrew/actions/runs/102",
  );
  await expect(page.getByText("Non-cherry-picked operating evidence.", { exact: true })).toBeVisible();
});

test("the app has no page-level horizontal overflow", async ({ page }) => {
  for (const route of ["#marketplace", "#jobs", "#evidence"]) {
    await page.goto(`/${route}`);
    await expect(page.locator("main h1")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  }
});

test("providers expose machine-readable manifests and exact schemas", async ({ page, request }) => {
  await page.goto("/");
  const manifestLink = page.getByRole("link", { name: "Inspect provider manifest" });
  await expect(manifestLink).toHaveAttribute(
    "href",
    "/api/providers/lending-rescue/manifest",
  );

  const marketplaceResponse = await getWithTransportRetry(request, "/.well-known/positioncrew.json");
  expect(marketplaceResponse.ok()).toBeTruthy();
  const marketplace = await marketplaceResponse.json();
  expect(marketplace.providers).toHaveLength(4);
  expect(marketplace.claims.agentAdvantage).toBe("PENDING_INDEPENDENT_BLIND_EVALUATION");
  expect(marketplace.claims.judgeTrial).toBe("NO_WALLET_PROVIDER_CALL");
  expect(marketplace.operatingRecordUrl).toMatch(/\/api\/operations\/production$/);

  const providerResponse = await getWithTransportRetry(request, "/api/providers/lending-rescue/manifest");
  expect(providerResponse.ok()).toBeTruthy();
  const provider = await providerResponse.json();
  expect(provider.provider.service).toBe("LENDING_RESCUE");
  expect(provider.commerce.settlement).toBe("IN_MEMORY_CONFORMANCE");
  expect(provider.pricing.judgeTrial).toMatchObject({
    amount: "0",
    walletRequired: false,
    settlement: "NO_PAYMENT",
  });

  const schemaResponse = await getWithTransportRetry(
    request,
    "/api/schemas/positioncrew.lending-rescue.request.v1",
  );
  expect(schemaResponse.ok()).toBeTruthy();
  const schema = await schemaResponse.json();
  expect(schema.$id).toBe("positioncrew.lending-rescue.request.v1");
  expect(schema.required).toContain("targetHealthFactor");
});
