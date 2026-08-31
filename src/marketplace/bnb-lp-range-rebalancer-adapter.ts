import type {
  LpRebalanceDeliverable,
  LpRebalanceRequest,
} from "../contracts/lp-rebalance.js";

const DEFAULT_BASE_URL = "https://bnb-lp-api.172-104-171-139.nip.io";

export const BNB_LP_RANGE_REBALANCER = {
  name: "BNB LP Range Rebalancer",
  tokenId: "265375",
  chainId: 56,
  a2aEndpoint:
    "https://bnb-lp.172-104-171-139.nip.io/.well-known/agent-card.json",
  apiBaseUrl: DEFAULT_BASE_URL,
} as const;

interface HealthResponse {
  status?: string;
  chain_id?: number;
  block?: number;
  token_id?: number;
  last_check?: string;
  rpc?: string;
  protocol?: string;
  strategy_status?: string;
}

interface StatusResponse {
  status?: string;
  token_id?: number;
  rebalance_required?: boolean;
  rebalance_reason?: string;
  current_price?: number;
  lower_price?: number;
  upper_price?: number;
  in_range?: boolean;
  last_check?: string;
}

interface ExternalPosition {
  token_id?: number;
  owner?: string;
  token0?: string;
  token1?: string;
  fee?: number;
  tick_lower?: number;
  tick_upper?: number;
  liquidity?: number | string;
  verification?: {
    verified?: boolean;
    checks?: Record<string, boolean>;
    problems?: string[];
  };
}

interface PositionsResponse {
  network?: string;
  positions?: ExternalPosition[];
}

interface MetadataResponse {
  name?: string;
  category?: string;
  protocol?: string;
  pair?: string;
  networks?: string[];
  capabilities?: string[];
  risk_controls?: string[];
}

export interface BnbLpCompatibilityCheck {
  code: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export interface BnbLpRangeRebalancerAudition {
  schemaVersion: "positioncrew.external-lp-audition.v1";
  provider: typeof BNB_LP_RANGE_REBALANCER;
  evaluatedAt: string;
  positionTokenId: string;
  outcome:
    | "SEMANTIC_MATCH_ONLY"
    | "SEMANTIC_DISAGREEMENT"
    | "INCOMPATIBLE"
    | "UNAVAILABLE";
  attributableResult: boolean;
  exactRequestAccepted: false;
  exactOutputContract: false;
  eligibleForLiveMatch: false;
  externalDecision: "HOLD" | "REBALANCE" | "UNKNOWN";
  firstPartyDecision: string;
  checks: BnbLpCompatibilityCheck[];
  externalEvidence?: {
    health: HealthResponse;
    status: StatusResponse;
    position: ExternalPosition;
    metadata: MetadataResponse;
  };
  boundary: string;
}

function pass(code: string, detail: string): BnbLpCompatibilityCheck {
  return { code, status: "PASS", detail };
}

function fail(code: string, detail: string): BnbLpCompatibilityCheck {
  return { code, status: "FAIL", detail };
}

function sameAddress(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

async function readJson<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  route: string,
): Promise<T> {
  const response = await fetchImpl(`${baseUrl}${route}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${route} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function auditionBnbLpRangeRebalancer(
  request: LpRebalanceRequest,
  firstParty: LpRebalanceDeliverable,
  positionTokenId: string,
  options: {
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    now?: Date;
  } = {},
): Promise<BnbLpRangeRebalancerAudition> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const now = options.now ?? new Date();

  let health: HealthResponse;
  let status: StatusResponse;
  let positions: PositionsResponse;
  let metadata: MetadataResponse;
  try {
    [health, status, positions, metadata] = await Promise.all([
      readJson<HealthResponse>(fetchImpl, baseUrl, "/health"),
      readJson<StatusResponse>(fetchImpl, baseUrl, "/status"),
      readJson<PositionsResponse>(fetchImpl, baseUrl, "/positions"),
      readJson<MetadataResponse>(fetchImpl, baseUrl, "/metadata"),
    ]);
  } catch (error) {
    return {
      schemaVersion: "positioncrew.external-lp-audition.v1",
      provider: BNB_LP_RANGE_REBALANCER,
      evaluatedAt: now.toISOString(),
      positionTokenId,
      outcome: "UNAVAILABLE",
      attributableResult: false,
      exactRequestAccepted: false,
      exactOutputContract: false,
      eligibleForLiveMatch: false,
      externalDecision: "UNKNOWN",
      firstPartyDecision: firstParty.decision,
      checks: [
        fail(
          "PUBLIC_READ_SURFACE",
          error instanceof Error ? error.message : "Public provider read failed.",
        ),
      ],
      boundary:
        "No negotiation, payment, marketplace order, signature, transaction, or provider activation occurred.",
    };
  }

  const position = positions.positions?.find(
    (candidate) => String(candidate.token_id) === positionTokenId,
  );
  const externalDecision =
    status.rebalance_required === false
      ? "HOLD"
      : status.rebalance_required === true
        ? "REBALANCE"
        : "UNKNOWN";
  const checks: BnbLpCompatibilityCheck[] = [];

  checks.push(
    health.status === "ok" && health.rpc === "up" && health.protocol === "up"
      ? pass("LIVE_PROVIDER", "Health, RPC, and protocol checks are up.")
      : fail("LIVE_PROVIDER", "Composite provider health did not pass."),
  );
  checks.push(
    health.chain_id === request.chainId && health.chain_id === 56
      ? pass("CHAIN", "Provider and request both target BSC mainnet.")
      : fail("CHAIN", "Provider chain does not match the request."),
  );
  checks.push(
    position
      ? pass("POSITION_ID", `Provider reports Pancake V3 NFT ${positionTokenId}.`)
      : fail("POSITION_ID", `Provider does not report NFT ${positionTokenId}.`),
  );
  checks.push(
    position && sameAddress(position.owner, request.account)
      ? pass("OWNER", "Provider position owner matches the request account.")
      : fail("OWNER", "Provider position owner does not match the request account."),
  );
  checks.push(
    position &&
      sameAddress(position.token0, request.token0.address) &&
      sameAddress(position.token1, request.token1.address)
      ? pass("PAIR", "Provider token addresses match the exact request pair.")
      : fail("PAIR", "Provider token addresses do not match the exact request pair."),
  );
  checks.push(
    position &&
      position.tick_lower === request.position.lowerTick &&
      position.tick_upper === request.position.upperTick
      ? pass("POSITION_TICKS", "Provider ticks match the request position.")
      : fail("POSITION_TICKS", "Provider ticks differ from the request position."),
  );
  const externalLiquidity = position?.liquidity;
  const liquidityIsSafe =
    typeof externalLiquidity === "string" &&
    /^\d+$/.test(externalLiquidity) &&
    externalLiquidity === request.position.liquidity;
  checks.push(
    liquidityIsSafe
      ? pass("RAW_LIQUIDITY_PRECISION", "Provider preserves exact raw liquidity as a string.")
      : fail(
          "RAW_LIQUIDITY_PRECISION",
          typeof externalLiquidity === "number" && !Number.isSafeInteger(externalLiquidity)
            ? "Provider serializes raw liquidity as an unsafe JSON number, so exact integer state is not preserved."
            : "Provider raw liquidity does not exactly match the request string.",
        ),
  );
  checks.push(
    position?.verification?.verified === true
      ? pass("PROVIDER_VERIFICATION", "Provider marks its onchain position checks verified.")
      : fail("PROVIDER_VERIFICATION", "Provider did not verify its position checks."),
  );

  const lastCheck = Date.parse(status.last_check ?? health.last_check ?? "");
  const ageSeconds = Number.isFinite(lastCheck)
    ? Math.max(0, (now.getTime() - lastCheck) / 1000)
    : Number.POSITIVE_INFINITY;
  checks.push(
    ageSeconds <= request.maxDataAgeSeconds
      ? pass("FRESHNESS", `Provider observation age is ${ageSeconds.toFixed(1)} seconds.`)
      : fail(
          "FRESHNESS",
          `Provider observation age ${Number.isFinite(ageSeconds) ? ageSeconds.toFixed(1) : "unknown"} seconds exceeds the ${request.maxDataAgeSeconds}-second request limit.`,
        ),
  );
  checks.push(
    externalDecision !== "UNKNOWN" && externalDecision === firstParty.decision
      ? pass("DECISION_ALIGNMENT", `Both providers return ${externalDecision}.`)
      : fail(
          "DECISION_ALIGNMENT",
          `External ${externalDecision} does not equal PositionCrew ${firstParty.decision}.`,
        ),
  );
  checks.push(
    fail(
      "EXACT_REQUEST_ACCEPTANCE",
      "The public read surface evaluates the provider's managed position; it does not accept the frozen PositionCrew request payload.",
    ),
  );
  checks.push(
    fail(
      "EXACT_OUTPUT_CONTRACT",
      "The provider does not return positioncrew.lp-rebalance.deliverable.v1.",
    ),
  );
  checks.push(
    fail(
      "BLOCK_ATTRIBUTION",
      "The status response does not bind its decision to the request's exact BSC block.",
    ),
  );

  const identityMatches = checks
    .filter((check) =>
      ["LIVE_PROVIDER", "CHAIN", "POSITION_ID", "OWNER", "PAIR", "POSITION_TICKS"].includes(
        check.code,
      ),
    )
    .every((check) => check.status === "PASS");
  const decisionMatches = checks.find(
    (check) => check.code === "DECISION_ALIGNMENT",
  )?.status === "PASS";

  return {
    schemaVersion: "positioncrew.external-lp-audition.v1",
    provider: BNB_LP_RANGE_REBALANCER,
    evaluatedAt: now.toISOString(),
    positionTokenId,
    outcome: !identityMatches
      ? "INCOMPATIBLE"
      : decisionMatches
        ? "SEMANTIC_MATCH_ONLY"
        : "SEMANTIC_DISAGREEMENT",
    attributableResult: identityMatches && externalDecision !== "UNKNOWN",
    exactRequestAccepted: false,
    exactOutputContract: false,
    eligibleForLiveMatch: false,
    externalDecision,
    firstPartyDecision: firstParty.decision,
    checks,
    ...(position
      ? { externalEvidence: { health, status, position, metadata } }
      : {}),
    boundary:
      "This is a same-position public-read audition, not an A2A negotiation, exact-request execution, provider activation, payment, marketplace order, signature, transaction, or proof that one provider is stronger.",
  };
}
