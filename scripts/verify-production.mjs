import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import {
  createPublicClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToHex,
} from "viem";

const baseUrl = new URL(
  process.env.POSITIONCREW_BASE_URL ?? "https://positioncrew.dolepee.com",
);
const outputPath = resolve(
  process.env.POSITIONCREW_HEALTH_OUTPUT ?? "/tmp/positioncrew-production-health.json",
);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedServices = new Set([
  "LENDING_RESCUE",
  "LP_REBALANCE",
  "YIELD_OPTIMIZATION",
  "BOUNDED_GRID",
]);
const expectedAacpAgentTokenIds = new Set(["266229", "266231", "266232", "266234"]);
const expectedAacpListings = new Map([
  ["266229", "cmsrfz5ze0t4otn01pm8bdane"],
  ["266231", "cmsrg0fq00td7tn01awonk3td"],
  ["266232", "cmsrg1lr20tkytn01gs2ynens"],
  ["266234", "cmsrg2czh0tohtn01ng23b34c"],
]);
const expectedAacpOwner = "0xbad35fa6e368e90fc4faf63507f2d0a2fdf94baf";
const referencePancakePositionId = "1456267";
const expectedShadowGridClaimBoundary = [
  "Forward-only, zero-fund shadow outcomes use only actual block-pinned PancakeSwap WBNB/USDT observations recorded after precommitment.",
  "Conservative sampled crossings are simulations, not transactions, executable fills, realised PnL, strategy returns, or audited financial performance.",
  "The operator-scheduled record proves no external buyer, payment, revenue, demand, or Agent Advantage.",
];
const expectedShadowGridStrategyVersion =
  "positioncrew:bounded-grid-forward-shadow:v1";
const expectedShadowGridFillModel = "CONSERVATIVE_SAMPLED_CROSSING_V1";
const shadowGridEventTypes = new Set([
  "EPOCH_STARTED",
  "PRECOMMITTED",
  "REFUSED",
  "OBSERVED",
  "SHADOW_FILL",
  "CLOSED",
  "VOID_SOURCE_GAP",
  "RISK_EXIT",
]);
const shadowGridTerminalEventTypes = new Set([
  "REFUSED",
  "CLOSED",
  "VOID_SOURCE_GAP",
  "RISK_EXIT",
]);
const checks = [];
const monitorRunId = String(Date.now());
const monitorRequestTimeoutMs = 15_000;
const bscTestnetRpc =
  process.env.BSC_TESTNET_RPC_URL ?? "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
const bscTestnet = defineChain({
  id: 97,
  name: "BSC Testnet",
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: { default: { http: [bscTestnetRpc] } },
});
const identityClient = createPublicClient({ chain: bscTestnet, transport: http() });
const identityAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);
const erc8183CommerceAbi = parseAbi([
  "function getJob(uint256 jobId) view returns ((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook,uint256 submittedAt,bytes32 deliverable))",
  "function paymentToken() view returns (address)",
  "function platformFeeBP() view returns (uint256)",
]);
const erc8183RouterAbi = parseAbi([
  "function policyWhitelist(address policy) view returns (bool)",
  "event JobRegistered(uint256 indexed jobId,address indexed policy,address indexed client)",
]);
const erc8183PolicyAbi = parseAbi([
  "function disputeWindow() view returns (uint256)",
  "function voteQuorum() view returns (uint256)",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function localUrl(input) {
  const url = new URL(input, baseUrl);
  assert(url.origin === baseUrl.origin, `Refusing cross-origin discovery URL: ${url}`);
  return url;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function canonicalSha256(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function freshHireCanonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(freshHireCanonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${freshHireCanonicalJson(child)}`)
    .join(",")}}`;
}

function freshHireCanonicalSha256(value) {
  return `sha256:${createHash("sha256").update(freshHireCanonicalJson(value)).digest("hex")}`;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isTransientBscRpcExhaustion(response, body) {
  if (
    response.status !== 500 ||
    body?.schemaVersion !== "positioncrew.api-error.v1" ||
    body.error !== "REQUEST_FAILED" ||
    !Array.isArray(body.details) ||
    body.details.length !== 1 ||
    typeof body.details[0] !== "string"
  ) {
    return false;
  }

  const detail = body.details[0];
  const providers = [
    "bsc-rpc.publicnode.com",
    "bsc-dataseed-public.bnbchain.org",
    "bsc-dataseed.bnbchain.org",
  ];
  const exhaustedEveryAttempt = providers.every((provider) =>
    [1, 2].every((attempt) =>
      detail.includes(`attempt ${attempt} ${provider}:`),
    ),
  );
  const hasRateLimitSignal =
    detail.includes("BSC RPC returned HTTP 429") ||
    detail.includes("BSC RPC -32005: limit exceeded");

  return (
    detail.startsWith("BSC RPC providers unavailable (attempt 1 ") &&
    exhaustedEveryAttempt &&
    hasRateLimitSignal
  );
}

async function fetchReadOnly(url, init, { retryDelayForResponse } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(monitorRequestTimeoutMs),
      });
      const defaultRetryDelayMs = response.status === 429 || response.status >= 500
        ? 250
        : undefined;
      const responseBody = attempt === 1 && retryDelayForResponse
        ? await response.clone().json().catch(() => null)
        : null;
      const retryDelayMs = attempt === 1
        ? retryDelayForResponse?.(response, responseBody) ?? defaultRetryDelayMs
        : undefined;
      if (retryDelayMs !== undefined) {
        await response.body?.cancel();
        await sleep(retryDelayMs);
        continue;
      }
      return { response, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
      await sleep(250);
    }
  }
  throw lastError;
}

async function fetchText(name, input) {
  const url = localUrl(input);
  url.searchParams.set("positioncrew_monitor", monitorRunId);
  const startedAt = performance.now();
  const { response, attempts } = await fetchReadOnly(url, {
    headers: {
      Accept: "text/html",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": "PositionCrew-Production-Monitor/1.0",
    },
  });
  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const body = await response.text();
  checks.push({ name, url: url.toString(), status: response.status, latencyMs, attempts });
  assert(response.ok, `${name} returned HTTP ${response.status}`);
  return body;
}

async function fetchJson(
  name,
  input,
  { retryWhen, retryDelaysMs = [], retryDelayForResponse } = {},
) {
  const url = localUrl(input);
  url.searchParams.set("positioncrew_monitor", monitorRunId);
  const startedAt = performance.now();
  let totalAttempts = 0;

  for (let semanticAttempt = 0; ; semanticAttempt += 1) {
    const { response, attempts } = await fetchReadOnly(
      url,
      {
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "User-Agent": "PositionCrew-Production-Monitor/1.0",
        },
      },
      { retryDelayForResponse },
    );
    totalAttempts += attempts;
    const body = await response.json().catch(() => null);
    const retryDelayMs = retryDelaysMs[semanticAttempt];
    if (
      retryDelayMs !== undefined &&
      response.ok &&
      body &&
      typeof body === "object" &&
      retryWhen?.(body)
    ) {
      await sleep(retryDelayMs);
      continue;
    }

    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    checks.push({
      name,
      url: url.toString(),
      status: response.status,
      latencyMs,
      attempts: totalAttempts,
    });
    const failureDetail = body && typeof body === "object"
      ? `: ${JSON.stringify(body).slice(0, 500)}`
      : "";
    assert(response.ok, `${name} returned HTTP ${response.status}${failureDetail}`);
    assert(body && typeof body === "object", `${name} did not return a JSON object`);
    return body;
  }
}

function assertShadowGridClaimBoundary(value, context) {
  assert(
    JSON.stringify(value) === JSON.stringify(expectedShadowGridClaimBoundary),
    `${context} changed the explicit shadow-ledger claim boundary`,
  );
}

function assertNonNegativeInteger(value, context) {
  assert(
    Number.isInteger(value) && value >= 0,
    `${context} is not a non-negative integer`,
  );
}

function shadowGridTransitionAllowed(previous, current) {
  if (previous === "EPOCH_STARTED") {
    return current === "PRECOMMITTED" || current === "VOID_SOURCE_GAP";
  }
  if (previous === "PRECOMMITTED") {
    return ["REFUSED", "OBSERVED", "VOID_SOURCE_GAP"].includes(current);
  }
  if (["OBSERVED", "SHADOW_FILL"].includes(previous)) {
    return [
      "OBSERVED",
      "SHADOW_FILL",
      "CLOSED",
      "VOID_SOURCE_GAP",
      "RISK_EXIT",
    ].includes(current);
  }
  return false;
}

function verifyShadowGridWindow(envelope, summaryWindow) {
  assert(
    envelope.schemaVersion ===
      "positioncrew.bounded-grid-forward-shadow-window.v1",
    `Unexpected forward-shadow window schema for ${summaryWindow.windowId}`,
  );
  assertShadowGridClaimBoundary(
    envelope.claimBoundary,
    `Forward-shadow window ${summaryWindow.windowId}`,
  );
  assert(
    Number.isFinite(Date.parse(envelope.generatedAt)),
    `Forward-shadow window ${summaryWindow.windowId} has an invalid generation time`,
  );
  assert(
    envelope.window && typeof envelope.window === "object",
    `Forward-shadow window ${summaryWindow.windowId} omitted its public summary`,
  );
  assert(
    Array.isArray(envelope.events) && envelope.events.length >= 2,
    `Forward-shadow window ${summaryWindow.windowId} omitted its retained chain`,
  );

  const window = envelope.window;
  const events = envelope.events;
  assert(
    window.windowId === summaryWindow.windowId &&
      /^bg-[0-9]{8}-[0-9]{2}$/.test(window.windowId),
    "Forward-shadow detail changed its window identity",
  );
  assert(window.pair === "WBNB/USDT", `${window.windowId} changed its market`);
  assert(window.horizonMinutes === 15, `${window.windowId} changed its horizon`);
  assert(
    Number.isFinite(Date.parse(window.startedAt)),
    `${window.windowId} has an invalid start time`,
  );
  const receiptUrl = localUrl(window.receiptUrl);
  assert(
    receiptUrl.pathname ===
      `/api/evidence/bounded-grid-forward-shadow/windows/${window.windowId}`,
    `${window.windowId} has a non-canonical receipt URL`,
  );
  let previous = null;
  let terminalSeen = false;
  for (const [index, event] of events.entries()) {
    assert(
      event && typeof event === "object" && !Array.isArray(event),
      `${window.windowId} event ${index} is not an object`,
    );
    assert(
      event.schemaVersion ===
        "positioncrew.bounded-grid-forward-shadow-event.v1",
      `${window.windowId} event ${index} changed schema`,
    );
    assert(event.runId === window.windowId, `${window.windowId} event ${index} changed run`);
    assert(event.sequence === index, `${window.windowId} event sequence is discontinuous`);
    assert(
      shadowGridEventTypes.has(event.eventType),
      `${window.windowId} event ${index} has an unknown type`,
    );
    assert(
      Number.isFinite(Date.parse(event.recordedAt)),
      `${window.windowId} event ${index} has an invalid timestamp`,
    );
    assert(
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload),
      `${window.windowId} event ${index} has an invalid payload`,
    );
    assert(
      event.previousEventHash === (previous?.eventHash ?? null),
      `${window.windowId} event ${index} broke the previous-hash chain`,
    );
    const { eventHash, ...eventBody } = event;
    assert(
      /^sha256:[a-f0-9]{64}$/.test(eventHash ?? "") &&
        canonicalSha256(eventBody) === eventHash,
      `${window.windowId} event ${index} has an invalid canonical commitment`,
    );
    if (index === 0) {
      assert(
        event.eventType === "EPOCH_STARTED",
        `${window.windowId} does not begin with EPOCH_STARTED`,
      );
    } else {
      assert(!terminalSeen, `${window.windowId} changed after a terminal event`);
      assert(
        shadowGridTransitionAllowed(previous.eventType, event.eventType),
        `${window.windowId} has an invalid lifecycle transition`,
      );
    }
    terminalSeen = shadowGridTerminalEventTypes.has(event.eventType);
    previous = event;
  }

  const latest = events.at(-1);
  const initializationVoid =
    events.length === 2 &&
    events[0].eventType === "EPOCH_STARTED" &&
    latest.eventType === "VOID_SOURCE_GAP";
  const normalPrecommittedChain = events[1]?.eventType === "PRECOMMITTED";
  assert(
    initializationVoid || normalPrecommittedChain,
    `${window.windowId} is neither a precommitted chain nor an exact initialization void`,
  );
  if (initializationVoid) {
    assert(
      window.initializationState === "VOIDED_BEFORE_PRECOMMIT" &&
        window.precommitPersisted === false &&
        window.state === "VOID_SOURCE_GAP" &&
        window.sourceHireId === null &&
        window.sourceRequestHash === null &&
        window.sourceReceiptUrl === null &&
        window.sourceBlockNumber === null &&
        window.sampledCrossings === 0 &&
        window.simulatedNetOutcomeUsd === null,
      `${window.windowId} weakened its initialization-void public boundary`,
    );
    assert(
      latest.payload.observedSampleCount === 0 &&
        latest.payload.netOutcomeUsd === null &&
        latest.payload.outcome === null &&
        latest.payload.repairedLater === false &&
        typeof latest.payload.reason === "string" &&
        latest.payload.reason.length > 0,
      `${window.windowId} has invalid initialization-void terminal semantics`,
    );
  } else {
    const precommit = events[1];
    assert(
      window.initializationState === "PRECOMMITTED" &&
        window.precommitPersisted === true,
      `${window.windowId} weakened its precommitted initialization boundary`,
    );
    assert(
      typeof window.sourceHireId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          window.sourceHireId,
        ) &&
        typeof window.sourceRequestHash === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(window.sourceRequestHash),
      `${window.windowId} has an invalid committed source binding`,
    );
    assert(
      typeof window.sourceBlockNumber === "string" &&
        /^[1-9][0-9]*$/.test(window.sourceBlockNumber),
      `${window.windowId} has an invalid source block`,
    );
    const sourceReceiptUrl = localUrl(window.sourceReceiptUrl);
    assert(
      /^\/api\/benchmark-receipts\/[0-9a-f-]{36}$/.test(sourceReceiptUrl.pathname),
      `${window.windowId} has a non-canonical source receipt URL`,
    );
    assert(
      precommit.payload.sourceHireId === window.sourceHireId &&
        precommit.payload.sourceRequestHash === window.sourceRequestHash &&
        localUrl(precommit.payload.sourceReceiptUrl).pathname === sourceReceiptUrl.pathname &&
        String(precommit.payload.sourceBlockNumber) === window.sourceBlockNumber,
      `${window.windowId} public summary differs from its precommitment`,
    );
  }
  assert(
    envelope.integrity?.valid === true &&
      envelope.integrity?.headHash === latest.eventHash,
    `${window.windowId} did not verify its retained hash chain`,
  );
  assert(
    window.eventHash === latest.eventHash &&
      window.previousEventHash === latest.previousEventHash,
    `${window.windowId} public head differs from its retained event chain`,
  );
  assert(
    events.some(
      (event) =>
        event.eventHash === summaryWindow.eventHash &&
        event.previousEventHash === summaryWindow.previousEventHash,
    ),
    `${window.windowId} no longer contains the head published by the ledger summary`,
  );

  const expectedState = shadowGridTerminalEventTypes.has(latest.eventType)
    ? latest.eventType
    : "PRECOMMITTED";
  assert(window.state === expectedState, `${window.windowId} state differs from its event chain`);
  assert(
    window.sampledCrossings ===
      events.filter((event) => event.eventType === "SHADOW_FILL").length,
    `${window.windowId} sampled-crossing count differs from its event chain`,
  );
  if (["CLOSED", "RISK_EXIT"].includes(latest.eventType)) {
    assert(
      typeof latest.payload.netOutcomeUsd === "string" &&
        Number.isFinite(Number(latest.payload.netOutcomeUsd)) &&
        window.simulatedNetOutcomeUsd === latest.payload.netOutcomeUsd,
      `${window.windowId} has an invalid simulated terminal outcome`,
    );
  } else {
    assert(
      window.simulatedNetOutcomeUsd === null,
      `${window.windowId} reports an outcome without a return-bearing terminal event`,
    );
  }
  assert(
    window.terminalAt ===
      (shadowGridTerminalEventTypes.has(latest.eventType) ? latest.recordedAt : null),
    `${window.windowId} terminal time differs from its event chain`,
  );

  return {
    windowId: window.windowId,
    state: window.state,
    eventCount: events.length,
    headHash: latest.eventHash,
    simulatedNetOutcomeUsd: window.simulatedNetOutcomeUsd,
  };
}

async function verifyShadowGridLedger(ledger) {
  assert(
    ledger.schemaVersion ===
      "positioncrew.bounded-grid-forward-shadow-ledger.v1",
    "Unexpected Bounded Grid forward-shadow ledger schema",
  );
  assert(
    Number.isFinite(Date.parse(ledger.generatedAt)),
    "Forward-shadow ledger has an invalid generation time",
  );
  const publicUrl = localUrl(ledger.publicUrl);
  assert(
    publicUrl.pathname === "/api/evidence/bounded-grid-forward-shadow",
    "Forward-shadow ledger public URL is not canonical",
  );
  assertShadowGridClaimBoundary(ledger.claimBoundary, "Forward-shadow ledger");
  assert(
    ledger.model?.name === expectedShadowGridFillModel &&
      ledger.model?.strategyVersion === expectedShadowGridStrategyVersion &&
      ledger.model?.pair === "WBNB/USDT" &&
      ledger.model?.capitalMode === "ZERO_FUND_SHADOW" &&
      ledger.model?.cadenceMinutes === 60 &&
      ledger.model?.sampleCadenceMinutes === 5 &&
      ledger.model?.horizonMinutes === 15,
    "Forward-shadow ledger model constants changed",
  );

  const maturity = ledger.maturity;
  assert(
    maturity && typeof maturity === "object",
    "Forward-shadow ledger omitted its maturity contract",
  );
  assert(
    Number.isFinite(maturity.observedDays) && maturity.observedDays >= 0,
    "Forward-shadow observed-day count is invalid",
  );
  assertNonNegativeInteger(
    maturity.terminalWindowCount,
    "Forward-shadow terminal-window count",
  );
  assert(
    maturity.minimumObservedDays === 7 &&
      maturity.minimumTerminalWindows === 30 &&
      maturity.minimumNonVoidRatePct === 90 &&
      maturity.hashChainValid === true,
    "Forward-shadow maturity constants or hash-chain status changed",
  );

  const summary = ledger.summary;
  assert(summary && typeof summary === "object", "Forward-shadow ledger omitted its summary");
  for (const key of [
    "openedWindowCount",
    "precommittedWindowCount",
    "initializationVoidWindowCount",
    "precommittedTerminalWindowCount",
    "terminalWindowCount",
    "closedWindowCount",
    "refusedWindowCount",
    "voidWindowCount",
    "riskExitWindowCount",
    "positiveWindowCount",
    "negativeWindowCount",
  ]) {
    assertNonNegativeInteger(summary[key], `Forward-shadow ${key}`);
  }
  assert(
    summary.terminalWindowCount === maturity.terminalWindowCount &&
      summary.terminalWindowCount <= summary.openedWindowCount &&
      summary.precommittedWindowCount <= summary.openedWindowCount,
    "Forward-shadow summary and maturity counts disagree",
  );
  assert(
    summary.openedWindowCount ===
        summary.precommittedWindowCount + summary.initializationVoidWindowCount &&
      summary.terminalWindowCount ===
        summary.precommittedTerminalWindowCount + summary.initializationVoidWindowCount &&
      summary.precommittedTerminalWindowCount <= summary.precommittedWindowCount &&
      summary.initializationVoidWindowCount <= summary.voidWindowCount,
    "Forward-shadow initialization categories do not reconcile",
  );
  assert(
    summary.terminalWindowCount ===
      summary.closedWindowCount +
        summary.refusedWindowCount +
        summary.voidWindowCount +
        summary.riskExitWindowCount,
    "Forward-shadow terminal categories do not reconcile",
  );
  assert(
    summary.positiveWindowCount + summary.negativeWindowCount <=
      summary.closedWindowCount + summary.riskExitWindowCount,
    "Forward-shadow return-bearing outcome counts do not reconcile",
  );

  const expectedNonVoidRate = summary.terminalWindowCount === 0
    ? null
    : Number(
        (
          ((summary.terminalWindowCount - summary.voidWindowCount) /
            summary.terminalWindowCount) *
          100
        ).toFixed(2),
      );
  assert(
    maturity.nonVoidRatePct === expectedNonVoidRate,
    "Forward-shadow non-void rate does not match retained terminal windows",
  );
  const expectedMature =
    maturity.observedDays >= 7 &&
    summary.terminalWindowCount >= 30 &&
    (maturity.nonVoidRatePct ?? 0) >= 90;
  assert(
    maturity.mature === expectedMature,
    "Forward-shadow maturity status does not follow its published thresholds",
  );
  const expectedStatus =
    summary.terminalWindowCount >= 30 && (maturity.nonVoidRatePct ?? 0) < 90
      ? "DEGRADED"
      : expectedMature
        ? "MATURE"
        : "COLLECTING";
  assert(ledger.status === expectedStatus, "Forward-shadow ledger status is inconsistent");
  if (expectedMature) {
    assert(
      typeof summary.simulatedNetOutcomeUsd === "string" &&
        Number.isFinite(Number(summary.simulatedNetOutcomeUsd)),
      "Mature forward-shadow ledger has no numeric simulated aggregate",
    );
  } else {
    assert(
      summary.simulatedNetOutcomeUsd === null,
      "Immature forward-shadow ledger published an aggregate outcome",
    );
  }

  assert(
    Array.isArray(ledger.recentWindows) && ledger.recentWindows.length <= 10,
    "Forward-shadow recent-window list is invalid",
  );
  assert(
    ledger.recentWindows.length <= summary.openedWindowCount &&
      new Set(ledger.recentWindows.map((window) => window.windowId)).size ===
        ledger.recentWindows.length,
    "Forward-shadow recent windows are duplicated or exceed retained windows",
  );
  const verifiedWindows = await Promise.all(
    ledger.recentWindows.map(async (window) => {
      assert(window.pair === "WBNB/USDT", `${window.windowId} changed its summary market`);
      assert(window.horizonMinutes === 15, `${window.windowId} changed its summary horizon`);
      if (window.simulatedNetOutcomeUsd !== null) {
        assert(
          typeof window.simulatedNetOutcomeUsd === "string" &&
            Number.isFinite(Number(window.simulatedNetOutcomeUsd)),
          `${window.windowId} has a non-numeric simulated summary outcome`,
        );
      }
      const detail = await fetchJson(
        `bounded-grid-forward-shadow-window-${window.windowId}`,
        window.receiptUrl,
      );
      return verifyShadowGridWindow(detail, window);
    }),
  );

  return {
    schemaVersion: ledger.schemaVersion,
    status: ledger.status,
    model: ledger.model,
    maturity: ledger.maturity,
    summary: ledger.summary,
    claimBoundary: ledger.claimBoundary,
    verifiedRecentWindows: verifiedWindows,
  };
}

async function fetchGithubJson(name, input) {
  const url = new URL(input);
  assert(url.origin === "https://api.github.com", `Refusing non-GitHub API URL: ${url}`);
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const startedAt = performance.now();
  const { response, attempts } = await fetchReadOnly(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "Cache-Control": "no-cache",
      "User-Agent": "PositionCrew-Production-Monitor/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const body = await response.json().catch(() => null);
  checks.push({ name, url: url.toString(), status: response.status, latencyMs, attempts });
  assert(response.ok, `${name} returned HTTP ${response.status}`);
  assert(body && typeof body === "object", `${name} did not return a JSON object`);
  return body;
}

function extractZipEntry(archive, expectedName) {
  const endSearchStart = Math.max(0, archive.length - 65_557);
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= endSearchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  assert(endOffset >= 0, "Artifact ZIP end-of-central-directory record is missing");
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert(
      archive.readUInt32LE(cursor) === 0x02014b50,
      "Artifact ZIP central-directory entry is malformed",
    );
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const fileNameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const fileName = archive.toString(
      "utf8",
      cursor + 46,
      cursor + 46 + fileNameLength,
    );
    if (fileName === expectedName) {
      assert(
        archive.readUInt32LE(localHeaderOffset) === 0x04034b50,
        "Artifact ZIP local entry is malformed",
      );
      const localFileNameLength = archive.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
      const dataStart =
        localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const compressed = archive.subarray(dataStart, dataStart + compressedSize);
      const content = compressionMethod === 0
        ? Buffer.from(compressed)
        : compressionMethod === 8
          ? inflateRawSync(compressed)
          : null;
      assert(content, `Unsupported artifact ZIP compression method: ${compressionMethod}`);
      assert(
        content.length === uncompressedSize,
        "Artifact ZIP report size does not match its central directory",
      );
      return content;
    }
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error(`Artifact ZIP is missing ${expectedName}`);
}

async function postJson(name, input, payload) {
  const url = localUrl(input);
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "PositionCrew-Production-Monitor/1.0",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const body = await response.json().catch(() => null);
  checks.push({ name, url: url.toString(), status: response.status, latencyMs });
  assert(response.ok, `${name} returned HTTP ${response.status}`);
  assert(body && typeof body === "object", `${name} did not return a JSON object`);
  return body;
}

async function postCurrentHireJson(name, input, payload, acceptedStatuses) {
  const url = localUrl(input);
  url.searchParams.set("positioncrew_monitor", monitorRunId);
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: baseUrl.origin,
      "User-Agent": "PositionCrew-Production-Monitor/1.0",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(monitorRequestTimeoutMs),
  });
  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const body = await response.json().catch(() => null);
  checks.push({ name, url: url.toString(), status: response.status, latencyMs });
  assert(
    acceptedStatuses.includes(response.status),
    `${name} returned HTTP ${response.status}: ${JSON.stringify(body)}`,
  );
  assert(body && typeof body === "object", `${name} did not return a JSON object`);
  return body;
}

function currentPersistedHireEnvelope(definition, probe) {
  const request = structuredClone(probe[definition.requestKey]);
  assert(request?.service === definition.service, `${definition.service} probe request mismatch`);
  assert(probe.source?.blockNumber, `${definition.service} probe omitted its pinned block`);
  assert(probe.source?.explorerUrl, `${definition.service} probe omitted its explorer URL`);
  assert(request.sources?.length === 1, `${definition.service} request does not have one source`);
  const blockNumber = String(probe.source.blockNumber);
  const source = request.sources[0];
  const observedAt = probe.source.blockTimestamp ?? source.observedAt;
  const explorerUrl = `https://bscscan.com/block/${blockNumber}`;
  assert(observedAt, `${definition.service} probe omitted its observation time`);
  assert(request.chainId === 56, `${definition.service} probe request is not BSC mainnet`);
  assert(request.protocol === definition.protocol, `${definition.service} probe protocol mismatch`);
  assert(source.sourceId === definition.sourceId(blockNumber), `${definition.service} sourceId mismatch`);
  assert(source.uri === explorerUrl, `${definition.service} request source explorer mismatch`);
  assert(source.observedAt === observedAt, `${definition.service} request source timestamp mismatch`);
  assert(probe.source.explorerUrl === explorerUrl, `${definition.service} probe explorer mismatch`);
  assert(
    definition.validRequestId(request.requestId, blockNumber),
    `${definition.service} requestId is not bound to the live probe`,
  );
  return {
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
    idempotencyKey: randomUUID(),
    benchmarkSlug: definition.benchmarkSlug,
    providerSlug: definition.providerSlug,
    evidenceMode: "CURRENT_BLOCK_PINNED",
    observation: {
      blockNumber,
      observedAt,
      explorerUrl,
    },
    request,
  };
}

async function waitForCurrentPersistedHire(definition, hireId) {
  const expiresAt = Date.now() + 20_000;
  while (Date.now() < expiresAt) {
    const chain = await fetchJson(
      `${definition.service}:current-hire-poll`,
      `/api/benchmark-hires/${hireId}`,
    );
    assert(chain.job?.state !== "FAILED", `${definition.service} persisted hire failed`);
    if (chain.job?.state === "COMPLETED" && chain.receipt) return chain;
    await sleep(250);
  }
  throw new Error(`${definition.service} persisted hire did not complete before timeout`);
}

async function verifyCurrentPersistedHire(definition, probe) {
  const envelope = currentPersistedHireEnvelope(definition, probe);
  const created = await postCurrentHireJson(
    `${definition.service}:current-hire-create`,
    "/api/benchmark-hires",
    envelope,
    [200, 201],
  );
  assert(created.hire?.service === definition.service, `${definition.service} hire routed incorrectly`);
  assert(created.hire?.evidenceMode === "CURRENT_BLOCK_PINNED", `${definition.service} hire changed evidence mode`);
  assert(created.job?.state === "CREATED", `${definition.service} hire did not start in CREATED`);
  assert(created.receipt === null, `${definition.service} hire created a premature receipt`);
  assert(
    created.hire?.requestHash === freshHireCanonicalSha256(envelope.request),
    `${definition.service} request commitment is invalid`,
  );
  assert(created.hire?.providerHash, `${definition.service} provider binding is uncommitted`);
  assert(created.hire?.evidenceHash, `${definition.service} current evidence is uncommitted`);
  assert(
    created.hire?.evidence?.freshnessAtCreation === "FRESH" &&
      created.hire.evidenceHash === freshHireCanonicalSha256(created.hire.evidence),
    `${definition.service} current evidence commitment is stale or invalid`,
  );

  await postCurrentHireJson(
    `${definition.service}:current-hire-run`,
    `/api/benchmark-hires/${created.hire.hireId}/jobs`,
    {},
    [200, 202],
  );
  const completed = await waitForCurrentPersistedHire(definition, created.hire.hireId);
  assert(
    completed.hire?.requestHash === created.hire.requestHash &&
      completed.hire?.providerHash === created.hire.providerHash &&
      completed.hire?.evidenceHash === created.hire.evidenceHash,
    `${definition.service} hire commitments changed during execution`,
  );
  assert(
    completed.receipt?.response?.result?.request?.service === definition.service,
    `${definition.service} receipt contains the wrong provider request`,
  );
  assert(
    freshHireCanonicalSha256(completed.receipt?.response?.result?.request) === created.hire.requestHash,
    `${definition.service} receipt request commitment differs from the live probe request`,
  );
  assert(
    completed.receipt?.response?.result?.evaluation?.score === 100,
    `${definition.service} persisted-hire conformance score is not 100/100`,
  );

  const publicChain = await fetchJson(
    `${definition.service}:current-hire-receipt`,
    completed.receipt.publicUrl,
  );
  assert(publicChain.hire?.hireId === created.hire.hireId, `${definition.service} public receipt changed hire`);
  assert(publicChain.job?.state === "COMPLETED", `${definition.service} public receipt is not complete`);
  assert(
    publicChain.hire?.requestHash === completed.hire.requestHash &&
      publicChain.hire?.providerHash === completed.hire.providerHash &&
      publicChain.hire?.evidenceHash === completed.hire.evidenceHash,
    `${definition.service} public receipt changed hire commitments`,
  );
  assert(
    JSON.stringify(publicChain.receipt) === JSON.stringify(completed.receipt),
    `${definition.service} public receipt changed after reload`,
  );
  if (definition.service === "LENDING_RESCUE") {
    assert(
      publicChain.receipt?.response?.result?.deliverable?.status === "REFUSED_CONSTRAINTS",
      "Zero-position lending monitor hire did not refuse constraints",
    );
  }

  return {
    service: definition.service,
    hireId: created.hire.hireId,
    receiptId: completed.receipt.receiptId,
    publicUrl: completed.receipt.publicUrl,
    requestHash: completed.hire.requestHash,
    providerHash: completed.hire.providerHash,
    evidenceHash: completed.hire.evidenceHash,
    jobState: completed.job.state,
    conformanceScore: completed.receipt.response.result.evaluation.score,
  };
}

function rebaseObservationTimes(value, observedAt) {
  if (Array.isArray(value)) {
    return value.map((item) => rebaseObservationTimes(item, observedAt));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "observedAt" ? observedAt : rebaseObservationTimes(child, observedAt),
    ]),
  );
}

function buildMonitorRequest(request, now) {
  const observedAt = now.toISOString();
  const next = rebaseObservationTimes(structuredClone(request), observedAt);
  next.requestId = `production-monitor-${String(request.service).toLowerCase()}-${now.getTime()}`;
  next.requestedAt = observedAt;
  next.deadline = new Date(now.getTime() + 5 * 60_000).toISOString();
  return next;
}

function decodeAgentUri(agentUri) {
  const separator = agentUri.indexOf(",");
  assert(separator > 0, "ERC-8004 agent URI is not a data URI");
  const metadata = agentUri.slice(0, separator);
  const payload = agentUri.slice(separator + 1);
  const json = metadata.endsWith(";base64")
    ? Buffer.from(payload, "base64").toString("utf8")
    : decodeURIComponent(payload);
  return JSON.parse(json);
}

async function verifyIdentity(entry) {
  const identity = entry.identity;
  assert(identity?.protocol === "ERC-8004", `${entry.service} has no ERC-8004 identity`);
  assert(identity.chainId === 97, `${entry.service} identity is not on BSC testnet`);
  const startedAt = performance.now();
  const contract = { address: identity.registry, abi: identityAbi };
  const [owner, agentUri, receipt] = await Promise.all([
    identityClient.readContract({ ...contract, functionName: "ownerOf", args: [BigInt(identity.agentId)] }),
    identityClient.readContract({ ...contract, functionName: "tokenURI", args: [BigInt(identity.agentId)] }),
    identityClient.getTransactionReceipt({ hash: identity.registrationTransaction }),
  ]);
  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  checks.push({
    name: `${entry.service}:erc8004-identity`,
    url: bscTestnetRpc,
    status: 200,
    latencyMs,
  });
  assert(owner.toLowerCase() === identity.owner.toLowerCase(), `${entry.service} identity owner mismatch`);
  assert(receipt.status === "success", `${entry.service} registration transaction failed`);
  const registration = decodeAgentUri(agentUri);
  assert(registration.name?.startsWith("PositionCrew "), `${entry.service} identity name mismatch`);
  const discoveredManifest = new URL(entry.manifestUrl);
  assert(
    registration.services?.some((service) => {
      const registeredEndpoint = new URL(service.endpoint);
      return (
        registeredEndpoint.protocol === "https:" &&
        registeredEndpoint.hostname === "positioncrew.dolepee.com" &&
        registeredEndpoint.pathname === discoveredManifest.pathname
      );
    }),
    `${entry.service} identity does not bind its manifest`,
  );
  return { agentId: identity.agentId, owner, registrationTransaction: identity.registrationTransaction };
}

const report = {
  schemaVersion: "positioncrew.production-health-report.v1",
  checkedAt: new Date().toISOString(),
  baseUrl: baseUrl.origin,
  status: "FAILED",
  checks,
  providers: [],
  shadowGridLedger: null,
  error: null,
};

try {
  const marketplace = await fetchJson(
    "marketplace-manifest",
    "/.well-known/positioncrew.json",
  );
  assert(
    marketplace.schemaVersion === "positioncrew.marketplace-manifest.v1",
    "Unexpected marketplace manifest schema",
  );
  assert(Array.isArray(marketplace.providers), "Marketplace providers are missing");
  assert(marketplace.providers.length === 4, "Marketplace must expose exactly four providers");
  assert(
    marketplace.claims?.settlement === "IN_MEMORY_CONFORMANCE",
    "Marketplace settlement boundary changed unexpectedly",
  );
  assert(
    marketplace.claims?.providerIdentity === "ERC8004_BSC_TESTNET_VERIFIED",
    "Marketplace identity claim changed unexpectedly",
  );
  assert(
    marketplace.claims?.judgeTrial === "NO_WALLET_PROVIDER_CALL",
    "Marketplace judge-trial boundary changed unexpectedly",
  );
  assert(
    marketplace.claims?.aacp === "PRODUCTION_RUNTIME_PENDING",
    "Marketplace AACP claim boundary changed unexpectedly",
  );
  assert(
    new URL(marketplace.operatingRecordUrl).origin === baseUrl.origin,
    "Marketplace operating record is not canonical",
  );
  assert(
    new URL(marketplace.marketplaceDeliveryEvidenceUrl).origin === baseUrl.origin,
    "Marketplace delivery evidence is not canonical",
  );
  assert(
    new URL(marketplace.aacpReadinessUrl).origin === baseUrl.origin,
    "Marketplace AACP readiness record is not canonical",
  );
  assert(
    new URL(marketplace.externalComparisonSnapshotUrl).origin === baseUrl.origin,
    "Marketplace external comparison snapshot is not canonical",
  );
  assert(
    new URL(marketplace.venusTestnetNativeSupplyEvidenceUrl).origin === baseUrl.origin,
    "Marketplace Venus testnet supply evidence is not canonical",
  );
  const externalComparisons = await fetchJson(
    "external-comparison-snapshot",
    marketplace.externalComparisonSnapshotUrl,
  );
  assert(
    externalComparisons.schemaVersion === "positioncrew.external-comparison-snapshot.v1",
    "Unexpected external comparison snapshot schema",
  );
  const { snapshotHash: _externalComparisonSnapshotHash, ...externalComparisonSnapshotBody } = externalComparisons;
  assert(
    canonicalSha256(externalComparisonSnapshotBody) === externalComparisons.snapshotHash,
    "External comparison snapshot commitment is invalid",
  );
  assert(externalComparisons.candidates?.length === 4, "External comparison snapshot must contain four candidates");
  const externalComparisonServices = new Set(
    externalComparisons.candidates.map((candidate) => candidate.category?.service),
  );
  assert(
    externalComparisonServices.size === expectedServices.size &&
      [...expectedServices].every((service) => externalComparisonServices.has(service)),
    "External comparison snapshot does not cover the exact required services",
  );
  assert(
    externalComparisons.candidates.every(
      (candidate) => candidate.positionCrewCertified === false && candidate.positionCrewActivation === "NOT_SUPPORTED",
    ),
    "External comparison snapshot overstates certification or activation",
  );
  report.externalComparisons = {
    snapshotId: externalComparisons.snapshotId,
    snapshotHash: externalComparisons.snapshotHash,
    candidateCount: externalComparisons.candidates.length,
  };

  const boundedActivationStatus = await fetchJson(
    "altana-venus-activation-status",
    marketplace.boundedActivationStatusUrl,
  );
  assert(
    boundedActivationStatus.schemaVersion === "positioncrew.altana-venus-activation-status.v1" &&
      ["AVAILABLE", "DAILY_CAP_REACHED"].includes(boundedActivationStatus.status) &&
      boundedActivationStatus.fixedSupplyWei === "100000000000000" &&
      boundedActivationStatus.session?.actor?.toLowerCase() === "0x50da554f1bf6a86469db201c56bfe967d2e7c43d" &&
      /^0x[0-9a-f]{130}$/iu.test(boundedActivationStatus.session.publicKey ?? "") &&
      Number(boundedActivationStatus.session.expiry) * 1_000 > Date.now() &&
      /^0x[0-9a-f]{64}$/iu.test(boundedActivationStatus.session.grantTransactionHash ?? "") &&
      boundedActivationStatus.session?.permissions?.calls?.length === 1 &&
      boundedActivationStatus.session.permissions.calls[0]?.signature === "mint()" &&
      boundedActivationStatus.session.permissions.calls[0]?.to?.toLowerCase() === "0x2e7222e51c0f6e98610a1543aa3836e092cde62c" &&
      boundedActivationStatus.session.permissions.spend?.length === 1 &&
      boundedActivationStatus.session.permissions.spend[0]?.limit === "200000000000000" &&
      boundedActivationStatus.session.permissions.spend[0]?.period === "minute" &&
      boundedActivationStatus.session.verification?.registryValid === true &&
      boundedActivationStatus.session.verification?.accountAuthorized === true &&
      boundedActivationStatus.session.verification?.accountKeyExpiry === boundedActivationStatus.session.expiry &&
      boundedActivationStatus.session.verification?.accountKeyType === 2 &&
      boundedActivationStatus.session.verification?.accountKeyIsSuperAdmin === false &&
      /^0x[0-9a-f]{64}$/iu.test(boundedActivationStatus.session.verification?.accountKeyPublicKey ?? "") &&
      boundedActivationStatus.session.verification?.liveExecutionRuleCount === 1 &&
      boundedActivationStatus.session.verification?.liveCallScopeVerified === true &&
      boundedActivationStatus.session.verification?.liveSpendRuleCount === 1 &&
      boundedActivationStatus.session.verification?.liveSpendToken?.toLowerCase() === "0x0000000000000000000000000000000000000000" &&
      boundedActivationStatus.session.verification?.liveSpendPeriod === "minute" &&
      boundedActivationStatus.session.verification?.liveSpendLimit === "200000000000000" &&
      /^0x[0-9a-f]{64}$/iu.test(boundedActivationStatus.session.verification?.registryKeyId ?? "") &&
      /^0x[0-9a-f]{64}$/iu.test(boundedActivationStatus.session.verification?.accountKeyHash ?? "") &&
      boundedActivationStatus.session.verification?.keyStore?.toLowerCase() === "0x6b8361c29d05d498b1a12b54a37310f94171e94a",
    "Bounded Altana Venus activation is unavailable or broader than the published authority",
  );
  report.boundedActivation = boundedActivationStatus;

  const venusNativeSupplyEvidence = await fetchJson(
    "venus-testnet-native-supply-evidence",
    marketplace.venusTestnetNativeSupplyEvidenceUrl,
  );
  assert(
    venusNativeSupplyEvidence.schemaVersion === "positioncrew.venus-testnet-native-supply-receipt.v1",
    "Unexpected Venus testnet native-supply evidence schema",
  );
  const venusArtifactCommitmentBody = {
    ...venusNativeSupplyEvidence,
    commitments: {
      normalizedReceiptHash: venusNativeSupplyEvidence.commitments?.normalizedReceiptHash,
    },
  };
  assert(
    canonicalSha256(venusArtifactCommitmentBody) === venusNativeSupplyEvidence.commitments?.artifactHash &&
      venusNativeSupplyEvidence.commitments.artifactHash === "sha256:cc1239e1932aac886eee9365303f65f4903991389bdd73b507c9ba3108988976",
    "Venus testnet native-supply artifact commitment is invalid",
  );
  assert(
    venusNativeSupplyEvidence.relationship === "FOUNDER_CONTROLLED_TESTNET_ACTION" &&
      venusNativeSupplyEvidence.network?.chainId === 97 &&
      venusNativeSupplyEvidence.intent?.transaction?.amountTbnb === "0.0001" &&
      venusNativeSupplyEvidence.intent?.transaction?.valueWei === "100000000000000" &&
      venusNativeSupplyEvidence.actor?.externalBuyer === false &&
      venusNativeSupplyEvidence.intent?.preflight?.mainnetIsolation?.nativeBalanceWei === "0" &&
      venusNativeSupplyEvidence.intent?.preflight?.mainnetIsolation?.pendingNonce === "0",
    "Venus testnet native-supply evidence overstates its execution boundary",
  );
  assert(
    venusNativeSupplyEvidence.transaction?.hash === "0xf2b4a8790ff7f81fc832a365d89eb84f0554d2242c45faa886ba6819acb1773b",
    "Venus testnet native-supply transaction changed",
  );
  const serializedVenusEvidence = JSON.stringify(venusNativeSupplyEvidence);
  assert(
    !/rawTransaction|private[-_ ]?key|password|keystore|mnemonic|seed[-_ ]?phrase|\/Users\/|\/home\/|\/root\//i.test(serializedVenusEvidence),
    "Venus testnet native-supply publication contains private or local material",
  );
  const expectedVenusNativeSupplyClaim =
    "Optional sponsor and execution evidence for one disclosed-operator Venus action on BSC Testnet using exactly 0.0001 tBNB; its preflight observed zero native BNB balance and pending nonce on BSC mainnet at one timestamp but did not inventory tokens or NFTs; it proves no external buyer, revenue, autonomous custody, strategy return, repeated track record, marketplace demand, or financial performance.";
  assert(
    marketplace.claims?.venusTestnetNativeSupply === expectedVenusNativeSupplyClaim,
    "Marketplace Venus testnet supply claim boundary changed or is incomplete",
  );
  report.venusTestnetNativeSupplyEvidence = {
    transactionHash: venusNativeSupplyEvidence.transaction.hash,
    artifactHash: venusNativeSupplyEvidence.commitments.artifactHash,
    amountTbnb: venusNativeSupplyEvidence.intent.transaction.amountTbnb,
  };

  const aacpReadiness = await fetchJson(
    "aacp-production-readiness",
    marketplace.aacpReadinessUrl,
    {
      retryWhen: (body) => body.state === "SOURCE_UNAVAILABLE",
      retryDelaysMs: [65_000, 65_000],
    },
  );
  assert(
    aacpReadiness.schemaVersion === "positioncrew.aacp-production-readiness.v1",
    "Unexpected AACP readiness schema",
  );
  assert(aacpReadiness.network?.chainId === 56, "AACP readiness is not on BNB Chain");
  assert(
    aacpReadiness.state !== "SOURCE_UNAVAILABLE" &&
      aacpReadiness.state !== "PROTOCOL_DEGRADED" &&
      aacpReadiness.state !== "MARKETPLACE_DISCOVERY_DEGRADED",
    `AACP production rail is ${aacpReadiness.state}`,
  );
  assert(
    aacpReadiness.protocol?.contractCount > 0 &&
      aacpReadiness.protocol.deployedCount === aacpReadiness.protocol.contractCount,
    "AACP production contract bytecode is incomplete",
  );
  assert(
    aacpReadiness.protocol?.currencies?.map((currency) => currency.symbol).join(",") ===
      "USDC,USDT",
    "AACP production settlement currencies changed",
  );
  assert(
    aacpReadiness.marketplace?.requiredProviderCount === 4 &&
      aacpReadiness.marketplace.providers?.length === 4,
    "AACP readiness does not cover all four PositionCrew providers",
  );
  assert(
    aacpReadiness.marketplace.registeredIdentityCount === 4 &&
      aacpReadiness.marketplace.providers.every(
        (provider) =>
          expectedAacpAgentTokenIds.has(provider.agentTokenId) &&
          provider.identity?.onchainVerified === true &&
          provider.identity.owner?.toLowerCase() === expectedAacpOwner,
      ),
    "AACP readiness does not verify all four mainnet identities",
  );
  assert(
    ["LISTINGS_PUBLISHED_RUNTIME_PENDING", "PROVIDERS_ONLINE"].includes(
      aacpReadiness.state,
    ) &&
      aacpReadiness.marketplace.indexedProviderCount === 4 &&
      aacpReadiness.marketplace.publishedListingCount === 4 &&
      aacpReadiness.marketplace.discoveryDegraded === false,
    "AACP readiness does not report four published providers",
  );
  assert(
    aacpReadiness.marketplace.providers.every(
      (provider) =>
        expectedAacpListings.get(provider.agentTokenId) === provider.listingId &&
        provider.listingStatus === "PUBLISHED" &&
        provider.liveListingVerified === true &&
        typeof provider.listingUrl === "string" &&
        new URL(provider.listingUrl).hostname === "www.agent.family",
    ),
    "AACP public listing identity or status changed",
  );
  const onlineAacpProviders = aacpReadiness.marketplace.providers.filter(
    (provider) =>
      provider.a2aStatus === "ONLINE" &&
      provider.presence === "online" &&
      provider.status === "ONLINE_AND_LISTED",
  );
  assert(
    onlineAacpProviders.length === aacpReadiness.marketplace.onlineProviderCount,
    "AACP runtime count is inconsistent with provider state",
  );
  assert(
    aacpReadiness.marketplace.dedicatedFlagship?.agentId === "cmt4dzxvcli4tw70125nd5ra8" &&
      aacpReadiness.marketplace.dedicatedFlagship?.agentTokenId === "293111" &&
      aacpReadiness.marketplace.dedicatedFlagship?.listingId === "cmt4e8j3nlmuiw7019f4qf24x" &&
      aacpReadiness.marketplace.dedicatedFlagship?.owner === "0xADd748C416E8A7efd7d65D18Abb121dea268ddF9" &&
      aacpReadiness.marketplace.dedicatedFlagship?.onchainVerified === true &&
      aacpReadiness.marketplace.dedicatedFlagship?.listingStatus === "PUBLISHED" &&
      aacpReadiness.marketplace.dedicatedFlagship?.a2aStatus === "ONLINE" &&
      aacpReadiness.marketplace.dedicatedFlagship?.status === "ONLINE_AND_LISTED",
    "Dedicated Lending Rescue flagship is not published and online",
  );
  assert(
    (onlineAacpProviders.length === 4 && aacpReadiness.state === "PROVIDERS_ONLINE") ||
      (onlineAacpProviders.length < 4 &&
        aacpReadiness.state === "LISTINGS_PUBLISHED_RUNTIME_PENDING"),
    "AACP readiness state is inconsistent with live runtime presence",
  );
  assert(
    aacpReadiness.integration?.guide?.status === "CURRENT_HUMAN_GUIDE_VERIFIED" &&
      aacpReadiness.integration?.guide?.openApiStatus === "SAMPLE_SPEC_NOT_USED",
    "AACP guide verification boundary changed",
  );
  assert(
    aacpReadiness.integration?.runtime?.status === "PREISSUED_TOKEN_ADAPTER_IMPLEMENTED" &&
      aacpReadiness.integration.runtime.ownerSignerOnHost === true &&
      aacpReadiness.integration.runtime.autoRenewsToken === true &&
      aacpReadiness.integration.runtime.tokenLifetimeHours === 12,
    "AACP runtime signing or expiry boundary changed",
  );
  const runtimeEvidence = aacpReadiness.integration.runtime.rotationEvidence;
  const rotations = runtimeEvidence?.rotations ?? [];
  const archiveAttestation = runtimeEvidence?.archiveAttestation;
  assert(
    aacpReadiness.integration.runtime.automationScope === "DEDICATED_FLAGSHIP_ONLY" &&
      aacpReadiness.integration.runtime.signerIsolation ===
        "ROOT_ONLY_SYSTEMD_RENEWAL_UNIT" &&
      aacpReadiness.integration.runtime.pollerHasSigningMaterial === false &&
      aacpReadiness.integration.runtime.originalProvidersAutoRenew === false,
    "AACP runtime automation scope is overstated",
  );
  assert(
    runtimeEvidence?.schemaVersion === "positioncrew.termix-runtime-rotations.v1" &&
      runtimeEvidence.agentId ===
        aacpReadiness.marketplace.dedicatedFlagship.agentId &&
      runtimeEvidence.agentTokenId ===
        aacpReadiness.marketplace.dedicatedFlagship.agentTokenId &&
      runtimeEvidence.handle === aacpReadiness.marketplace.dedicatedFlagship.handle &&
      runtimeEvidence.verifiedRotationCount === rotations.length &&
      rotations.length >= 3,
    "Dedicated runtime rotation evidence is missing or unbound",
  );
  assert(
    archiveAttestation?.provider === "GITHUB_ARTIFACT_ATTESTATIONS" &&
      archiveAttestation.predicateType === "https://slsa.dev/provenance/v1" &&
      archiveAttestation.signerWorkflow ===
        "dolepee/positioncrew/.github/workflows/production-smoke.yml" &&
      archiveAttestation.event === "workflow_dispatch" &&
      archiveAttestation.conclusion === "success" &&
      archiveAttestation.runnerEnvironment === "github-hosted" &&
      archiveAttestation.subjectCount === rotations.length + 1 &&
      archiveAttestation.runUrl ===
        `https://github.com/dolepee/positioncrew/actions/runs/${archiveAttestation.runId}`,
    "Runtime archive attestation metadata is missing or unbound",
  );
  const attestationBundlePath = resolve(
    repositoryRoot,
    archiveAttestation.bundlePath,
  );
  const attestationBundle = await readFile(attestationBundlePath);
  assert(
    createHash("sha256").update(attestationBundle).digest("hex") ===
      archiveAttestation.bundleSha256,
    "Runtime archive attestation bundle failed digest verification",
  );
  const rotationManifestPath = resolve(
    repositoryRoot,
    archiveAttestation.rotationManifestPath,
  );
  const rotationManifestBytes = await readFile(rotationManifestPath);
  assert(
    createHash("sha256").update(rotationManifestBytes).digest("hex") ===
      archiveAttestation.rotationManifestSha256,
    "Runtime rotation-event manifest failed digest verification",
  );
  const rotationManifest = JSON.parse(rotationManifestBytes.toString("utf8"));
  assert(
    rotationManifest.schemaVersion ===
      "positioncrew.termix-runtime-rotation-events.v1" &&
      rotationManifest.network === runtimeEvidence.network &&
      rotationManifest.chainId === runtimeEvidence.chainId &&
      rotationManifest.service === runtimeEvidence.service &&
      rotationManifest.role === runtimeEvidence.role &&
      rotationManifest.agentId === runtimeEvidence.agentId &&
      rotationManifest.agentTokenId === runtimeEvidence.agentTokenId &&
      rotationManifest.runtimeInstance === runtimeEvidence.runtimeInstance &&
      rotationManifest.eventName === runtimeEvidence.eventName &&
      rotationManifest.redactedJournalEventCanonicalization ===
        runtimeEvidence.redactedJournalEventCanonicalization &&
      rotationManifest.rotations?.length === rotations.length &&
      rotationManifest.rotations.every((manifestRotation, index) => {
        const rotation = rotations[index];
        return (
          manifestRotation.sequence === rotation.sequence &&
          manifestRotation.completedAt === rotation.completedAt &&
          manifestRotation.expiresAt === rotation.expiresAt &&
          manifestRotation.rotated === rotation.rotated &&
          manifestRotation.restarted === rotation.restarted &&
          manifestRotation.redactedJournalEventSha256 ===
            rotation.redactedJournalEventSha256
        );
      }),
    "Runtime rotations do not match the signed event manifest",
  );
  const attestationOutput = execFileSync(
    "gh",
    [
      "attestation",
      "verify",
      resolve(repositoryRoot, rotations[0].onlineObservation.artifact.archivePath),
      "--bundle",
      attestationBundlePath,
      "--repo",
      "dolepee/positioncrew",
      "--signer-workflow",
      archiveAttestation.signerWorkflow,
      "--source-digest",
      archiveAttestation.sourceCommit,
      "--deny-self-hosted-runners",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...(process.env.GITHUB_TOKEN && !process.env.GH_TOKEN
          ? { GH_TOKEN: process.env.GITHUB_TOKEN }
          : {}),
      },
      maxBuffer: 2_000_000,
      timeout: 90_000,
    },
  );
  const attestationResults = JSON.parse(attestationOutput);
  assert(
    Array.isArray(attestationResults) && attestationResults.length === 1,
    "Expected exactly one verified runtime archive attestation",
  );
  const attestationResult = attestationResults[0].verificationResult;
  const attestationCertificate = attestationResult.signature?.certificate;
  const attestationStatement = attestationResult.statement;
  const expectedSubjects = [
    ...rotations.map((rotation) => ({
      name: basename(rotation.onlineObservation.artifact.archivePath),
      sha256: rotation.onlineObservation.artifact.archiveSha256,
    })),
    {
      name: basename(archiveAttestation.rotationManifestPath),
      sha256: archiveAttestation.rotationManifestSha256,
    },
  ]
    .sort((left, right) => left.name.localeCompare(right.name));
  const attestedSubjects = (attestationStatement?.subject ?? [])
    .map((subject) => ({ name: subject.name, sha256: subject.digest?.sha256 }))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert(
    attestationStatement?.predicateType === archiveAttestation.predicateType &&
      JSON.stringify(attestedSubjects) === JSON.stringify(expectedSubjects) &&
      attestationCertificate?.githubWorkflowTrigger === archiveAttestation.event &&
      attestationCertificate?.githubWorkflowSHA === archiveAttestation.sourceCommit &&
      attestationCertificate?.githubWorkflowRef === archiveAttestation.sourceRef &&
      attestationCertificate?.githubWorkflowRepository === "dolepee/positioncrew" &&
      attestationCertificate?.runnerEnvironment ===
        archiveAttestation.runnerEnvironment &&
      attestationCertificate?.sourceRepositoryDigest ===
        archiveAttestation.sourceCommit &&
      attestationCertificate?.runInvocationURI ===
        `${archiveAttestation.runUrl}/attempts/${archiveAttestation.runAttempt}` &&
      attestationStatement?.predicate?.runDetails?.metadata?.invocationId ===
        `${archiveAttestation.runUrl}/attempts/${archiveAttestation.runAttempt}` &&
      attestationResult.verifiedTimestamps?.length > 0,
    "Runtime archive attestation does not match its pinned workflow provenance",
  );
  assert(
    rotations.every(
      (rotation, index) =>
        rotation.sequence === index + 1 &&
        rotation.rotated === true &&
        rotation.restarted === true &&
        /^[0-9a-f]{64}$/.test(rotation.redactedJournalEventSha256) &&
        createHash("sha256")
          .update(
            JSON.stringify({
              at: rotation.completedAt,
              event: runtimeEvidence.eventName,
              agentId: runtimeEvidence.agentId,
              runtimeInstance: runtimeEvidence.runtimeInstance,
              rotated: rotation.rotated,
              restarted: rotation.restarted,
              expiresAt: rotation.expiresAt,
            }),
          )
          .digest("hex") === rotation.redactedJournalEventSha256 &&
        Date.parse(rotation.expiresAt) > Date.parse(rotation.completedAt) &&
        Date.parse(rotation.onlineObservation.observedAt) >
          Date.parse(rotation.completedAt) &&
        Date.parse(rotation.onlineObservation.observedAt) <
          Date.parse(rotation.expiresAt) &&
        (index === rotations.length - 1 ||
          Date.parse(rotation.onlineObservation.observedAt) <
            Date.parse(rotations[index + 1].completedAt)) &&
        rotation.onlineObservation.a2aStatus === "ONLINE" &&
        rotation.onlineObservation.status === "ONLINE_AND_LISTED" &&
        rotation.onlineObservation.githubRun.event === "schedule" &&
        rotation.onlineObservation.githubRun.status === "completed" &&
        rotation.onlineObservation.githubRun.conclusion === "success" &&
        rotation.onlineObservation.githubRun.headBranch === "main" &&
        rotation.onlineObservation.url ===
          `https://github.com/dolepee/positioncrew/actions/runs/${rotation.onlineObservation.runId}` &&
        rotation.onlineObservation.artifact.name ===
          `positioncrew-production-health-${rotation.onlineObservation.runId}` &&
        rotation.onlineObservation.artifact.archivePath ===
          `evidence/termix-runtime-rotation-artifacts/${rotation.onlineObservation.runId}.zip` &&
        rotation.onlineObservation.healthReport.aacpGeneratedAt ===
          rotation.onlineObservation.observedAt &&
        Date.parse(rotation.onlineObservation.healthReport.checkedAt) <=
          Date.parse(rotation.onlineObservation.observedAt) &&
        Date.parse(rotation.onlineObservation.healthReport.completedAt) >=
          Date.parse(rotation.onlineObservation.observedAt) &&
        (index === 0 ||
          (Date.parse(rotation.completedAt) >
            Date.parse(rotations[index - 1].completedAt) &&
            Date.parse(rotation.expiresAt) >
              Date.parse(rotations[index - 1].expiresAt))),
    ),
    "Dedicated runtime rotations are not ordered verified completion events",
  );
  for (const rotation of rotations) {
    const observation = rotation.onlineObservation;
    const artifactEvidence = observation.artifact;
    const reportEvidence = observation.healthReport;
    const archive = await readFile(resolve(repositoryRoot, artifactEvidence.archivePath));
    assert(
      archive.length === artifactEvidence.sizeBytes &&
        createHash("sha256").update(archive).digest("hex") ===
          artifactEvidence.archiveSha256,
      `Preserved artifact ZIP for run ${observation.runId} failed digest verification`,
    );
    const reportBuffer = extractZipEntry(archive, artifactEvidence.reportFileName);
    assert(
      createHash("sha256").update(reportBuffer).digest("hex") ===
        artifactEvidence.reportSha256,
      `Health report for run ${observation.runId} failed digest verification`,
    );
    const report = JSON.parse(reportBuffer.toString("utf8"));
    const dedicatedFlagship = report.aacpReadiness?.marketplace?.dedicatedFlagship;
    assert(
      report.schemaVersion === reportEvidence.schemaVersion &&
        report.baseUrl === reportEvidence.baseUrl &&
        report.checkedAt === reportEvidence.checkedAt &&
        report.completedAt === reportEvidence.completedAt &&
        report.status === reportEvidence.status &&
        report.error === null &&
        report.aacpReadiness?.generatedAt === reportEvidence.aacpGeneratedAt &&
        report.aacpReadiness.generatedAt === observation.observedAt &&
        dedicatedFlagship?.agentId === runtimeEvidence.agentId &&
        dedicatedFlagship?.agentTokenId === runtimeEvidence.agentTokenId &&
        dedicatedFlagship?.listingStatus === observation.listingStatus &&
        dedicatedFlagship?.a2aStatus === observation.a2aStatus &&
        dedicatedFlagship?.status === observation.status,
      `Health report for run ${observation.runId} does not prove the dedicated runtime observation`,
    );
  }
  const latestRotation = rotations.at(-1);
  assert(
    latestRotation &&
      Date.parse(runtimeEvidence.verifiedAt) >=
        Date.parse(latestRotation.onlineObservation.healthReport.completedAt),
    "Runtime rotation verification predates the latest health report",
  );
  assert(
    runtimeEvidence.boundaries
      .join(" ")
      .includes("do not establish continuous uptime"),
    "Rotation evidence overstates uptime",
  );
  assert(
    aacpReadiness.integration?.orderGuard?.status ===
      "STRICT_LOCAL_LIFECYCLE_IMPLEMENTED" &&
      aacpReadiness.integration.orderGuard.chainId === 56 &&
      aacpReadiness.integration.orderGuard.signerOnGuard === false &&
      aacpReadiness.integration.orderGuard.broadcastsTransactions === false &&
      aacpReadiness.integration.orderGuard.abiDecodedIntentBinding === true &&
      aacpReadiness.integration.orderGuard.minedTransactionBinding === true &&
      aacpReadiness.integration.orderGuard.indexerReconciliationRequired === true &&
      aacpReadiness.integration.orderGuard.guardedActions?.join(",") ===
        "approveEscrow,createOrder,cancelPending,acceptOrder,submitDelivery,cancelExpired,releaseEscrow,requestRedo,claimAfterTimeout,openChallenge",
    "AACP order guard boundary changed",
  );
  assert(
    aacpReadiness.integration?.lifecycle?.join(",") ===
      "WALLET_SESSION,AGENT_PREPARE_MINT_INDEX,LISTING_CREATE_PUBLISH,A2A_RUNTIME,CHECKOUT_APPROVE_CREATE,PENDING_OR_EXPIRED_CANCELLATION,PROVIDER_ACCEPT,ARTIFACT_REGISTER_SUBMIT,BUYER_RELEASE_REDO_DISPUTE_OR_TIMEOUT,INDEXER_RECONCILE",
    "AACP documented lifecycle changed",
  );
  assert(
    new Set(aacpReadiness.marketplace.providers.map((provider) => provider.handle)).size === 4 &&
      aacpReadiness.marketplace.providers.every((provider) =>
        provider.handle.startsWith("positioncrew-") && provider.handle.endsWith(".agent"),
      ),
    "AACP provider handles are missing or duplicated",
  );
  assert(
    aacpReadiness.boundaries?.join(" ").includes("does not claim"),
    "AACP readiness overstates paid production activity",
  );
  report.aacpReadiness = aacpReadiness;
  report.aacpRuntime = {
    requiredForCoreHealth: false,
    status: onlineAacpProviders.length === 4 ? "ONLINE" : "RUNTIME_PENDING",
    onlineProviderCount: onlineAacpProviders.length,
    requiredProviderCount: 4,
    dedicatedFlagshipStatus: aacpReadiness.marketplace.dedicatedFlagship.status,
    verifiedAutomaticRotations: runtimeEvidence.verifiedRotationCount,
    latestRotationAt: runtimeEvidence.latestCompletedAt,
    boundary:
      "TermiX integration is optional for the challenge. Expiring A2A presence is reported separately and never converted into continuous-uptime evidence.",
  };

  const marketplaceDelivery = await fetchJson(
    "marketplace-delivery-evidence",
    marketplace.marketplaceDeliveryEvidenceUrl,
  );
  assert(
    marketplaceDelivery.schemaVersion === "positioncrew.marketplace-invocation-evidence.v1",
    "Unexpected marketplace delivery evidence schema",
  );
  const { evidenceHash: _marketplaceEvidenceHash, ...marketplaceDeliveryBody } = marketplaceDelivery;
  assert(
    canonicalSha256(marketplaceDeliveryBody) === marketplaceDelivery.evidenceHash,
    "Marketplace delivery evidence commitment is invalid",
  );
  assert(
    marketplaceDelivery.protocolHash ===
      "sha256:4935a4d6a32291112a1f64911765429ca90e65aa9a8a2d966634833cced597e4",
    "Marketplace delivery evidence changed its precommitted protocol",
  );
  assert(
    marketplaceDelivery.aggregate?.plannedAttemptCount === 6 &&
      marketplaceDelivery.aggregate?.recordedAttemptCount === 6 &&
      marketplaceDelivery.aggregate?.successCount === 6 &&
      marketplaceDelivery.aggregate?.allAttemptsSucceeded === true,
    "Marketplace delivery evidence does not contain six successful retained attempts",
  );
  assert(
    marketplaceDelivery.records?.length === 6 &&
      marketplaceDelivery.records.every(
        (record, index) =>
          record.sequenceNumber === index + 1 &&
          record.success === true &&
          record.httpStatus === 200 &&
          record.observation?.jobState === "COMPLETED" &&
          record.observation?.jobHistory?.join(",") ===
            "CREATED,FUNDED,ASSIGNED,SUBMITTED,EVALUATED,COMPLETED",
      ),
    "Marketplace delivery records are missing, reordered, or incomplete",
  );
  assert(
    marketplaceDelivery.summaries?.length === 3 &&
      marketplaceDelivery.summaries.every(
        (summary) =>
          summary.attemptCount === 2 &&
          summary.successCount === 2 &&
          summary.outputHashesMatch === true &&
          summary.evaluationHashesMatch === true &&
          summary.medianElapsedMilliseconds > 0,
      ),
    "Marketplace delivery summaries are inconsistent",
  );
  report.marketplaceDeliveryEvidence = marketplaceDelivery;

  const advantagePublication = await fetchJson(
    "agent-advantage-publication",
    "/evidence/agent-advantage-status.json",
  );
  assert(
    advantagePublication.schemaVersion === "positioncrew.agent-advantage-publication.v1",
    "Unexpected Agent Advantage publication schema",
  );
  assert(advantagePublication.taskCount === 3, "Agent Advantage task count changed");
  if (advantagePublication.status === "PENDING_INDEPENDENT_BLIND_EVALUATION") {
    assert(advantagePublication.reportUrl === null, "Pending Agent Advantage status exposes a report URL");
    assert(advantagePublication.reportHash === null, "Pending Agent Advantage status exposes a report hash");
    assert(
      advantagePublication.supportedAdvantageCount === null,
      "Pending Agent Advantage status exposes a result",
    );
  } else {
    assert(advantagePublication.status === "PUBLISHED", "Unknown Agent Advantage publication state");
    assert(
      advantagePublication.reportUrl === "/evidence/agent-advantage/",
      "Published Agent Advantage report URL changed",
    );
    assert(
      Number.isInteger(advantagePublication.supportedAdvantageCount) &&
        advantagePublication.supportedAdvantageCount >= 0 &&
        advantagePublication.supportedAdvantageCount <= 3,
      "Published Agent Advantage result count is invalid",
    );
    assert(
      Number.isInteger(advantagePublication.agentBlindQualityScore) &&
        advantagePublication.agentBlindQualityScore >= 0 &&
        advantagePublication.agentBlindQualityScore <= 300,
      "Published Agent Advantage quality score is invalid",
    );
    const advantageReport = await fetchJson(
      "agent-advantage-report",
      "/evidence/agent-advantage/agent-advantage-report.json",
    );
    assert(
      advantageReport.schemaVersion === "positioncrew.agent-advantage-report.v4",
      "Unexpected Agent Advantage report schema",
    );
    assert(
      advantageReport.reportHash === advantagePublication.reportHash,
      "Published Agent Advantage report hash differs from its status record",
    );
    const { reportHash: _reportHash, ...reportBody } = advantageReport;
    assert(
      canonicalSha256(reportBody) === advantageReport.reportHash,
      "Published Agent Advantage report commitment is invalid",
    );
    assert(
      advantageReport.summary?.evidenceManifestHash === advantagePublication.evidenceManifestHash,
      "Published Agent Advantage evidence manifest differs from its status record",
    );
    assert(
      canonicalSha256(
        advantageReport.tasks.map((task) => ({
          benchmarkSlug: task.benchmarkSlug,
          evidenceManifestHash: task.evidenceManifestHash,
        })),
      ) === advantageReport.summary?.evidenceManifestHash,
      "Published Agent Advantage task manifests are not bound to the report summary",
    );
    assert(
      advantageReport.summary?.supportedAdvantageCount ===
        advantagePublication.supportedAdvantageCount,
      "Published Agent Advantage summary differs from its status record",
    );
    const attachedMarketplaceDelivery = await fetchJson(
      "agent-advantage-marketplace-delivery",
      "/evidence/agent-advantage/marketplace-invocation-evidence.json",
    );
    assert(
      attachedMarketplaceDelivery.evidenceHash ===
        advantageReport.summary?.marketplaceEvidenceHash &&
        attachedMarketplaceDelivery.protocolHash ===
          advantageReport.summary?.marketplaceProtocolHash &&
        attachedMarketplaceDelivery.aggregate?.successCount === 6,
      "Published Agent Advantage report has inconsistent marketplace delivery evidence",
    );
    const attachedCommerceLedger = await fetchJson(
      "agent-advantage-commerce-ledger",
      "/evidence/agent-advantage/erc8183-jobs.testnet.json",
    );
    assert(
      canonicalSha256(attachedCommerceLedger) ===
        advantageReport.trackRecord?.onchainTestnet?.ledgerHash &&
        attachedCommerceLedger.summary?.completedLifecycles ===
          advantageReport.trackRecord?.onchainTestnet?.completedLifecycles &&
        attachedCommerceLedger.summary?.fundedCompletedJobs ===
          advantageReport.trackRecord?.onchainTestnet?.fundedCompletedJobs &&
        attachedCommerceLedger.summary?.externalBuyerJobs === 0 &&
        attachedCommerceLedger.summary?.externalRevenue === "0",
      "Published Agent Advantage track record differs from its onchain ledger",
    );
    assert(
      advantageReport.tasks?.every(
        (task) =>
          task.marketplaceDelivery?.attemptCount === 2 &&
          task.marketplaceDelivery?.successCount === 2 &&
          task.marketplaceDelivery?.allAttemptsSucceeded === true &&
          task.marketplaceDelivery?.medianElapsedMilliseconds > 0,
      ),
      "Published Agent Advantage tasks omit marketplace delivery provenance",
    );
    const advantageHtml = await fetchText(
      "agent-advantage-report-html",
      advantagePublication.reportUrl,
    );
    assert(
      advantageHtml.includes("PositionCrew Agent Advantage Report") &&
        advantageHtml.includes(advantageReport.reportHash) &&
        !advantageHtml.includes("Synthetic Layout"),
      "Published Agent Advantage presentation is missing its title or commitment",
    );
  }
  const advantagePublicationApi = await fetchJson(
    "agent-advantage-publication-api",
    "/api/benchmarks/status",
  );
  assert(
    JSON.stringify(advantagePublicationApi) === JSON.stringify(advantagePublication),
    "Benchmark status API differs from the tracked Agent Advantage publication status",
  );
  report.agentAdvantagePublication = advantagePublication;

  const founderAdvantagePublication = await fetchJson(
    "founder-agent-advantage-publication",
    "/evidence/founder-agent-advantage-status.json",
  );
  assert(
    founderAdvantagePublication.schemaVersion ===
      "positioncrew.founder-agent-advantage-publication.v1",
    "Unexpected founder Agent Advantage publication schema",
  );
  assert(
    founderAdvantagePublication.taskCount === 3,
    "Founder Agent Advantage task count changed",
  );
  assert(
    founderAdvantagePublication.qualityMethod === "CANONICAL_EXACT_OUTPUT_PARITY" &&
      founderAdvantagePublication.qualityScore === null,
    "Founder comparison inferred a quality score instead of exact-output parity",
  );
  assert(
    founderAdvantagePublication.independent === false &&
      founderAdvantagePublication.blind === false,
    "Founder comparison changed its non-independent or non-blind boundary",
  );
  if (founderAdvantagePublication.status === "PENDING_FOUNDER_COMPARISON") {
    assert(
      founderAdvantagePublication.reportUrl === null &&
        founderAdvantagePublication.reportHash === null &&
        founderAdvantagePublication.evidenceManifestHash === null &&
        founderAdvantagePublication.publishedAt === null &&
        founderAdvantagePublication.exactOutputParityCount === null &&
        founderAdvantagePublication.recordedSpeedAdvantageCount === null,
      "Pending founder comparison exposes a report or result",
    );
  } else {
    assert(
      founderAdvantagePublication.status === "PUBLISHED",
      "Unknown founder Agent Advantage publication state",
    );
    assert(
      founderAdvantagePublication.reportUrl === "/evidence/agent-advantage-founder/",
      "Published founder Agent Advantage report URL changed",
    );
    assert(
      Number.isInteger(founderAdvantagePublication.exactOutputParityCount) &&
        founderAdvantagePublication.exactOutputParityCount >= 0 &&
        founderAdvantagePublication.exactOutputParityCount <= 3 &&
        Number.isInteger(founderAdvantagePublication.recordedSpeedAdvantageCount) &&
        founderAdvantagePublication.recordedSpeedAdvantageCount >= 0 &&
        founderAdvantagePublication.recordedSpeedAdvantageCount <= 3,
      "Published founder comparison counts are invalid",
    );
    const founderAdvantageReport = await fetchJson(
      "founder-agent-advantage-report",
      "/evidence/agent-advantage-founder/founder-agent-advantage-report.json",
    );
    assert(
      founderAdvantageReport.schemaVersion ===
        "positioncrew.founder-agent-advantage-report.v2",
      "Unexpected founder Agent Advantage report schema",
    );
    assert(
      founderAdvantageReport.reportHash === founderAdvantagePublication.reportHash,
      "Published founder Agent Advantage report hash differs from its status record",
    );
    const { reportHash: _founderReportHash, ...founderReportBody } = founderAdvantageReport;
    assert(
      canonicalSha256(founderReportBody) === founderAdvantageReport.reportHash,
      "Published founder Agent Advantage report commitment is invalid",
    );
    const founderAdvantageHtml = await fetchText(
      "founder-agent-advantage-report-html",
      founderAdvantagePublication.reportUrl,
    );
    assert(
      founderAdvantageHtml.includes("Founder-operated") &&
        founderAdvantageHtml.includes(founderAdvantageReport.reportHash),
      "Published founder comparison presentation omits its method or commitment",
    );
  }
  const founderAdvantagePublicationApi = await fetchJson(
    "founder-agent-advantage-publication-api",
    "/api/benchmarks/founder-comparison/status",
  );
  assert(
    JSON.stringify(founderAdvantagePublicationApi) ===
      JSON.stringify(founderAdvantagePublication),
    "Founder comparison status API differs from its tracked static publication status",
  );
  report.founderAgentAdvantagePublication = founderAdvantagePublication;

  const openApi = await fetchJson("openapi", marketplace.openApiUrl);
  assert(openApi.openapi === "3.1.0", "OpenAPI version is not 3.1.0");
  const requiredOpenApiOperations = [
    [
      "/api/evidence/external-comparisons/2026-08-24",
      "get",
      "getExternalComparisonSnapshot",
    ],
    [
      "/api/evidence/venus-testnet-native-supply/2026-08-24",
      "get",
      "getVenusTestnetNativeSupplyEvidence",
    ],
    [
      "/api/activations/venus-testnet-supply/status",
      "get",
      "getAltanaVenusActivationStatus",
    ],
    [
      "/api/activations/venus-testnet-supply",
      "post",
      "createAltanaVenusActivation",
    ],
    [
      "/api/activations/{activationId}",
      "get",
      "getAltanaVenusActivation",
    ],
    [
      "/api/activation-receipts/{receiptId}",
      "get",
      "getAltanaVenusActivationReceipt",
    ],
    [
      "/api/evidence/bounded-grid-forward-shadow",
      "get",
      "getBoundedGridForwardShadowLedger",
    ],
    [
      "/api/evidence/bounded-grid-forward-shadow/windows/{runId}",
      "get",
      "getBoundedGridForwardShadowWindow",
    ],
    ["/api/status", "get", "getSystemTelemetry"],
    ["/api/commerce/aacp", "get", "getAacpProductionReadiness"],
    ["/api/operations/production", "get", "getProductionTrackRecord"],
    ["/api/benchmarks/status", "get", "getBenchmarkPublicationStatus"],
    [
      "/api/benchmarks/founder-comparison/status",
      "get",
      "getFounderBenchmarkPublicationStatus",
    ],
    [
      "/api/benchmarks/marketplace-provenance",
      "get",
      "getMarketplaceInvocationEvidence",
    ],
    ["/api/benchmark-hires", "post", "createFreshMarketplaceHire"],
    ["/api/benchmark-hires/{hireId}", "get", "getFreshMarketplaceHire"],
    [
      "/api/benchmark-hires/{hireId}/jobs",
      "post",
      "runFreshMarketplaceHire",
    ],
    [
      "/api/benchmark-receipts/{receiptId}",
      "get",
      "getFreshMarketplaceReceipt",
    ],
    [
      "/api/providers/lending-rescue/jobs",
      "get",
      "getLendingRescueRequestFixture",
    ],
    [
      "/api/providers/lending-rescue/jobs",
      "post",
      "runLendingRescueRequest",
    ],
    [
      "/api/providers/lp-rebalance/jobs",
      "get",
      "getLpRebalanceRequestFixture",
    ],
    [
      "/api/providers/lp-rebalance/jobs",
      "post",
      "runLpRebalanceRequest",
    ],
    [
      "/api/providers/yield-optimization/jobs",
      "get",
      "getYieldOptimizationRequestFixture",
    ],
    [
      "/api/providers/yield-optimization/jobs",
      "post",
      "runYieldOptimizationRequest",
    ],
    [
      "/api/providers/bounded-grid/jobs",
      "get",
      "getBoundedGridRequestFixture",
    ],
    [
      "/api/providers/bounded-grid/jobs",
      "post",
      "runBoundedGridRequest",
    ],
    [
      "/api/provider-contract-preflight",
      "get",
      "getProviderContractPreflightTemplates",
    ],
    [
      "/api/provider-contract-preflight",
      "post",
      "runProviderContractPreflight",
    ],
    ["/api/wallets/{account}/venus", "get", "inspectVenusAccount"],
    ["/api/positions/pancake/{tokenId}", "get", "inspectPancakePosition"],
    ["/api/markets/venus/stable-yields", "get", "inspectVenusStableYields"],
    [
      "/api/markets/pancake/wbnb-usdt/grid",
      "get",
      "inspectPancakeGridMarket",
    ],
  ];
  for (const [path, method, operationId] of requiredOpenApiOperations) {
    assert(
      openApi.paths?.[path]?.[method]?.operationId === operationId,
      `OpenAPI omits required operation ${operationId} at ${method.toUpperCase()} ${path}`,
    );
  }
  assert(
    openApi.paths?.["/api/operations/production"]?.get?.operationId ===
      "getProductionTrackRecord",
    "OpenAPI omits the production verification record",
  );
  assert(
    openApi.paths?.["/api/benchmarks/status"]?.get?.operationId ===
      "getBenchmarkPublicationStatus",
    "OpenAPI omits the benchmark publication status",
  );
  assert(
    openApi.paths?.["/api/benchmarks/founder-comparison/status"]?.get?.operationId ===
      "getFounderBenchmarkPublicationStatus",
    "OpenAPI omits the founder benchmark publication status",
  );
  assert(
    openApi.paths?.["/api/benchmarks/marketplace-provenance"]?.get?.operationId ===
      "getMarketplaceInvocationEvidence",
    "OpenAPI omits marketplace delivery evidence",
  );
  assert(
    openApi.paths?.["/api/commerce/aacp"]?.get?.operationId ===
      "getAacpProductionReadiness",
    "OpenAPI omits TermiX production readiness",
  );
  assert(
    openApi.paths?.["/api/markets/pancake/wbnb-usdt/grid"]?.get?.operationId ===
      "inspectPancakeGridMarket",
    "OpenAPI omits the live Pancake grid probe",
  );
  assert(
    openApi.paths?.["/api/markets/venus/stable-yields"]?.get?.operationId ===
      "inspectVenusStableYields",
    "OpenAPI omits the live Venus yield probe",
  );
  assert(
    openApi.paths?.["/api/positions/pancake/{tokenId}"]?.get?.operationId ===
      "inspectPancakePosition",
    "OpenAPI omits the live Pancake position probe",
  );

  const shadowGridLedger = await fetchJson(
    "bounded-grid-forward-shadow-ledger",
    "/api/evidence/bounded-grid-forward-shadow",
  );
  report.shadowGridLedger = await verifyShadowGridLedger(shadowGridLedger);

  const productionRecord = await fetchJson(
    "production-track-record",
    marketplace.operatingRecordUrl,
  );
  assert(
    productionRecord.schemaVersion === "positioncrew.production-track-record.v1",
    "Unexpected production track-record schema",
  );
  assert(
    productionRecord.epoch?.schemaVersion === "positioncrew.production-monitor-epoch.v1",
    "Production track record has no fixed epoch",
  );
  assert(
    productionRecord.epoch?.startedAt === "2026-08-13T04:00:00.000Z",
    "Production monitoring epoch changed",
  );
  assert(
    productionRecord.epoch?.aggregation?.coverage === "LATEST_100_SCHEDULED_RUNS",
    "Production track record changed its disclosed aggregation window",
  );
  assert(
    productionRecord.epoch?.aggregation?.excludeEvents?.includes("push") &&
      productionRecord.epoch?.aggregation?.excludeEvents?.includes("workflow_dispatch"),
    "Production track record no longer excludes non-scheduled runs",
  );
  assert(Array.isArray(productionRecord.runs), "Production track-record runs are missing");
  assert(
    productionRecord.summary?.observedRunCount === productionRecord.runs.length,
    "Production track-record observed count is inconsistent",
  );
  if (productionRecord.status === "SOURCE_UNAVAILABLE") {
    assert(
      productionRecord.source?.sourceStatus === "UNAVAILABLE" &&
        productionRecord.summary?.totalScheduledRunsSinceEpoch === null &&
        productionRecord.summary?.rollingPassRatePct === null,
      "Unavailable production source inferred a reliability result",
    );
  } else {
    assert(
      productionRecord.source?.sourceStatus === "AVAILABLE",
      "Available production record has the wrong source state",
    );
    assert(
      Number.isInteger(productionRecord.summary?.totalScheduledRunsSinceEpoch) &&
        productionRecord.summary.totalScheduledRunsSinceEpoch >= productionRecord.runs.length,
      "Production track-record total count is invalid",
    );
    assert(
      productionRecord.summary.completedRuns + productionRecord.summary.pendingRuns ===
        productionRecord.runs.length,
      "Production track-record completion counts are inconsistent",
    );
    assert(
      productionRecord.summary.successfulRuns + productionRecord.summary.unsuccessfulRuns ===
        productionRecord.summary.completedRuns,
      "Production track-record conclusions are inconsistent",
    );
    assert(
      new Set(productionRecord.runs.map((run) => run.runId)).size ===
        productionRecord.runs.length,
      "Production track record contains duplicate runs",
    );
    assert(
      productionRecord.runs.every(
        (run) => Date.parse(run.createdAt) >= Date.parse(productionRecord.epoch.startedAt),
      ),
      "Production track record includes a run before its epoch",
    );
  }
  report.productionTrackRecord = productionRecord;

  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const zeroVenus = await fetchJson(
    "venus-zero-position",
    `/api/wallets/${zeroAddress}/venus`,
  );
  assert(
    zeroVenus.schemaVersion === "positioncrew.venus-account-probe.v1",
    "Unexpected Venus account probe schema",
  );
  assert(zeroVenus.state === "NO_POSITION", "Zero address unexpectedly has a Venus position");
  assert(zeroVenus.position?.debtValueUsd === "0", "Zero address Venus debt is nonzero");
  assert(
    zeroVenus.position?.collateralValueUsd === "0",
    "Zero address Venus collateral is nonzero",
  );
  assert(
    zeroVenus.account === zeroAddress &&
      zeroVenus.rescueRequest?.account === zeroAddress &&
      zeroVenus.rescueRequest?.chainId === 56,
    "Zero-position refusal request is not bound to the requested account and chain",
  );
  assert(
    zeroVenus.rescueRequest?.position?.collateral?.length === 0 &&
      zeroVenus.rescueRequest?.position?.debt?.length === 0,
    "Zero-position refusal request unexpectedly contains collateral or debt",
  );
  assert(
    /^https:\/\/bscscan\.com\/block\/\d+$/.test(zeroVenus.source?.explorerUrl ?? ""),
    "Venus account probe is not linked to its pinned BSC block",
  );

  const providerContractTemplates = await fetchJson(
    "provider-contract-preflight-templates",
    "/api/provider-contract-preflight",
  );
  assert(
    providerContractTemplates.schemaVersion === "positioncrew.provider-contract-preflight-templates.v1",
    "Unexpected provider contract template schema",
  );
  assert(
    Object.keys(providerContractTemplates.templates ?? {}).length === 4,
    "Provider contract preflight does not expose four category templates",
  );
  const providerContractServices = [
    "LENDING_RESCUE",
    "LP_REBALANCE",
    "YIELD_OPTIMIZATION",
    "BOUNDED_GRID",
  ];
  const providerContractPasses = {};
  for (const service of providerContractServices) {
    const packet = providerContractTemplates.templates[service];
    const pass = await postJson(
      `provider-contract-preflight-pass-${service.toLowerCase()}`,
      "/api/provider-contract-preflight",
      packet,
    );
    assert(pass.outcome === "CONTRACT_PASS", `${service} provider packet did not pass`);
    assert(pass.service === service, `${service} provider packet returned the wrong service`);
    assert(
      pass.checks?.filter((check) => check.status === "NOT_PROVEN").length === 11,
      `${service} provider packet omits explicit NOT_PROVEN boundaries`,
    );
    const invalid = structuredClone(packet);
    invalid.refusalDeliverable.status = "ACTIONABLE";
    const fail = await postJson(
      `provider-contract-preflight-fail-${service.toLowerCase()}`,
      "/api/provider-contract-preflight",
      invalid,
    );
    assert(fail.outcome === "CONTRACT_FAIL", `${service} invalid provider packet did not fail closed`);
    assert(fail.resultHash !== pass.resultHash, `${service} mutation retained the passing result hash`);
    providerContractPasses[service] = pass;
  }
  const providerContractPacket = providerContractTemplates.templates.LENDING_RESCUE;
  const providerContractPass = providerContractPasses.LENDING_RESCUE;
  const providerContractRepeat = await postJson(
    "provider-contract-preflight-repeat",
    "/api/provider-contract-preflight",
    structuredClone(providerContractPacket),
  );
  assert(
    providerContractPass.resultHash === providerContractRepeat.resultHash &&
      providerContractPass.inputHash === providerContractRepeat.inputHash,
    "Provider preflight is not deterministic",
  );
  report.providerContractPreflight = {
    outcome: providerContractPass.outcome,
    service: providerContractPass.service,
    inputHash: providerContractPass.inputHash,
    resultHash: providerContractPass.resultHash,
    notProvenCount: providerContractPass.checks.filter((check) => check.status === "NOT_PROVEN").length,
    claimBoundary: providerContractPass.claimBoundary,
    perService: Object.fromEntries(providerContractServices.map((service) => [service, {
      outcome: providerContractPasses[service].outcome,
      resultHash: providerContractPasses[service].resultHash,
    }])),
  };

  const pancakeGrid = await fetchJson(
    "pancake-grid-market",
    "/api/markets/pancake/wbnb-usdt/grid",
  );
  assert(
    pancakeGrid.schemaVersion === "positioncrew.pancake-grid-probe.v1",
    "Unexpected Pancake grid probe schema",
  );
  assert(pancakeGrid.state === "READY", "Pancake grid probe is not ready");
  assert(Number(pancakeGrid.market?.spotPriceUsd) > 0, "Pancake grid spot price is invalid");
  assert(
    Number(pancakeGrid.market?.activeLiquidityUsd) > 0,
    "Pancake grid active liquidity is invalid",
  );
  assert(
    Number(pancakeGrid.market?.reserveValueUsd) > 0,
    "Pancake grid reserve value is invalid",
  );
  assert(
    pancakeGrid.market?.volatilitySampleCount >= 3,
    "Pancake grid volatility has too few samples",
  );
  assert(
    /^https:\/\/bscscan\.com\/block\/\d+$/.test(pancakeGrid.source?.explorerUrl ?? ""),
    "Pancake grid probe is not linked to its pinned BSC block",
  );
  assert(
    pancakeGrid.gridRequest?.marketState?.sourceId === pancakeGrid.gridRequest?.sources?.[0]?.sourceId,
    "Pancake grid request source binding is inconsistent",
  );
  const pancakeGridJob = await postJson(
    "pancake-grid-live-job",
    "/api/providers/bounded-grid/jobs",
    { request: pancakeGrid.gridRequest },
  );
  assert(
    pancakeGridJob.evidenceMode === "CALLER_SUPPLIED_OBSERVATIONS",
    "Pancake grid job changed its evidence mode",
  );
  assert(pancakeGridJob.result?.job?.state === "COMPLETED", "Pancake grid job did not complete");
  assert(pancakeGridJob.result?.evaluation?.score === 100, "Pancake grid job score is not 100/100");

  const pancakePosition = await fetchJson(
    "pancake-lp-position",
    `/api/positions/pancake/${referencePancakePositionId}`,
    {
      retryDelayForResponse: (response, body) =>
        isTransientBscRpcExhaustion(response, body) ? 20_000 : undefined,
    },
  );
  assert(
    pancakePosition.schemaVersion === "positioncrew.pancake-position-probe.v1",
    "Unexpected Pancake position probe schema",
  );
  assert(pancakePosition.state === "READY", "Pancake position probe is not ready");
  assert(
    pancakePosition.position?.tokenId === referencePancakePositionId,
    "Pancake position probe returned the wrong NFT",
  );
  assert(Number(pancakePosition.position?.positionValueUsd) > 0, "Pancake position value is invalid");
  assert(Number(pancakePosition.position?.uncollectedFeesUsd) >= 0, "Pancake position fees are invalid");
  assert(
    Number(pancakePosition.market?.measurementWindowSeconds) > 0,
    "Pancake position has no measured swap window",
  );
  assert(
    /^https:\/\/bscscan\.com\/block\/\d+$/.test(pancakePosition.source?.explorerUrl ?? ""),
    "Pancake position probe is not linked to its pinned BSC block",
  );
  assert(
    pancakePosition.lpRequest?.marketState?.sourceId === pancakePosition.lpRequest?.sources?.[0]?.sourceId,
    "Pancake position request source binding is inconsistent",
  );
  const pancakePositionJob = await postJson(
    "pancake-lp-live-job",
    "/api/providers/lp-rebalance/jobs",
    { request: pancakePosition.lpRequest },
  );
  assert(
    pancakePositionJob.evidenceMode === "CALLER_SUPPLIED_OBSERVATIONS",
    "Pancake position job changed its evidence mode",
  );
  assert(pancakePositionJob.result?.job?.state === "COMPLETED", "Pancake position job did not complete");
  assert(pancakePositionJob.result?.evaluation?.score === 100, "Pancake position job score is not 100/100");

  const venusYield = await fetchJson(
    "venus-yield-market",
    "/api/markets/venus/stable-yields",
  );
  assert(
    venusYield.schemaVersion === "positioncrew.venus-yield-probe.v1",
    "Unexpected Venus yield probe schema",
  );
  assert(venusYield.state === "READY", "Venus yield probe is not ready");
  assert(venusYield.markets?.length === 4, "Venus yield probe does not cover four stable markets");
  assert(
    new Set(venusYield.markets.map((market) => market.symbol)).size === 4,
    "Venus yield markets are duplicated",
  );
  assert(
    venusYield.markets.every(
      (market) => market.baseSupplyApyBps >= 0 && Number(market.availableLiquidityUsd) > 0,
    ),
    "Venus yield probe contains an invalid APY or available-cash value",
  );
  assert(
    Number(venusYield.source?.measuredSecondsPerBlock) > 0,
    "Venus yield probe has no measured block interval",
  );
  assert(
    /^https:\/\/bscscan\.com\/block\/\d+$/.test(venusYield.source?.explorerUrl ?? ""),
    "Venus yield probe is not linked to its pinned BSC block",
  );
  assert(
    venusYield.yieldRequest?.opportunities?.every(
      (opportunity) => opportunity.sourceId === venusYield.yieldRequest?.sources?.[0]?.sourceId,
    ),
    "Venus yield request source binding is inconsistent",
  );
  const venusYieldJob = await postJson(
    "venus-yield-live-job",
    "/api/providers/yield-optimization/jobs",
    { request: venusYield.yieldRequest },
  );
  assert(
    venusYieldJob.evidenceMode === "CALLER_SUPPLIED_OBSERVATIONS",
    "Venus yield job changed its evidence mode",
  );
  assert(venusYieldJob.result?.job?.state === "COMPLETED", "Venus yield job did not complete");
  assert(venusYieldJob.result?.evaluation?.score === 100, "Venus yield job score is not 100/100");

  const currentPersistedHireDefinitions = [
    {
      service: "BOUNDED_GRID",
      benchmarkSlug: "bounded-grid",
      providerSlug: "bounded-grid",
      requestKey: "gridRequest",
      protocol: "PancakeSwap V3 bounded grid policy",
      sourceId: (blockNumber) => `pancake-v3-mainnet-block-${blockNumber}`,
      validRequestId: (requestId, blockNumber) => requestId === `pancake-grid-${blockNumber}`,
      probe: pancakeGrid,
    },
    {
      service: "LP_REBALANCE",
      benchmarkSlug: "lp-rebalance",
      providerSlug: "lp-rebalance",
      requestKey: "lpRequest",
      protocol: "PancakeSwap V3 position analysis",
      sourceId: (blockNumber) => `pancake-position-mainnet-block-${blockNumber}`,
      validRequestId: (requestId, blockNumber) =>
        new RegExp(`^pancake-position-[1-9]\\d*-${blockNumber}$`).test(requestId),
      probe: pancakePosition,
    },
    {
      service: "YIELD_OPTIMIZATION",
      benchmarkSlug: "yield-optimization",
      providerSlug: "yield-optimization",
      requestKey: "yieldRequest",
      protocol: "Venus Core Pool stablecoin supply",
      sourceId: (blockNumber) => `venus-yield-mainnet-block-${blockNumber}`,
      validRequestId: (requestId, blockNumber) => requestId === `venus-yield-${blockNumber}`,
      probe: venusYield,
    },
    {
      service: "LENDING_RESCUE",
      benchmarkSlug: "lending-rescue",
      providerSlug: "lending-rescue",
      requestKey: "rescueRequest",
      protocol: "Venus Classic",
      sourceId: (blockNumber) => `venus-mainnet-block-${blockNumber}`,
      validRequestId: (requestId) => typeof requestId === "string" && requestId.length > 0,
      probe: zeroVenus,
    },
  ];
  const currentPersistedHires = [];
  for (const definition of currentPersistedHireDefinitions) {
    currentPersistedHires.push(
      await verifyCurrentPersistedHire(definition, definition.probe),
    );
  }
  assert(
    new Set(currentPersistedHires.map((hire) => hire.service)).size === 4,
    "Current persisted hires do not cover four unique services",
  );
  assert(
    new Set(currentPersistedHires.map((hire) => hire.hireId)).size === 4 &&
      new Set(currentPersistedHires.map((hire) => hire.receiptId)).size === 4,
    "Current persisted hire or receipt IDs are duplicated",
  );
  report.currentPersistedHires = {
    evidenceMode: "CURRENT_BLOCK_PINNED",
    relationship: "OPERATOR_PRODUCTION_MONITOR",
    executionBoundary: "READ_ONLY_RECOMMENDATION_ONLY",
    claimBoundary:
      "Verifies current request binding, durable execution, and public receipt reload. It does not prove an external buyer, payment, revenue, autonomous execution, strategy return, or historical performance.",
    hires: currentPersistedHires,
  };

  for (const entry of marketplace.providers) {
    assert(expectedServices.has(entry.service), `Unexpected provider service: ${entry.service}`);
    const identity = await verifyIdentity(entry);
    const manifest = await fetchJson(`${entry.service}:manifest`, entry.manifestUrl);
    assert(manifest.provider?.service === entry.service, `${entry.service} manifest mismatch`);
    assert(manifest.identity?.agentId === identity.agentId, `${entry.service} manifest identity mismatch`);
    assert(manifest.provider?.relationship === "FIRST_PARTY", `${entry.service} ownership is unclear`);
    assert(
      manifest.commerce?.settlement === "IN_MEMORY_CONFORMANCE",
      `${entry.service} settlement boundary changed unexpectedly`,
    );
    assert(
      manifest.commerce?.adapter === "AACP_PRODUCTION_RUNTIME_PENDING" &&
        new URL(manifest.commerce?.readinessUrl).origin === baseUrl.origin,
      `${entry.service} AACP readiness binding changed unexpectedly`,
    );
    assert(
      manifest.pricing?.judgeTrial?.amount === "0" &&
        manifest.pricing?.judgeTrial?.walletRequired === false &&
        manifest.pricing?.judgeTrial?.settlement === "NO_PAYMENT",
      `${entry.service} no-wallet trial boundary changed unexpectedly`,
    );

    const health = await fetchJson(`${entry.service}:health`, manifest.transport?.health?.url);
    assert(health.status === "OPERATIONAL", `${entry.service} is ${health.status}`);
    assert(health.conformance?.score === 100, `${entry.service} conformance is not 100/100`);

    const requestSchema = await fetchJson(
      `${entry.service}:request-schema`,
      manifest.transport?.schemas?.request,
    );
    const deliverableSchema = await fetchJson(
      `${entry.service}:deliverable-schema`,
      manifest.transport?.schemas?.deliverable,
    );
    assert(requestSchema.type === "object", `${entry.service} request schema is invalid`);
    assert(deliverableSchema.type === "object", `${entry.service} deliverable schema is invalid`);

    const job = await fetchJson(`${entry.service}:job`, manifest.transport?.job?.url);
    assert(job.result?.request?.service === entry.service, `${entry.service} job routed incorrectly`);
    assert(job.result?.job?.state === "COMPLETED", `${entry.service} job did not complete`);
    assert(job.result?.evaluation?.score === 100, `${entry.service} job score is not 100/100`);
    assert(job.evidenceMode === "FROZEN_BSC_TEST_FIXTURE", `${entry.service} GET job is not locked`);
    assert(job.receipt?.mode === "PUBLIC_REPRODUCIBLE", `${entry.service} GET receipt is not public`);

    const monitorStartedAt = new Date();
    const interactiveRequest = buildMonitorRequest(job.result.request, monitorStartedAt);
    const interactiveJob = await postJson(
      `${entry.service}:interactive-job`,
      manifest.transport?.job?.url,
      { request: interactiveRequest },
    );
    assert(
      interactiveJob.evidenceMode === "CALLER_SUPPLIED_OBSERVATIONS",
      `${entry.service} default POST did not use caller-supplied observations`,
    );
    assert(interactiveJob.result?.job?.state === "COMPLETED", `${entry.service} interactive job did not complete`);
    assert(interactiveJob.result?.evaluation?.score === 100, `${entry.service} interactive score is not 100/100`);
    assert(interactiveJob.benchmarkLock === null, `${entry.service} interactive job exposed a benchmark lock`);
    assert(interactiveJob.receipt?.mode === "SESSION_EMBEDDED", `${entry.service} interactive receipt is not session-only`);
    assert(interactiveJob.receipt?.path === null, `${entry.service} interactive job exposed a public receipt path`);
    assert(
      Date.parse(interactiveJob.result?.deliverable?.expiresAt) > monitorStartedAt.getTime(),
      `${entry.service} interactive result is already expired`,
    );
    assert(
      Date.parse(interactiveJob.result?.deliverable?.expiresAt) <= Date.parse(interactiveRequest.deadline),
      `${entry.service} interactive expiry exceeds the buyer deadline`,
    );

    const lockedJob = await postJson(
      `${entry.service}:locked-job`,
      manifest.transport?.job?.url,
      { mode: "FROZEN_FIXTURE", request: job.result.request },
    );
    assert(lockedJob.evidenceMode === "FROZEN_BSC_TEST_FIXTURE", `${entry.service} locked POST changed mode`);
    assert(
      lockedJob.result?.evaluation?.evaluationHash === job.result.evaluation.evaluationHash,
      `${entry.service} locked POST changed the evaluation hash`,
    );
    assert(lockedJob.receipt?.path === job.receipt.path, `${entry.service} locked POST changed the receipt path`);

    report.providers.push({
      providerId: manifest.provider.providerId,
      service: entry.service,
      health: health.status,
      conformanceScore: health.conformance.score,
      jobState: job.result.job.state,
      evaluationHash: job.result.evaluation.evaluationHash,
      identity,
    });
  }

  assert(
    new Set(report.providers.map((provider) => provider.service)).size === 4,
    "Provider services are duplicated",
  );

  const commerceLedger = await fetchJson("erc8183-ledger", "/api/commerce/erc8183");
  assert(
    commerceLedger.schemaVersion === "positioncrew.erc8183-testnet-ledger.v1",
    "Unexpected ERC-8183 ledger schema",
  );
  assert(commerceLedger.summary.completedLifecycles === 7, "ERC-8183 lifecycle count changed");
  assert(commerceLedger.summary.fundedCompletedJobs === 6, "ERC-8183 funded count changed");
  assert(commerceLedger.summary.externalBuyerJobs === 0, "ERC-8183 operator boundary changed");
  assert(commerceLedger.jobs.length === 7, "ERC-8183 ledger must contain seven jobs");
  assert(
    new Set(
      commerceLedger.jobs
        .filter((job) => job.runType === "FUNDED_CATEGORY_RECEIPT")
        .map((job) => job.service),
    ).size === 4,
    "ERC-8183 flagship receipts do not cover all four services",
  );

  const commerceAddress = commerceLedger.protocol.commerce;
  const routerAddress = commerceLedger.protocol.router;
  const policyAddress = commerceLedger.protocol.policy;
  const [paymentToken, platformFeeBps, policyWhitelisted, disputeWindow, voteQuorum] =
    await Promise.all([
      identityClient.readContract({ address: commerceAddress, abi: erc8183CommerceAbi, functionName: "paymentToken" }),
      identityClient.readContract({ address: commerceAddress, abi: erc8183CommerceAbi, functionName: "platformFeeBP" }),
      identityClient.readContract({ address: routerAddress, abi: erc8183RouterAbi, functionName: "policyWhitelist", args: [policyAddress] }),
      identityClient.readContract({ address: policyAddress, abi: erc8183PolicyAbi, functionName: "disputeWindow" }),
      identityClient.readContract({ address: policyAddress, abi: erc8183PolicyAbi, functionName: "voteQuorum" }),
    ]);
  assert(paymentToken.toLowerCase() === commerceLedger.protocol.paymentToken.toLowerCase(), "ERC-8183 payment token mismatch");
  assert(platformFeeBps === 0n, "ERC-8183 platform fee changed");
  assert(policyWhitelisted, "ERC-8183 policy is no longer whitelisted");
  assert(disputeWindow === 900n, "ERC-8183 dispute window changed");
  assert(voteQuorum === 1n, "ERC-8183 vote quorum changed");

  report.commerce = [];
  for (const ledgerJob of commerceLedger.jobs) {
    const startedAt = performance.now();
    const manifestUrl = new URL(ledgerJob.manifestUrl);
    assert(
      manifestUrl.origin === "https://positioncrew.dolepee.com",
      `ERC-8183 job ${ledgerJob.jobId} manifest is not on the canonical domain`,
    );
    const [onchainJob, registerReceipt, settleReceipt, manifest] = await Promise.all([
      identityClient.readContract({
        address: commerceAddress,
        abi: erc8183CommerceAbi,
        functionName: "getJob",
        args: [BigInt(ledgerJob.jobId)],
      }),
      identityClient.getTransactionReceipt({ hash: ledgerJob.transactions.register }),
      identityClient.getTransactionReceipt({ hash: ledgerJob.transactions.settle }),
      fetchJson(
        `erc8183-job-${ledgerJob.jobId}-manifest`,
        `${manifestUrl.pathname}${manifestUrl.search}`,
      ),
    ]);
    // APEX clears jobPolicy after settlement, so policy provenance lives in JobRegistered.
    const registrationEvents = parseEventLogs({
      abi: erc8183RouterAbi,
      eventName: "JobRegistered",
      logs: registerReceipt.logs,
    });
    assert(registerReceipt.status === "success", `ERC-8183 job ${ledgerJob.jobId} registration failed`);
    assert(registrationEvents.length === 1, `ERC-8183 job ${ledgerJob.jobId} registration event missing`);
    const registration = registrationEvents[0].args;
    checks.push({
      name: `erc8183-job-${ledgerJob.jobId}-chain`,
      url: bscTestnetRpc,
      status: 200,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    assert(onchainJob.status === 3, `ERC-8183 job ${ledgerJob.jobId} is not completed`);
    assert(
      onchainJob.client.toLowerCase() === commerceLedger.parties.client.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} client mismatch`,
    );
    assert(
      onchainJob.provider.toLowerCase() === commerceLedger.parties.provider.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} provider mismatch`,
    );
    assert(
      onchainJob.budget === BigInt(ledgerJob.budgetBaseUnits),
      `ERC-8183 job ${ledgerJob.jobId} budget mismatch`,
    );
    assert(
      onchainJob.deliverable.toLowerCase() === ledgerJob.manifestHash.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} onchain manifest mismatch`,
    );
    assert(
      registration.jobId === BigInt(ledgerJob.jobId),
      `ERC-8183 job ${ledgerJob.jobId} registration ID mismatch`,
    );
    assert(
      registration.policy.toLowerCase() === policyAddress.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} registered policy mismatch`,
    );
    assert(
      registration.client.toLowerCase() === commerceLedger.parties.client.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} registered client mismatch`,
    );
    assert(settleReceipt.status === "success", `ERC-8183 job ${ledgerJob.jobId} settlement failed`);
    assert(
      keccak256(stringToHex(canonicalJson(manifest))).toLowerCase() === ledgerJob.manifestHash.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} public manifest hash mismatch`,
    );
    report.commerce.push({
      jobId: ledgerJob.jobId,
      service: ledgerJob.service,
      status: "COMPLETED",
      budgetBaseUnits: ledgerJob.budgetBaseUnits,
      manifestHash: ledgerJob.manifestHash,
      registrationTransaction: ledgerJob.transactions.register,
      settlementTransaction: ledgerJob.transactions.settle,
    });
  }
  report.status = "OPERATIONAL";
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  report.checkCount = checks.length;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Production health report: ${outputPath}`);
}
