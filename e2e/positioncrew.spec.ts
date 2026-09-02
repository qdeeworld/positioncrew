import { runCurrentBlockPinnedProviderRequest } from "../src/api/fixture-jobs.js";
import { sha256Commitment } from "../src/commerce/fresh-hire-schema.js";
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

const externalComparisonSnapshot = JSON.parse(
  readFileSync(
    new URL("../evidence/external-comparison-candidates.mainnet.json", import.meta.url),
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
  const lpTokenId = "1456267";
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
  const lpRequest = liveLpRequest(now, lpTokenId, blockNumber);

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
  await page.route(`**/api/positions/pancake/${lpTokenId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "positioncrew.pancake-position-probe.v1",
        generatedAt: now.toISOString(),
        chainId: 56,
        state: "READY",
        position: {
          tokenId: lpTokenId,
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
          blockTimestamp: String(
            (lpRequest.sources as Array<Record<string, unknown>>)[0].observedAt,
          ),
          explorerUrl: `https://bscscan.com/block/${blockNumber}`,
          positionExplorerUrl: `https://bscscan.com/nft/0x46A15B0b27311cedF172AB29E4f4766fbE7F4364/${lpTokenId}`,
          poolExplorerUrl: "https://bscscan.com/address/0x36696169C63e42cd08ce11f5deeBbCeBae652050",
        },
        boundary: "Deterministic block-pinned PancakeSwap position browser fixture.",
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
          blockTimestamp: String(
            (gridRequest.sources as Array<Record<string, unknown>>)[0].observedAt,
          ),
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
          blockTimestamp: String(
            (yieldRequest.sources as Array<Record<string, unknown>>)[0].observedAt,
          ),
          measuredSecondsPerBlock: 3,
          explorerUrl: `https://bscscan.com/block/${blockNumber}`,
        },
        boundary: "Deterministic block-pinned Venus browser fixture.",
      }),
    });
  });

  return { now, blockNumber, gridRequest, yieldRequest, lpRequest, lpTokenId };
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
  noPosition = false,
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
          ? noPosition
            ? "No lending position was found at the pinned BSC block, so no rescue action is available."
            : "No allowed rescue action fits the wallet inventory and safety limits."
          : "A bounded debt repayment restores the requested health factor.",
        expiresAt,
        recommendation,
        alternatives: [],
        position: noPosition
          ? {
              collateralValueUsd: "0",
              debtValueUsd: "0",
              currentHealthFactor: null,
              stressedHealthFactor: null,
              targetHealthFactor: "1.25",
            }
          : {
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
  options: {
    abortCreate?: boolean;
    abortRun?: boolean;
    refused?: boolean;
    safeRefusal?: boolean;
    staleRunning?: boolean;
    getDelayMs?: number;
    failedMessage?: string;
  } = {},
) {
  const now = new Date();
  const account = options.safeRefusal
    ? "0x0000000000000000000000000000000000000000"
    : "0x1111111111111111111111111111111111111111";
  const blockNumber = "115607036";
  const hireId = "11111111-1111-4111-8111-111111111111";
  const receiptId = "33333333-3333-4333-8333-333333333333";
  const rescueRequest = liveLendingRequest(now, account, blockNumber);
  if (options.safeRefusal) {
    rescueRequest.position = { collateral: [], debt: [] };
    rescueRequest.availableAssets = [];
  } else if (options.refused) {
    rescueRequest.availableAssets = [];
  }
  const source = (rescueRequest.sources as Array<Record<string, unknown>>)[0];
  const observation = {
    blockNumber,
    observedAt: String(source.observedAt),
    explorerUrl: `https://bscscan.com/block/${blockNumber}`,
  };
  const response = await runCurrentBlockPinnedProviderRequest(rescueRequest, now);
  const responseHash = await sha256Commitment(response);
  const createBodies: Array<Record<string, unknown>> = [];
  let runCount = 0;
  let receiptLoadCount = 0;

  const chain = (state: "CREATED" | "RUNNING" | "COMPLETED" | "FAILED") => ({
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
      providerId: response.result.job.providerId ?? "positioncrew:provider:lending-rescue:v1",
      benchmarkSlug: "lending-rescue",
      service: "LENDING_RESCUE",
      evidenceMode: "CURRENT_BLOCK_PINNED",
      commerce: { directCostUsd: "0.00", walletRequired: false, settlement: "NO_PAYMENT" },
      request: rescueRequest,
      requestHash: response.result.evaluation.requestHash,
      evidence: {
        schemaVersion: "positioncrew.current-block-pinned-evidence.v1",
        evidenceClass: "CURRENT_BLOCK_PINNED",
        chainId: 56,
        source: observation,
        freshnessAtCreation: "FRESH",
        evaluatedAt: now.toISOString(),
        maxDataAgeSeconds: rescueRequest.maxDataAgeSeconds,
        externalLendingComparison: {
          schemaVersion: "positioncrew.external-lending-comparison-summary.v1",
          provider: {
            name: "AiKi Venus Health Factor Guardian",
            erc8004TokenId: "315943",
            endpoint: "https://www.useaiki.xyz/v1/reference/venus/agent/315943",
          },
          evaluatedAt: now.toISOString(),
          account,
          outcome: "SEMANTICALLY_COMPARABLE",
          attributableResult: true,
          completedSamePositionAssessment: true,
          persistedByProvider: true,
          externalHealthFactor: options.safeRefusal ? null : "1.0435",
          firstPartyHealthFactor: options.safeRefusal ? null : "1.04347826",
          healthFactorDifferenceBps: options.safeRefusal ? null : 0.208,
          externalRiskStatus: options.safeRefusal ? "NO_POSITION" : "AT_RISK",
          firstPartyDecision: options.safeRefusal ? "NONE" : "REPAY_DEBT",
          exactRequestAccepted: false,
          eligibleForRescueSelection: false,
          eligibleForLiveMatch: false,
          checks: [
            { code: "ACCOUNT", status: "PASS", detail: "Provider assessed the exact request account." },
            { code: "HEALTH_FACTOR_ALIGNMENT", status: options.safeRefusal ? "FAIL" : "PASS", detail: options.safeRefusal ? "No health factor exists for this empty account." : "Health factors differ by 0.208 bps." },
            { code: "RESCUE_OUTPUT_CONTRACT", status: "FAIL", detail: "Provider diagnoses risk but does not return a bounded rescue action." },
          ],
          boundary: "This proves a second health assessment, not provider selection, payment, rescue execution, or a transaction.",
        },
      },
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
      error: state === "FAILED" ? { code: "PROVIDER_TIMEOUT", message: options.failedMessage ?? "Provider run failed." } : null,
    },
    receipt: state === "COMPLETED" ? {
      receiptId,
      publicUrl: `/api/benchmark-receipts/${receiptId}`,
      responseHash,
      deliverableHash: response.result.job.deliverable?.deliverableHash ?? `sha256:${"b".repeat(64)}`,
      evaluationHash: response.result.evaluation.evaluationHash,
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
        state: options.safeRefusal ? "NO_POSITION" : "LIQUID",
        nativeBalanceBnb: options.safeRefusal ? "0" : "0.25",
        usdtBalance: options.safeRefusal ? "0" : "200",
        liquidityUsd: options.safeRefusal ? "0" : "40",
        shortfallUsd: "0",
        enteredMarkets: options.safeRefusal ? [] : [
          "0xA07c5b74C9B40447a954e1466938b865b6BBea36",
          "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
        ],
        position: options.safeRefusal ? {
          collateralValueUsd: "0",
          liquidationWeightedCollateralUsd: "0",
          debtValueUsd: "0",
          healthFactor: null,
          markets: [],
        } : {
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
        boundary: options.safeRefusal
          ? "This block-pinned Venus Classic account has no reconstructable collateral-and-debt pair. Its embedded request is preserved so the provider can return an explicit, receipted refusal."
          : "Block-pinned Venus Classic reconstruction.",
      }),
    });
  });
  await page.route(/\/api\/(?:benchmark-hires|provider-auditions\/lending\/hires)$/, async (route) => {
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
    if (options.getDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.getDelayMs));
    }
    const state = options.failedMessage
      ? "FAILED"
      : options.staleRunning && runCount === 0
        ? "RUNNING"
        : "COMPLETED";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(chain(state)) });
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
    responseHash,
    rescueRequest,
    observation,
    createBodies,
    get runCount() { return runCount; },
    get receiptLoadCount() { return receiptLoadCount; },
  };
}

test("a cold buyer can discover, hire, and inspect the lending provider", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page);
  let founderReportLoads = 0;
  await page.route("**/evidence/agent-advantage-founder/founder-agent-advantage-report.json", async (route) => {
    founderReportLoads += 1;
    await route.continue();
  });
  await page.goto("/#marketplace");
  expect(founderReportLoads).toBe(0);
  await expect(page.getByRole("heading", { name: "Bring the job. We prove who can handle it." })).toBeVisible();
  await expect(page.getByText("4/4", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: /Lending Rescue v1/ })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Open Lending Rescue directly" }).click();
  await expect(page.getByRole("heading", { name: "Get a bounded answer with evidence you can inspect." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Past benchmark receipts · not a current check" })).toHaveAttribute("href", "#evidence");
  await expect(page.getByText(/Hire remains disabled until the exact request and block evidence are ready/)).toBeVisible();
  await expect(page.getByLabel("Lending position health")).toHaveCount(0);
  await expect(page.getByLabel("Target health factor")).toHaveCount(0);
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  await expect(page.getByText("Current request loaded", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Lending position health")).toBeVisible();
  await expect(page.getByLabel("Target health factor")).toBeVisible();
  await expect(page.getByText(`Block-pinned Venus position from BSC block ${mockedHire.blockNumber}`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Check eligibility and hire" }).click();

  await expect(page.getByRole("heading", { name: "Repay 152 USDT" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Action required" })).toBeVisible();
  await expect(page.getByText("Crossed now", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Repay 152 USDT to target a projected/)).toBeVisible();
  const externalComparison = page.getByTestId("lending-external-provider-comparison");
  await expect(externalComparison.getByRole("heading", { name: "Health factor cross-checked" })).toBeVisible();
  await expect(externalComparison.getByText("AiKi Venus Health Factor Guardian", { exact: true })).toBeVisible();
  await expect(externalComparison).toContainText("1.0435 external · 1.04347826 PositionCrew");
  await expect(externalComparison).toContainText("Not eligible · PositionCrew decision REPAY DEBT");
  await expect(page.locator(".result-boundary")).toContainText(
    "Block-pinned Venus input. The provider output is unsigned and must be revalidated against current protocol state before execution.",
  );
  const recentJobs = page.getByTestId("recent-jobs-device");
  await expect(recentJobs.getByText("1 saved job", { exact: true })).toBeVisible();
  await expect(recentJobs.getByText("Action ready", { exact: true })).toBeVisible();
  await expect(recentJobs.getByText("Repay 152 USDT · Durable receipt ready", { exact: true })).toBeVisible();
  const advantageStatus = page.getByRole("region", { name: "Founder Agent Advantage comparison status" });
  await expect(advantageStatus.getByText("Founder comparison published", { exact: true })).toBeVisible();
  await expect(advantageStatus).toContainText("Bounded lending-position rescue: exact canonical output match");
  await expect(advantageStatus).toContainText("Agent D1 API371 ms");
  await expect(advantageStatus).toContainText("Manual wall clock356,626 ms");
  await expect(advantageStatus).toContainText("Direct cost$0 / $0");
  await expect(advantageStatus).toContainText("Quality was evaluated by exact canonical output parity; no separate numeric rating exists.");
  await expect(advantageStatus).not.toContainText("Quality score: not assigned");
  await expect(advantageStatus).not.toContainText("(null)");
  await expect(advantageStatus.getByRole("link", { name: "Open task receipt" })).toHaveAttribute(
    "href",
    "https://positioncrew.dolepee.com/api/benchmark-receipts/7f0234d4-bc81-43d4-9624-31823b334c33",
  );
  expect(founderReportLoads).toBe(1);
  await page.getByRole("tab", { name: "JSON" }).click();
  await expect(page.getByText("application/json", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Receipt", exact: true }).click();
  await expect(page.getByText("Score receipt", { exact: true })).toBeVisible();
  await expect(page.getByText("SESSION EMBEDDED", { exact: true })).toBeVisible();
  await expect(page.getByText("CURRENT BLOCK PINNED", { exact: true })).toBeVisible();
  await expect(page.getByText("43 ms", { exact: true })).toBeVisible();
  expect(mockedHire.createBodies).toHaveLength(1);
  expect(mockedHire.createBodies[0]).toMatchObject({
    schemaVersion: "positioncrew.lending-provider-audition-hire-request.v1",
    observation: mockedHire.observation,
  });
  expect(mockedHire.createBodies[0]).not.toHaveProperty("providerSlug");
  expect(mockedHire.createBodies[0].request).toEqual(mockedHire.rescueRequest);
  const [receiptPage] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("link", { name: "Reload durable receipt" }).click(),
  ]);
  await expect(receiptPage.locator("body")).toContainText(mockedHire.hireId);
  await receiptPage.reload();
  await expect(receiptPage.locator("body")).toContainText(mockedHire.responseHash);
  expect(mockedHire.receiptLoadCount).toBe(2);
});

test("a cold buyer can cause and reload a safe live lending refusal", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page, { safeRefusal: true });
  await page.goto("/#marketplace");

  await page.getByRole("button", { name: "Open Lending Rescue directly" }).click();
  await page.getByRole("button", { name: "See how safe refusal works" }).click();

  await expect(page.getByPlaceholder("0x account address")).toHaveValue(mockedHire.account);
  await expect(page.getByText("NO POSITION", { exact: true })).toBeVisible();
  await expect(page.getByText("Safe live refusal example", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Lending position health")).toHaveCount(0);
  await expect(page.getByLabel("Target health factor")).toHaveCount(0);
  await expect(page.getByText(`Safe live refusal example from BSC block ${mockedHire.blockNumber}`, { exact: false })).toBeVisible();
  const hireButton = page.getByRole("button", { name: "Check eligibility and persist refusal" });
  await expect(hireButton).toBeEnabled();
  await hireButton.click();

  const durableResult = page.locator(".job-result");
  await expect(durableResult.getByRole("heading", { name: "NONE", exact: true })).toBeVisible();
  await expect(durableResult.getByText("No complete Venus collateral-and-debt position was available for rescue analysis.", { exact: true })).toBeVisible();
  await expect(durableResult.getByText("Rescue threshold plan")).toHaveCount(0);
  expect(mockedHire.createBodies).toHaveLength(1);
  expect(mockedHire.createBodies[0]).toMatchObject({
    schemaVersion: "positioncrew.lending-provider-audition-hire-request.v1",
    observation: mockedHire.observation,
    request: {
      account: mockedHire.account,
      position: { collateral: [], debt: [] },
      availableAssets: [],
    },
  });

  const receiptLink = page.locator('.request-boundary[role="status"]').getByRole("link", { name: "Readable receipt" });
  await expect(receiptLink).toHaveAttribute("href", `#jobs/receipt/${mockedHire.receiptId}`);
  await receiptLink.click();
  await expect(page).toHaveURL(new RegExp(`#jobs/receipt/${mockedHire.receiptId}$`));
  await expect(page.locator(".job-result").getByRole("heading", { name: "NONE", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".job-result").getByText("No complete Venus collateral-and-debt position was available for rescue analysis.", { exact: true })).toBeVisible();
  const jsonLink = page.locator('.request-boundary[role="status"]').getByRole("link", { name: "Public receipt" });
  await expect(jsonLink).toHaveAttribute("href", `/api/benchmark-receipts/${mockedHire.receiptId}`);
  expect(mockedHire.receiptLoadCount).toBe(2);
});

test("a shared readable receipt can recover from a transient load failure", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page, { safeRefusal: true });
  await page.route(`**/api/benchmark-receipts/${mockedHire.receiptId}`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporary receipt outage" }),
    });
  }, { times: 1 });

  await page.goto(`/#jobs/receipt/${mockedHire.receiptId}`);
  const receiptAlert = page.getByRole("alert").filter({ hasText: "Readable receipt unavailable" });
  await expect(receiptAlert).toContainText("503 Service Unavailable");
  await receiptAlert.getByRole("button", { name: "Retry receipt" }).click();
  await expect(page.locator(".job-result").getByRole("heading", { name: "NONE", exact: true })).toBeVisible();
  await expect(receiptAlert).toHaveCount(0);
});

test("an operator can preflight a provider packet without external activation", async ({ page, request }) => {
  const templatesResponse = await request.get("/api/provider-contract-preflight");
  expect(templatesResponse.status()).toBe(200);
  const templates = await templatesResponse.json() as { templates: Record<string, unknown> };
  expect(Object.keys(templates.templates)).toEqual([
    "LENDING_RESCUE",
    "LP_REBALANCE",
    "YIELD_OPTIMIZATION",
    "BOUNDED_GRID",
  ]);
  const directPass = await request.post("/api/provider-contract-preflight", {
    data: templates.templates.LENDING_RESCUE,
  });
  expect(directPass.status()).toBe(200);
  expect((await directPass.json()).outcome).toBe("CONTRACT_PASS");

  await page.goto("/#marketplace");
  const region = page.getByRole("region", { name: "Check a provider packet against the contract." });
  await expect(region.getByRole("button", { name: "Check a provider packet" })).toBeVisible();
  await region.getByRole("button", { name: "Check a provider packet" }).click();
  const editor = region.getByLabel("Provider packet JSON");
  await expect(editor).toContainText("positioncrew.provider-contract-packet.v1");
  await region.getByRole("button", { name: "Run contract check" }).click();
  await expect(region.getByText("Packet conformance passed", { exact: true })).toBeVisible();
  await expect(region.getByText("Provider not verified; activation unavailable.", { exact: true })).toBeVisible();
  await expect(region.getByText("NOT_PROVEN", { exact: true })).toHaveCount(11);
  await expect(region).toContainText("does not prove ownership");
  await expect(region).not.toContainText("Certified");
  await expect(region).not.toContainText("Hireable");

  const tampered = JSON.parse(await editor.inputValue()) as { refusalDeliverable: { status: string } };
  tampered.refusalDeliverable.status = "NO_ACTION";
  await editor.fill(JSON.stringify(tampered, null, 2));
  await region.getByRole("button", { name: "Run contract check" }).click();
  await expect(region.getByText("Packet conformance failed", { exact: true })).toBeVisible();
  await expect(region).toContainText("Refusal example must use an explicit REFUSED_* status.");
  await expect(page.getByRole("button", { name: "Check my BSC capital" }).first()).toBeVisible();
});

test("serves and renders four evidence-only external comparison candidates", async ({ page, request }) => {
  const response = await getWithTransportRetry(request, "/api/evidence/external-comparisons/2026-08-24");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("immutable");
  expect(await response.json()).toEqual(externalComparisonSnapshot);
  const postResponse = await request.post("/api/evidence/external-comparisons/2026-08-24");
  expect(postResponse.status()).toBe(405);

  await page.goto("/#marketplace");
  const region = page.getByRole("region", { name: "External agents still have to prove the job." });
  await expect(region).toBeVisible();
  await expect(region.locator(".external-candidate-card")).toHaveCount(4);
  for (const name of ["Health Factor Monitor", "BNB LP Range Rebalancer", "BNB Yield Optimizer", "GridMaster Ops"]) {
    await expect(region.getByRole("heading", { name })).toBeVisible();
  }
  await expect(region.getByText("Service: Endpoint reachable", { exact: true })).toHaveCount(3);
  await expect(region.getByText("Service: Listed only", { exact: true })).toHaveCount(1);
  await expect(region.getByText("Quote required", { exact: true })).toHaveCount(2);
  await expect(region.getByText("Not published", { exact: true })).toHaveCount(1);
  await expect(region.getByText("Not verified", { exact: true })).toHaveCount(1);
  await expect(region.getByText("Unverified", { exact: true })).toHaveCount(4);
  await expect(region.locator('time[datetime="2026-08-24T00:49:52Z"]')).toHaveCount(1);
  await expect(region.getByRole("button")).toHaveCount(0);
  await expect(region).not.toContainText("$0");
  await expect(region.getByRole("link", { name: /Identity/ })).toHaveCount(4);
});

test("a current lending hire does not depend on historical fixtures or external comparisons", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page);
  await page.route("**/api/matrix", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Historical fixture matrix unavailable" }),
    });
  });
  await page.route("**/api/evidence/external-comparisons/2026-08-24", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "External comparison snapshot unavailable" }),
    });
  });

  await page.goto("/#jobs");
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  await expect(page.getByText("Current request loaded", { exact: true })).toBeVisible();
  const hireButton = page.getByRole("button", { name: "Check eligibility and hire" });
  await expect(hireButton).toBeEnabled();
  await hireButton.click();

  await expect(page.getByRole("heading", { name: "Repay 152 USDT" })).toBeVisible();
  await expect(page.locator('.request-boundary[role="status"]')).toContainText("COMPLETED");
  expect(mockedHire.createBodies).toHaveLength(1);
  expect(mockedHire.createBodies[0]).toMatchObject({
    schemaVersion: "positioncrew.lending-provider-audition-hire-request.v1",
  });
});

test("a lost hire response reuses the unresolved idempotency key", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page, { abortCreate: true });
  await page.goto("/#marketplace");
  await page.getByRole("button", { name: "Open Lending Rescue directly" }).click();
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  const hireButton = page.getByRole("button", { name: "Check eligibility and hire" });
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
  await page.getByRole("button", { name: "Open Lending Rescue directly" }).click();
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  const hireButton = page.getByRole("button", { name: "Check eligibility and hire" });
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
  await expect(page.getByRole("button", { name: "Check my BSC capital" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /LP Range Operator v1/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Yield Allocator v1/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Bounded Grid Builder v1/ })).toBeVisible();
  await expect(page.getByText("Connecting", { exact: true })).toHaveText("Connecting");
});

test("capital check turns current positions into truthful provider routes", async ({ page }) => {
  const live = await installDeterministicLiveProbeRoutes(page);
  await page.goto("/#marketplace");
  await page.locator(".capital-check-form input").first().fill("0x0000000000000000000000000000000000000001");
  await page.getByPlaceholder("Position token ID").fill(live.lpTokenId);
  await page.locator(".capital-check-form").getByRole("button", { name: "Check my BSC capital" }).click();

  await expect(page.getByText("Jobs found. Now choose who handles them.", { exact: true })).toBeVisible();
  await expect(page.getByText("PositionCrew Rescue + AiKi Venus Guardian", { exact: true })).toBeVisible();
  await expect(page.getByText("1 rescue provider · 1 monitoring cross-check", { exact: true })).toBeVisible();
  await expect(page.getByText("PositionCrew LP + V3 Pools powered by HeyAnon", { exact: true })).toBeVisible();
  await expect(page.getByText("PositionCrew Yield + AiKi Venus Yield", { exact: true })).toBeVisible();
  await expect(page.getByText("PositionCrew Grid + Brain on BNB Grid Planner", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compare providers for this job" })).toHaveCount(3);
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
  await page.getByRole("button", { name: "Check eligibility and hire" }).click();
  await expect(page.getByRole("heading", { name: "Repay 152 USDT" })).toBeVisible();
  await expect(page.getByText(/Block-pinned Venus input/)).toBeVisible();
  expect(mockedHire.createBodies[0].request).toEqual(mockedHire.rescueRequest);
});

test("a block-pinned Pancake market can become a bounded grid request", async ({ page }) => {
  const live = await installDeterministicLiveProbeRoutes(page);
  const mockedHire = await installCurrentCategoryHireRoutes(page, {
    service: "BOUNDED_GRID",
    benchmarkSlug: "bounded-grid",
    providerSlug: "bounded-grid",
    idDigit: "6",
  });
  await page.goto("/#jobs");
  await page.getByRole("combobox", { name: "Job" }).selectOption("BOUNDED_GRID");
  await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("PancakeSwap market probe", { exact: true })).toBeVisible();
  await expect(page.getByText(/Block-pinned PancakeSwap market from BSC block/)).toBeVisible();
  await page.getByRole("button", { name: "Hire and run current request" }).click();
  await expect(page.getByRole("heading", { name: /Build [45] bounded orders/ })).toBeVisible();
  await expect(page.getByText(/Block-pinned PancakeSwap input/)).toBeVisible();
  expect(mockedHire.createBodies).toHaveLength(1);
  expect(mockedHire.createBodies[0]).toMatchObject({
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
    benchmarkSlug: "bounded-grid",
    providerSlug: "bounded-grid",
    evidenceMode: "CURRENT_BLOCK_PINNED",
    observation: {
      blockNumber: live.blockNumber,
      observedAt: (live.gridRequest.sources as Array<Record<string, unknown>>)[0].observedAt,
      explorerUrl: `https://bscscan.com/block/${live.blockNumber}`,
    },
    request: live.gridRequest,
  });
  const receiptLink = page.locator('.request-boundary[role="status"]').getByRole("link", { name: "Public receipt" });
  await expect(receiptLink).toHaveAttribute("href", `/api/benchmark-receipts/${mockedHire.receiptId}`);
  const [receiptPage] = await Promise.all([page.waitForEvent("popup"), receiptLink.click()]);
  await expect(receiptPage.locator("body")).toContainText(mockedHire.receiptId);
  await receiptPage.reload();
  expect(mockedHire.receiptLoadCount).toBe(2);
});

test("a block-pinned Pancake position can become an LP rebalance request", async ({ page }) => {
  const live = await installDeterministicLiveProbeRoutes(page);
  const mockedHire = await installCurrentCategoryHireRoutes(page, {
    service: "LP_REBALANCE",
    benchmarkSlug: "lp-rebalance",
    providerSlug: "lp-rebalance",
    idDigit: "7",
  });
  await page.goto("/#jobs");
  await page.getByRole("combobox", { name: "Job" }).selectOption("LP_REBALANCE");
  await expect(page.getByRole("heading", { name: "PancakeSwap LP position" })).toBeVisible();
  await expect(page.getByLabel("PancakeSwap position NFT ID")).toHaveValue(live.lpTokenId);
  await page.getByRole("button", { name: "Inspect" }).click();
  await expect(page.getByText("OUT OF RANGE", { exact: true })).toBeVisible();
  await expect(page.getByText("$10,000", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use live position" }).click();
  await expect(page.getByText(`Block-pinned PancakeSwap position from BSC block ${live.blockNumber}`, { exact: false })).toBeVisible();
  await expect(page.getByLabel("Current tick")).toBeDisabled();
  await page.getByRole("button", { name: "Hire and run current request" }).click();
  await expect(page.getByRole("heading", { name: "SHIFT range to 0...240" })).toBeVisible();
  await expect(page.locator(".result-boundary")).toContainText("Block-pinned PancakeSwap position");
  expect(mockedHire.createBodies).toHaveLength(1);
  expect(mockedHire.createBodies[0]).toMatchObject({
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
    benchmarkSlug: "lp-rebalance",
    providerSlug: "lp-rebalance",
    evidenceMode: "CURRENT_BLOCK_PINNED",
    observation: {
      blockNumber: live.blockNumber,
      observedAt: (live.lpRequest.sources as Array<Record<string, unknown>>)[0].observedAt,
      explorerUrl: `https://bscscan.com/block/${live.blockNumber}`,
    },
    request: live.lpRequest,
  });
  const receiptLink = page.locator('.request-boundary[role="status"]').getByRole("link", { name: "Public receipt" });
  await expect(receiptLink).toHaveAttribute("href", `/api/benchmark-receipts/${mockedHire.receiptId}`);
});

test("block-pinned Venus stablecoin rates can become a yield request", async ({ page }) => {
  const live = await installDeterministicLiveProbeRoutes(page);
  const mockedHire = await installCurrentCategoryHireRoutes(page, {
    service: "YIELD_OPTIMIZATION",
    benchmarkSlug: "yield-optimization",
    providerSlug: "yield-optimization",
    idDigit: "8",
  });
  await page.goto("/#jobs");
  await page.getByRole("combobox", { name: "Job" }).selectOption("YIELD_OPTIMIZATION");
  await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Venus stablecoin probe", { exact: true })).toBeVisible();
  await expect(page.getByText(/Block-pinned Venus yield market from BSC block/)).toBeVisible();
  await expect(page.getByLabel("Leading base APY (bps)")).toBeDisabled();
  await page.getByRole("button", { name: "Hire and run current request" }).click();
  await expect(page.getByRole("heading", { name: /to beefy-usdt-vault/ })).toBeVisible();
  await expect(page.getByText(/Block-pinned Venus yield input/)).toBeVisible();
  expect(mockedHire.createBodies).toHaveLength(1);
  expect(mockedHire.createBodies[0]).toMatchObject({
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
    benchmarkSlug: "yield-optimization",
    providerSlug: "yield-optimization",
    evidenceMode: "CURRENT_BLOCK_PINNED",
    observation: {
      blockNumber: live.blockNumber,
      observedAt: (live.yieldRequest.sources as Array<Record<string, unknown>>)[0].observedAt,
      explorerUrl: `https://bscscan.com/block/${live.blockNumber}`,
    },
    request: live.yieldRequest,
  });
  const receiptLink = page.locator('.request-boundary[role="status"]').getByRole("link", { name: "Public receipt" });
  await expect(receiptLink).toHaveAttribute("href", `/api/benchmark-receipts/${mockedHire.receiptId}`);
});

test("all three non-lending current hires return category-specific durable results", async ({ page }) => {
  const live = await installDeterministicLiveProbeRoutes(page);
  const hires = [
    await installCurrentCategoryHireRoutes(page, { service: "LP_REBALANCE", benchmarkSlug: "lp-rebalance", providerSlug: "lp-rebalance", idDigit: "7" }),
    await installCurrentCategoryHireRoutes(page, { service: "YIELD_OPTIMIZATION", benchmarkSlug: "yield-optimization", providerSlug: "yield-optimization", idDigit: "8" }),
    await installCurrentCategoryHireRoutes(page, { service: "BOUNDED_GRID", benchmarkSlug: "bounded-grid", providerSlug: "bounded-grid", idDigit: "6" }),
  ];
  await page.goto("/#jobs");
  const provider = page.getByRole("combobox", { name: "Job" });
  await expect(provider).toBeVisible();
  const cases = [
    { value: "LP_REBALANCE", output: "SHIFT range to 0...240" },
    { value: "YIELD_OPTIMIZATION", output: /to beefy-usdt-vault/ },
    { value: "BOUNDED_GRID", output: /Build [45] bounded orders/ },
  ];
  for (const candidate of cases) {
    await provider.selectOption(candidate.value);
    if (candidate.value === "LP_REBALANCE") {
      await expect(page.getByLabel("PancakeSwap position NFT ID")).toHaveValue(live.lpTokenId);
      await page.getByRole("button", { name: "Inspect" }).click();
      await page.getByRole("button", { name: "Use live position" }).click();
    } else {
      await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 20_000 });
    }
    await page.getByRole("button", { name: "Hire and run current request" }).click();
    await expect(page.getByRole("heading", { name: candidate.output })).toBeVisible();
    await expect(page.locator('.request-boundary[role="status"]').getByRole("link", { name: "Public receipt" })).toBeVisible();
    if (candidate.value === "LP_REBALANCE") {
      const comparison = page.getByTestId("lp-external-provider-comparison");
      await expect(comparison.getByRole("heading", { name: "Two live providers evaluated" })).toBeVisible();
      await expect(comparison.getByText("V3 Pools powered by HeyAnon", { exact: true })).toBeVisible();
      await expect(comparison.getByText("HOLD externally · HOLD by PositionCrew", { exact: true })).toBeVisible();
      await expect(comparison).toContainText("Compatible through adapter");
      await expect(comparison).toContainText("PositionCrew selected");
    }
    if (candidate.value === "BOUNDED_GRID") {
      const comparison = page.getByTestId("grid-external-provider-comparison");
      await expect(comparison.getByRole("heading", { name: "Live range cross-checked" })).toBeVisible();
      await expect(comparison.getByText("AiKi PancakeSwap Grid Trader", { exact: true })).toBeVisible();
      await expect(comparison).toContainText("IN_GRID / WAIT externally · BUILD GRID by PositionCrew");
      await expect(comparison).toContainText("Cross-check only · not eligible");
    }
    if (candidate.value === "YIELD_OPTIMIZATION") {
      const comparison = page.getByTestId("yield-external-provider-comparison");
      await expect(comparison.getByRole("heading", { name: "Rate leader cross-checked" })).toBeVisible();
      await expect(comparison.getByText("AiKi Venus Yield Optimiser", { exact: true })).toBeVisible();
      await expect(comparison).toContainText("263 bps external · 267 bps PositionCrew");
      await expect(comparison).toContainText("Cross-check only · not eligible");
    }
  }
  await expect(page.getByTestId("recent-jobs-device").getByText("3 saved jobs", { exact: true })).toBeVisible();
  expect(hires.every((hire) => hire.createBodies.length === 1)).toBe(true);
});

test("a current lending refusal persists and remains inspectable", async ({ page }) => {
  const mockedHire = await installCurrentLendingHireRoutes(page, { refused: true });
  await page.goto("/#jobs");
  await page.getByPlaceholder("0x account address").fill(mockedHire.account);
  await page.getByRole("button", { name: "Load position" }).click();
  await page.getByRole("button", { name: "Check eligibility and hire" }).click();
  const durableResult = page.locator(".job-result");
  await expect(durableResult.getByRole("heading", { name: "NONE", exact: true })).toBeVisible();
  await expect(durableResult.getByText("No allowed rescue action fits the wallet inventory and safety limits.", { exact: true })).toBeVisible();
  const durableStatus = page.locator('.request-boundary[role="status"]');
  await expect(durableStatus.getByRole("link", { name: "Public receipt" })).toHaveAttribute(
    "href",
    `/api/benchmark-receipts/${mockedHire.receiptId}`,
  );
});

test("every non-lending provider accepts custom bounds and fails closed", async ({ page }) => {
  const live = await installDeterministicLiveProbeRoutes(page);
  await installCurrentCategoryHireRoutes(page, { service: "LP_REBALANCE", benchmarkSlug: "lp-rebalance", providerSlug: "lp-rebalance", idDigit: "7" });
  await installCurrentCategoryHireRoutes(page, { service: "YIELD_OPTIMIZATION", benchmarkSlug: "yield-optimization", providerSlug: "yield-optimization", idDigit: "8" });
  await installCurrentCategoryHireRoutes(page, { service: "BOUNDED_GRID", benchmarkSlug: "bounded-grid", providerSlug: "bounded-grid", idDigit: "6" });
  await page.goto("/#jobs");
  const provider = page.getByRole("combobox", { name: "Job" });
  const cases = [
    {
      service: "LP_REBALANCE",
      field: "Minimum net benefit (USD)",
      value: "1000",
      decision: "HOLD",
    },
    {
      service: "YIELD_OPTIMIZATION",
      field: "Minimum net benefit (USD)",
      value: "1000",
      decision: "HOLD",
    },
    {
      service: "BOUNDED_GRID",
      field: "Maximum loss (USD)",
      value: "1",
      decision: "NO GRID",
    },
  ];

  for (const candidate of cases) {
    await provider.selectOption(candidate.service);
    if (candidate.service === "LP_REBALANCE") {
      await expect(page.getByLabel("PancakeSwap position NFT ID")).toHaveValue(live.lpTokenId);
      await page.getByRole("button", { name: "Inspect" }).click();
      await page.getByRole("button", { name: "Use live position" }).click();
    }
    if (candidate.service === "BOUNDED_GRID" || candidate.service === "YIELD_OPTIMIZATION") {
      await expect(page.getByText("READY", { exact: true })).toBeVisible({ timeout: 20_000 });
    }
    await page.getByLabel(candidate.field).fill(candidate.value);
    await expect(page.getByText(
      /The exact submitted request and pinned observation are persisted/,
    )).toBeVisible();
    await page.getByRole("button", { name: "Hire and run current request" }).click();
    await expect(page.getByRole("heading", { name: candidate.decision })).toBeVisible();
    await expect(page.locator('.request-boundary[role="status"]').getByRole("link", { name: "Public receipt" })).toBeVisible();
    await page.getByTitle("Reset interactive bounds").click();
    await expect(page.getByText(
      /The exact submitted request and pinned observation are persisted/,
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
  await expect(page.getByRole("heading", { name: "Historical receipts and proof" })).toBeVisible();
  const comparisonSection = page.getByRole("region", { name: "Agent Advantage evidence" });
  await expect(comparisonSection.getByText("Founder comparison published", { exact: true })).toBeVisible();
  const taskComparisons = comparisonSection.getByRole("list", { name: "Founder Agent Advantage task comparisons" });
  await expect(taskComparisons.getByRole("listitem")).toHaveCount(3);
  await expect(taskComparisons).toContainText("Bounded lending-position rescue");
  await expect(taskComparisons).toContainText("371 ms");
  await expect(taskComparisons).toContainText("356,626 ms");
  await expect(taskComparisons).toContainText("Bounded concentrated-liquidity rebalance");
  await expect(taskComparisons).toContainText("381 ms");
  await expect(taskComparisons).toContainText("94,612 ms");
  await expect(taskComparisons).toContainText("Bounded BNB-USDT grid construction");
  await expect(taskComparisons).toContainText("359 ms");
  await expect(taskComparisons).toContainText("28,834 ms");
  await expect(taskComparisons.getByText("$0 / $0", { exact: true })).toHaveCount(3);
  await expect(taskComparisons.getByText(/Quality was evaluated by exact canonical output parity/)).toHaveCount(3);
  await expect(comparisonSection).toContainText("Independent/blind extension: in progress.");
  await expect(page.getByText("4/4", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("3/3", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("6", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("source-committed agent runs", { exact: true })).toBeVisible();
  await expect(page.getByText(/source 3b28703/).first()).toBeVisible();
  await expect(page.getByText("No independent/blind result is claimed.", { exact: true })).toBeVisible();
  const founderComparison = page.locator(".claim-warning.published").filter({
    hasText: "Founder-operated comparison published.",
  });
  await expect(founderComparison).toContainText(
    "Quality evidence here is exact canonical output parity, not a numeric rating. No separate numeric quality score was assigned.",
  );
  await expect(founderComparison).not.toContainText("Quality score: not assigned");
  await expect(founderComparison).not.toContainText("(null)");
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

test("body-tampered founder task details fail closed even when declared commitments remain unchanged", async ({ page }) => {
  await page.route("**/evidence/agent-advantage-founder/founder-agent-advantage-report.json", async (route) => {
    const response = await route.fetch();
    const report = await response.json() as {
      tasks: Array<{
        agent: { officialElapsedMilliseconds: number };
        marketplace: { apiDurationMilliseconds: number };
      }>;
    };
    report.tasks[0].agent.officialElapsedMilliseconds += 1;
    report.tasks[0].marketplace.apiDurationMilliseconds += 1;
    await route.fulfill({
      response,
      body: JSON.stringify(report),
    });
  });
  await page.goto("/#evidence");
  await expect(page.getByRole("status", { name: "Founder comparison task details unavailable" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Founder Agent Advantage task comparisons" })).toHaveCount(0);
  await expect(page.getByText("356,626 ms", { exact: true })).toHaveCount(0);
  await expect(page.getByText("371 ms", { exact: true })).toHaveCount(0);
});

test("a refreshed founder publication cache is bound to both commitments", async ({ page }) => {
  let providerRequestCount = 0;
  let founderStatusRequestCount = 0;
  let founderReportRequestCount = 0;
  await page.route(/\/api\/providers$/u, async (route) => {
    providerRequestCount += 1;
    if (providerRequestCount === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "retry fixture" }) });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/benchmarks/founder-comparison/status", async (route) => {
    const response = await route.fetch();
    const publication = await response.json() as Record<string, unknown>;
    founderStatusRequestCount += 1;
    if (founderStatusRequestCount > 1) {
      publication.evidenceManifestHash = `sha256:${"f".repeat(64)}`;
    }
    await route.fulfill({ response, body: JSON.stringify(publication) });
  });
  await page.route("**/evidence/agent-advantage-founder/founder-agent-advantage-report.json", async (route) => {
    founderReportRequestCount += 1;
    await route.continue();
  });

  await page.goto("/#evidence");
  const comparisonSection = page.getByRole("region", { name: "Agent Advantage evidence" });
  await expect(comparisonSection.getByRole("list", { name: "Founder Agent Advantage task comparisons" }).getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("status", { name: "Founder comparison task details unavailable" })).toBeVisible();
  await expect(comparisonSection.getByRole("list", { name: "Founder Agent Advantage task comparisons" })).toHaveCount(0);
  await expect(page.getByText("356,626 ms", { exact: true })).toHaveCount(0);
  expect(founderStatusRequestCount).toBe(2);
  expect(founderReportRequestCount).toBe(2);
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
  await expect(page.getByText(/Independent\/blind extension: published\./)).toBeVisible();
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
  await page.getByRole("button", { name: "Check eligibility and hire" }).click();
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

test("Agent Advantage task rows do not clip at laptop width", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto("/#evidence");
  const firstTask = page
    .getByRole("list", { name: "Founder Agent Advantage task comparisons" })
    .getByRole("listitem")
    .first();
  await expect(firstTask.getByRole("link", { name: "Open D1 receipt" })).toBeVisible();
  const clipping = await firstTask.evaluate((task) => {
    const taskBounds = task.getBoundingClientRect();
    return {
      hasHorizontalOverflow: task.scrollWidth > task.clientWidth,
      childOutsideBounds: [...task.children].some((child) => {
        const childBounds = child.getBoundingClientRect();
        return childBounds.left < taskBounds.left - 0.5 || childBounds.right > taskBounds.right + 0.5;
      }),
    };
  });
  expect(clipping).toEqual({ hasHorizontalOverflow: false, childOutsideBounds: false });
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

async function installCurrentCategoryHireRoutes(
  page: Page,
  definition: {
    service: "BOUNDED_GRID" | "LP_REBALANCE" | "YIELD_OPTIMIZATION";
    benchmarkSlug: "bounded-grid" | "lp-rebalance" | "yield-optimization";
    providerSlug: "bounded-grid" | "lp-rebalance" | "yield-optimization";
    idDigit: "6" | "7" | "8";
  },
) {
  const now = new Date();
  const hireId = `${definition.idDigit.repeat(8)}-${definition.idDigit.repeat(4)}-4${definition.idDigit.repeat(3)}-8${definition.idDigit.repeat(3)}-${definition.idDigit.repeat(12)}`;
  const jobId = `${definition.idDigit.repeat(8)}-${definition.idDigit.repeat(4)}-4${definition.idDigit.repeat(3)}-9${definition.idDigit.repeat(3)}-${definition.idDigit.repeat(12)}`;
  const receiptId = `${definition.idDigit.repeat(8)}-${definition.idDigit.repeat(4)}-4${definition.idDigit.repeat(3)}-a${definition.idDigit.repeat(3)}-${definition.idDigit.repeat(12)}`;
  const createBodies: Array<Record<string, unknown>> = [];
  let providerResponse: Awaited<ReturnType<typeof runCurrentBlockPinnedProviderRequest>> | null = null;
  let providerResponseHash: string | null = null;
  let receiptLoadCount = 0;

  const chain = (state: "CREATED" | "RUNNING" | "COMPLETED") => {
    const body = createBodies.at(-1)!;
    const observation = body.observation as Record<string, unknown>;
    const request = body.request as Record<string, unknown>;
    return {
      schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
      claimBoundary: [
        "This run evaluates the exact current block-pinned observation persisted when the public hire was created.",
        "The run costs $0.00, requires no wallet, and creates no payment, settlement, custody, or protocol transaction.",
        "The server receipt commits to the request, provider binding, evidence, bounded result, evaluation, and timing trace.",
        "The observation is caller-supplied from PositionCrew telemetry and must be revalidated before any financial action.",
      ],
      hire: {
        hireId,
        idempotencyKey: body.idempotencyKey,
        providerSlug: definition.providerSlug,
        providerId: providerResponse?.result.job.providerId ?? `positioncrew:provider:${definition.providerSlug}:v1`,
        benchmarkSlug: definition.benchmarkSlug,
        service: definition.service,
        evidenceMode: "CURRENT_BLOCK_PINNED",
        commerce: { directCostUsd: "0.00", walletRequired: false, settlement: "NO_PAYMENT" },
        request,
        requestHash: providerResponse?.result.evaluation.requestHash ?? `sha256:${"c".repeat(64)}`,
        evidence: {
          schemaVersion: "positioncrew.current-block-pinned-evidence.v1",
          evidenceClass: "CURRENT_BLOCK_PINNED",
          chainId: 56,
          source: observation,
          freshnessAtCreation: "FRESH",
          evaluatedAt: now.toISOString(),
          maxDataAgeSeconds: request.maxDataAgeSeconds,
          ...(definition.service === "LP_REBALANCE" ? {
            externalProviderComparison: {
              schemaVersion: "positioncrew.external-lp-comparison-summary.v1",
              provider: {
                name: "V3 Pools powered by HeyAnon",
                erc8004TokenId: "45650",
                endpoint: "https://erc8004.heyanon.ai/mcp/v3pools",
              },
              evaluatedAt: now.toISOString(),
              positionTokenId: "7284554",
              outcome: "SEMANTICALLY_COMPARABLE",
              attributableResult: true,
              completedSamePositionAssessment: true,
              persistedByProvider: false,
              externalDecision: "HOLD",
              firstPartyDecision: "HOLD",
              exactRequestAccepted: false,
              eligibleForPositionAssessmentActivation: true,
              eligibleForLiveMatch: true,
              adapterNormalized: true,
              externalRange: { lowerTick: -65840, upperTick: -64830, widthTicks: 1010 },
              selection: {
                selectedProvider: "POSITIONCREW",
                externalEligible: true,
                basis: "The first-party provider won the native exact-contract tiebreak.",
              },
              checks: [
                { code: "EXACT_POSITION_STATE", status: "PASS", detail: "Ticks and raw liquidity exactly match the request." },
                { code: "DECISION_ALIGNMENT", status: "PASS", detail: "Both providers return HOLD." },
                { code: "EXACT_REQUEST_ACCEPTANCE", status: "FAIL", detail: "Provider accepts the position NFT, not every PositionCrew constraint." },
              ],
              boundary: "The external range was normalized and evaluated without payment or execution.",
            },
          } : {}),
          ...(definition.service === "BOUNDED_GRID" ? {
            externalGridComparison: {
              schemaVersion: "positioncrew.external-grid-comparison-summary.v1",
              provider: {
                name: "AiKi PancakeSwap Grid Trader",
                erc8004TokenId: "315945",
                endpoint: "https://www.useaiki.xyz/v1/reference/pancake/grid/agent/315945",
              },
              evaluatedAt: now.toISOString(),
              pool: String(request.venue),
              outcome: "PARTIAL_COMPATIBILITY",
              positionCrewDecision: "BUILD_GRID",
              externalRecommendation: "WAIT",
              externalState: "IN_GRID",
              tickLower: -65647,
              tickUpper: -65248,
              exactRangeAccepted: true,
              attributable: true,
              persisted: true,
              exactRequestAccepted: false,
              eligibleForGridSelection: false,
              eligibleForLiveMatch: false,
              checks: [
                { code: "EXACT_POOL", status: "PASS", detail: "AiKi evaluated the exact PancakeSwap V3 pool." },
                { code: "EXACT_RANGE", status: "PASS", detail: "AiKi accepted the exact PositionCrew-derived tick range." },
                { code: "EXACT_JOB_CONTRACT", status: "FAIL", detail: "AiKi does not construct PositionCrew bounded orders." },
              ],
              boundary: "AiKi assessed the live pool and range but did not accept the bounded order and loss contract.",
            },
          } : {}),
          ...(definition.service === "YIELD_OPTIMIZATION" ? {
            externalYieldComparison: {
              schemaVersion: "positioncrew.external-yield-comparison-summary.v1",
              provider: {
                name: "AiKi Venus Yield Optimiser",
                erc8004TokenId: "315946",
                endpoint: "https://www.useaiki.xyz/v1/reference/yield/agent/315946",
              },
              evaluatedAt: now.toISOString(),
              outcome: "PARTIAL_COMPATIBILITY",
              marketCount: Array.isArray(request.opportunities) ? request.opportunities.length : 0,
              positionCrewSelectedMarket: "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
              externalRecommendedMarket: "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
              sameRateLeader: true,
              positionCrewGrossApyBps: 267,
              externalSimpleAnnualRateBps: 263,
              rateDifferenceBps: 4,
              attributable: true,
              persisted: true,
              exactRequestAccepted: false,
              eligibleForYieldSelection: false,
              eligibleForLiveMatch: false,
              checks: [
                { code: "EXACT_MARKET_SET", status: "PASS", detail: "AiKi evaluated the same frozen Venus market set." },
                { code: "SAME_RATE_LEADER", status: "PASS", detail: "Both providers identified the same highest-rate market." },
                { code: "EXACT_JOB_CONTRACT", status: "FAIL", detail: "AiKi does not accept the full PositionCrew optimisation contract." },
              ],
              boundary: "AiKi ranked rates but did not evaluate PositionCrew liquidity, risk, costs, or horizon constraints.",
            },
          } : {}),
        },
        evidenceHash: `sha256:${"d".repeat(64)}`,
        providerHash: `sha256:${"f".repeat(64)}`,
        createdAt: now.toISOString(),
      },
      job: {
        jobId,
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
        responseHash: providerResponseHash ?? `sha256:${"9".repeat(64)}`,
        deliverableHash: providerResponse?.result.job.deliverable?.deliverableHash ?? `sha256:${"b".repeat(64)}`,
        evaluationHash: providerResponse?.result.evaluation.evaluationHash ?? `sha256:${"e".repeat(64)}`,
        createdAt: now.toISOString(),
        response: providerResponse,
      } : null,
    };
  };

  await page.route(/\/api\/benchmark-hires$/, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if ((body.request as Record<string, unknown>)?.service !== definition.service) {
      await route.fallback();
      return;
    }
    createBodies.push(body);
    providerResponse = await runCurrentBlockPinnedProviderRequest(body.request, now);
    providerResponseHash = await sha256Commitment(providerResponse);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(chain("CREATED")),
    });
  });
  await page.route(new RegExp(`/api/benchmark-hires/${hireId}/jobs$`), async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify(chain("RUNNING")),
    });
  });
  await page.route(new RegExp(`/api/benchmark-hires/${hireId}$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(chain("COMPLETED")),
    });
  });
  await page.context().route(`**/api/benchmark-receipts/${receiptId}`, async (route) => {
    receiptLoadCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(chain("COMPLETED")),
    });
  });

  return {
    hireId,
    receiptId,
    createBodies,
    get receiptLoadCount() { return receiptLoadCount; },
  };
}

test("restores a server-backed recent job on the same device without caching its financial payload", async ({ page }) => {
  const routes = await installCurrentLendingHireRoutes(page, { safeRefusal: true });
  await page.addInitScript(({ hireId }) => {
    window.localStorage.setItem("positioncrew.recent-jobs.v1", JSON.stringify({
      schemaVersion: "positioncrew.recent-jobs.v1",
      entries: [{
        hireId,
        service: "LENDING_RESCUE",
        rememberedAt: "2026-08-24T12:00:00.000Z",
      }],
    }));
  }, { hireId: routes.hireId });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#jobs");

  const panel = page.getByTestId("recent-jobs-device");
  await expect(panel.getByRole("heading", { name: "Recent jobs on this device" })).toBeVisible();
  await expect(panel.getByText("Refused", { exact: true })).toBeVisible();
  await expect(panel.getByText("NONE · Durable receipt ready", { exact: true })).toBeVisible();
  await expect(panel.getByText("This browser stores job references only.", { exact: false })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open result" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Open receipt" })).toHaveAttribute("href", `#jobs/receipt/${routes.receiptId}`);

  const serialized = await page.evaluate(() => window.localStorage.getItem("positioncrew.recent-jobs.v1") ?? "");
  expect(serialized).not.toMatch(/request|response|account|collateral|wallet/i);
  expect(serialized).toContain(routes.hireId);

  await page.reload();
  await expect(panel.getByText("Refused", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Open result" }).click();
  await expect(page).toHaveURL(/#jobs/);

  await panel.getByRole("button", { name: "Clear device list" }).click();
  await expect(panel.getByText("No saved jobs on this device.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("positioncrew.recent-jobs.v1"))).toBeNull();
});

test("reclaims a stale running job through the existing hire instead of creating a replacement", async ({ page }) => {
  const routes = await installCurrentLendingHireRoutes(page, { safeRefusal: true, staleRunning: true });
  await page.addInitScript(({ hireId }) => {
    window.localStorage.setItem("positioncrew.recent-jobs.v1", JSON.stringify({
      schemaVersion: "positioncrew.recent-jobs.v1",
      entries: [{ hireId, service: "LENDING_RESCUE", rememberedAt: "2026-08-24T12:00:00.000Z" }],
    }));
  }, { hireId: routes.hireId });

  await page.goto("/#jobs");
  const panel = page.getByTestId("recent-jobs-device");
  await expect(panel.getByText("Running", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Recover run" }).click();
  await expect(panel.getByText("Refused", { exact: true })).toBeVisible();
  expect(routes.runCount).toBe(1);
});

test("does not reinsert a device reference cleared while server hydration is in flight", async ({ page }) => {
  const routes = await installCurrentLendingHireRoutes(page, { safeRefusal: true, getDelayMs: 300 });
  await page.addInitScript(({ hireId }) => {
    window.localStorage.setItem("positioncrew.recent-jobs.v1", JSON.stringify({
      schemaVersion: "positioncrew.recent-jobs.v1",
      entries: [{ hireId, service: "LENDING_RESCUE", rememberedAt: "2026-08-24T12:00:00.000Z" }],
    }));
  }, { hireId: routes.hireId });

  await page.goto("/#jobs");
  const panel = page.getByTestId("recent-jobs-device");
  await expect(panel.getByText("Checking", { exact: true })).toBeVisible();
  await page.evaluate((key) => {
    window.localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: null }));
  }, "positioncrew.recent-jobs.v1");
  await expect(panel.getByText("No saved jobs on this device.", { exact: false })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(panel.getByText("Lending Rescue", { exact: true })).toHaveCount(0);
});

test("shows the server diagnostic for a restored failed job", async ({ page }) => {
  const routes = await installCurrentLendingHireRoutes(page, {
    safeRefusal: true,
    failedMessage: "The provider timed out before returning a result.",
  });
  await page.addInitScript(({ hireId }) => {
    window.localStorage.setItem("positioncrew.recent-jobs.v1", JSON.stringify({
      schemaVersion: "positioncrew.recent-jobs.v1",
      entries: [{ hireId, service: "LENDING_RESCUE", rememberedAt: "2026-08-24T12:00:00.000Z" }],
    }));
  }, { hireId: routes.hireId });

  await page.goto("/#jobs");
  const panel = page.getByTestId("recent-jobs-device");
  await expect(panel.getByText("Failed", { exact: true })).toBeVisible();
  await expect(panel.getByText("Run failed: The provider timed out before returning a result.", { exact: true })).toBeVisible();
  await expect(panel).not.toContainText("[object Object]");
});
