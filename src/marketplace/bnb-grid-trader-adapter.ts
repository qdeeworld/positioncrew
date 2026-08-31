import type {
  BoundedGridDeliverable,
  BoundedGridRequest,
} from "../contracts/bounded-grid.js";

const DEFAULT_BASE_URL = "https://bnb-grid-api.172-104-171-139.nip.io";

export const BNB_GRID_TRADER = {
  name: "BNB Grid Trader",
  tokenId: "269233",
  chainId: 56,
  a2aEndpoint:
    "https://bnb-grid.172-104-171-139.nip.io/.well-known/agent-card.json",
  apiBaseUrl: DEFAULT_BASE_URL,
} as const;

interface HealthResponse {
  status?: string;
  keyless?: boolean;
  network?: string;
}

interface StatusResponse {
  network?: string;
  status?: string;
  updated_at?: string;
  price_usdt_per_bnb?: number;
}

interface GridPlanResponse {
  spot_price?: number;
  lower?: number;
  upper?: number;
  levels?: number;
  grid?: number[];
  capital_quote?: number;
  order_size_quote?: number;
  net_edge_pct?: number;
  profit_full_sweep_quote?: number;
  fee_bps?: number;
  slippage_pct?: number;
  warnings?: string[];
  assumptions?: string[];
  network?: string;
  pair?: string;
  pool_fee_tier?: number;
}

export interface BnbGridCheck {
  code: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export interface BnbGridAudition {
  schemaVersion: "positioncrew.external-grid-audition.v1";
  provider: typeof BNB_GRID_TRADER;
  evaluatedAt: string;
  outcome: "PARTIAL_COMPATIBILITY" | "INCOMPATIBLE" | "UNAVAILABLE";
  attributableResult: boolean;
  exactRequestAccepted: false;
  exactOutputContract: false;
  activatable: false;
  eligibleForLiveMatch: false;
  checks: BnbGridCheck[];
  externalPlan?: GridPlanResponse;
  firstParty: {
    decision: string;
    orderCount: number;
    expectedNetProfitUsd: string;
    worstCaseLossUsd: string;
  };
  boundary: string;
}

function pass(code: string, detail: string): BnbGridCheck {
  return { code, status: "PASS", detail };
}

function fail(code: string, detail: string): BnbGridCheck {
  return { code, status: "FAIL", detail };
}

async function readJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function auditionBnbGridTrader(
  request: BoundedGridRequest,
  firstParty: BoundedGridDeliverable,
  options: {
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    now?: Date;
  } = {},
): Promise<BnbGridAudition> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const now = options.now ?? new Date();
  const firstPartySummary = {
    decision: firstParty.decision,
    orderCount: firstParty.orders.length,
    expectedNetProfitUsd: firstParty.expectedNetProfitUsd,
    worstCaseLossUsd: firstParty.worstCaseLossUsd,
  };

  let health: HealthResponse;
  let status: StatusResponse;
  let plan: GridPlanResponse;
  try {
    [health, status, plan] = await Promise.all([
      readJson<HealthResponse>(fetchImpl, `${baseUrl}/health`),
      readJson<StatusResponse>(fetchImpl, `${baseUrl}/status`),
      readJson<GridPlanResponse>(
        fetchImpl,
        `${baseUrl}/plan?capital_usdt=${encodeURIComponent(request.constraints.capitalUsd)}`,
      ),
    ]);
  } catch (error) {
    return {
      schemaVersion: "positioncrew.external-grid-audition.v1",
      provider: BNB_GRID_TRADER,
      evaluatedAt: now.toISOString(),
      outcome: "UNAVAILABLE",
      attributableResult: false,
      exactRequestAccepted: false,
      exactOutputContract: false,
      activatable: false,
      eligibleForLiveMatch: false,
      checks: [
        fail(
          "PUBLIC_PLAN_SURFACE",
          error instanceof Error ? error.message : "Public grid plan failed.",
        ),
      ],
      firstParty: firstPartySummary,
      boundary:
        "No negotiation, payment, activation, order placement, signature, or transaction occurred.",
    };
  }

  const checks: BnbGridCheck[] = [];
  checks.push(
    health.status === "ok" && health.keyless === true
      ? pass("PUBLIC_PLAN_SURFACE", "Provider health is up and the plan surface is keyless.")
      : fail("PUBLIC_PLAN_SURFACE", "Provider health or keyless access did not pass."),
  );
  checks.push(
    plan.network === "bsc-mainnet" && status.network === "bsc-mainnet"
      ? pass("CHAIN", "Plan and provider status target BSC mainnet.")
      : fail("CHAIN", "Plan or provider status does not target BSC mainnet."),
  );
  checks.push(
    plan.pair === "BNB/USDT" && request.baseAsset.symbol === "WBNB" && request.quoteAsset.symbol === "USDT"
      ? pass("PAIR", "External BNB/USDT maps to the request WBNB/USDT pair.")
      : fail("PAIR", "External pair does not map to the request pair."),
  );
  checks.push(
    plan.capital_quote === Number(request.constraints.capitalUsd)
      ? pass("CAPITAL", "External plan uses the exact requested capital.")
      : fail("CAPITAL", "External plan capital differs from the request."),
  );

  const requestMid = Number(request.marketState.midPrice);
  const externalSpot = plan.spot_price ?? Number.NaN;
  const priceDifferenceBps =
    Number.isFinite(requestMid) && Number.isFinite(externalSpot) && requestMid > 0
      ? (Math.abs(externalSpot - requestMid) / requestMid) * 10_000
      : Number.POSITIVE_INFINITY;
  checks.push(
    priceDifferenceBps <= 25
      ? pass("PRICE_COHERENCE", `Spot prices differ by ${priceDifferenceBps.toFixed(2)} bps.`)
      : fail("PRICE_COHERENCE", "Spot prices differ by more than 25 bps."),
  );
  checks.push(
    plan.levels === request.constraints.levelCount
      ? pass("LEVEL_COUNT", "External plan uses the requested level count.")
      : fail(
          "LEVEL_COUNT",
          `External plan uses ${plan.levels ?? "unknown"} levels; request requires ${request.constraints.levelCount}.`,
        ),
  );
  checks.push(
    plan.lower === Number(request.constraints.lowerPrice) &&
      plan.upper === Number(request.constraints.upperPrice)
      ? pass("RANGE", "External plan uses the exact requested price range.")
      : fail("RANGE", "External plan uses its own range rather than the frozen request range."),
  );
  const externalSlippageBps = (plan.slippage_pct ?? Number.POSITIVE_INFINITY) * 100;
  checks.push(
    externalSlippageBps <= request.maxSlippageBps
      ? pass("SLIPPAGE", "External slippage assumption stays within the request cap.")
      : fail(
          "SLIPPAGE",
          `External ${externalSlippageBps} bps assumption exceeds the ${request.maxSlippageBps} bps cap.`,
        ),
  );
  checks.push(
    fail(
      "MAXIMUM_LOSS",
      "External plan does not bind a worst-case loss to the request's maximumLossUsd.",
    ),
  );
  checks.push(
    fail(
      "EXPIRY_AND_CANCELLATION",
      "External plan omits request expiry and enforceable cancellation conditions.",
    ),
  );
  checks.push(
    fail(
      "BLOCK_ATTRIBUTION",
      "External plan does not bind its market state to a BSC block.",
    ),
  );
  checks.push(
    fail(
      "EXACT_REQUEST_ACCEPTANCE",
      "The public endpoint accepts capital only, not positioncrew.bounded-grid.request.v1.",
    ),
  );
  checks.push(
    fail(
      "EXACT_OUTPUT_CONTRACT",
      "The provider does not return positioncrew.bounded-grid.deliverable.v1.",
    ),
  );
  checks.push(
    status.status === "active"
      ? pass("ACTIVATABLE", "Provider reports active status.")
      : fail("ACTIVATABLE", `Provider reports ${status.status ?? "unknown"} status.`),
  );

  const semanticIdentity = ["PUBLIC_PLAN_SURFACE", "CHAIN", "PAIR", "CAPITAL", "PRICE_COHERENCE"]
    .map((code) => checks.find((check) => check.code === code))
    .every((check) => check?.status === "PASS");

  return {
    schemaVersion: "positioncrew.external-grid-audition.v1",
    provider: BNB_GRID_TRADER,
    evaluatedAt: now.toISOString(),
    outcome: semanticIdentity ? "PARTIAL_COMPATIBILITY" : "INCOMPATIBLE",
    attributableResult: semanticIdentity,
    exactRequestAccepted: false,
    exactOutputContract: false,
    activatable: false,
    eligibleForLiveMatch: false,
    checks,
    externalPlan: plan,
    firstParty: firstPartySummary,
    boundary:
      "This is a public plan comparison, not an exact-request provider execution, negotiation, payment, activation, order placement, signature, or transaction.",
  };
}
