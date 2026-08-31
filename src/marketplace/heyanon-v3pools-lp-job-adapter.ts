import { z } from "zod";
import {
  LpRebalanceRequestSchema,
  type LpRebalanceRequest,
} from "../contracts/lp-rebalance.js";
import {
  HEYANON_V3_POOLS,
  auditionHeyAnonV3Position,
  type HeyAnonV3PositionAssessment,
} from "./heyanon-v3pools-adapter.js";

const PositiveDecimalSchema = z.string().regex(/^[1-9]\d*(\.\d+)?$|^0\.\d*[1-9]\d*$/);

const PoolPriceEnvelopeSchema = z.object({
  project: z.literal("v3pools"),
  operation: z.literal("getCurrentPoolPrice"),
  data: z.object({
    dex: z.literal("Pancake"),
    poolPrice: PositiveDecimalSchema,
    token0Symbol: z.string().min(1),
    token1Symbol: z.string().min(1),
    fee: z.string().regex(/^\d+(\.\d+)?%$/),
    oraclePrice: z.number().positive(),
  }).strict(),
}).strict();

const RangeEnvelopeSchema = z.object({
  project: z.literal("v3pools"),
  operation: z.literal("getPredefinedPriceRanges"),
  data: z.object({
    pool: z.string().min(3),
    lowerPrice: PositiveDecimalSchema,
    upperPrice: PositiveDecimalSchema,
  }).strict(),
}).strict();

const McpResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

interface ExternalRange {
  shortcut: "wide";
  providerPool: string;
  lowerPoolPrice: string;
  upperPoolPrice: string;
  lowerTick: number;
  upperTick: number;
  widthTicks: number;
  currentPriceUsd: string;
  oraclePriceUsd: string;
}

export interface HeyAnonV3LpJobAssessment {
  schemaVersion: "positioncrew.external-lp-job-assessment.v1";
  adapterId: "positioncrew:mcp:heyanon-v3pools:lp-job:v1";
  provider: typeof HEYANON_V3_POOLS;
  requestId: string;
  positionId: string;
  positionAssessment: HeyAnonV3PositionAssessment;
  recommendation: ExternalRange;
  checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
  attributableResult: true;
  status: "INCOMPATIBLE_CONSTRAINTS" | "PARTIAL_COMPATIBILITY";
  eligibleForLpRebalance: false;
  claimBoundary: string[];
}

function parseEventStream(raw: string): unknown {
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : raw) as unknown;
}

async function callTool(
  name: "getCurrentPoolPrice" | "getPredefinedPriceRanges",
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(HEYANON_V3_POOLS.endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) throw new Error(`HeyAnon V3 MCP returned HTTP ${response.status}`);
  const mcp = McpResponseSchema.parse(parseEventStream(await response.text()));
  const content = mcp.result.content.find((item) => item.type === "text");
  if (!content) throw new Error(`HeyAnon V3 MCP returned no ${name} result`);
  return JSON.parse(content.text) as unknown;
}

function priceToTick(price: number, rounding: "DOWN" | "UP"): number {
  if (!Number.isFinite(price) || price <= 0) throw new Error("External range price is invalid");
  const raw = Math.log(price) / Math.log(1.0001);
  return rounding === "DOWN" ? Math.floor(raw) : Math.ceil(raw);
}

function relativeDifferenceBps(left: number, right: number): number {
  if (left <= 0 || right <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / right * 10_000;
}

export async function auditionHeyAnonV3LpJob(
  input: LpRebalanceRequest,
  positionId: string,
  options: { rpcUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<HeyAnonV3LpJobAssessment> {
  const request = LpRebalanceRequestSchema.parse(input);
  const fetchImpl = options.fetchImpl ?? fetch;
  const positionAssessment = await auditionHeyAnonV3Position(positionId, {
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
    fetchImpl,
  });
  const feeTier = positionAssessment.onchain.fee;
  const args = {
    chainName: "bsc",
    token0: request.token0.address,
    token1: request.token1.address,
    fee: feeTier,
  };
  const [priceEnvelope, rangeEnvelope] = await Promise.all([
    callTool("getCurrentPoolPrice", args, fetchImpl).then((value) =>
      PoolPriceEnvelopeSchema.parse(value)
    ),
    callTool("getPredefinedPriceRanges", { ...args, shortcut: "wide" }, fetchImpl).then(
      (value) => RangeEnvelopeSchema.parse(value),
    ),
  ]);
  const lowerPoolPrice = Number(rangeEnvelope.data.lowerPrice);
  const upperPoolPrice = Number(rangeEnvelope.data.upperPrice);
  if (lowerPoolPrice >= upperPoolPrice) throw new Error("External range is not ordered");
  const lowerTick = priceToTick(lowerPoolPrice, "DOWN");
  const upperTick = priceToTick(upperPoolPrice, "UP");
  const widthTicks = upperTick - lowerTick;
  const tokenBinding = positionAssessment.onchain.token0 === request.token0.address.toLowerCase() &&
    positionAssessment.onchain.token1 === request.token1.address.toLowerCase();
  const requestPositionBinding = positionAssessment.onchain.tickLower === request.position.lowerTick &&
    positionAssessment.onchain.tickUpper === request.position.upperTick &&
    positionAssessment.onchain.liquidity === request.position.liquidity;
  const currentTickInside = request.marketState.currentTick >= lowerTick &&
    request.marketState.currentTick < upperTick;
  const widthPass = widthTicks >= request.constraints.minimumWidthTicks &&
    widthTicks <= request.constraints.maximumWidthTicks;
  const priceBps = relativeDifferenceBps(
    Number(priceEnvelope.data.poolPrice),
    Number(request.marketState.token1PriceUsd) / Number(request.marketState.token0PriceUsd),
  );
  const pricePass = priceBps <= 100;
  const checks = [
    {
      code: "EXACT_POSITION_BINDING",
      status: tokenBinding && requestPositionBinding ? "PASS" as const : "FAIL" as const,
      detail: tokenBinding && requestPositionBinding
        ? "The frozen request binds the same token pair, ticks, and raw liquidity as the listed provider's onchain position."
        : "The frozen request does not bind the same position state.",
    },
    {
      code: "CURRENT_PRICE_COHERENCE",
      status: pricePass ? "PASS" as const : "FAIL" as const,
      detail: pricePass
        ? `The provider pool price is within ${priceBps.toFixed(2)} bps of the request's pinned oracle price.`
        : `The provider pool price differs by ${priceBps.toFixed(2)} bps from the request's pinned oracle price.`,
    },
    {
      code: "ATTRIBUTABLE_RANGE_RECOMMENDATION",
      status: "PASS" as const,
      detail: "The listed provider returned its precommitted wide range for the exact pool and fee tier.",
    },
    {
      code: "RANGE_CONTAINS_CURRENT_TICK",
      status: currentTickInside ? "PASS" as const : "FAIL" as const,
      detail: currentTickInside
        ? "The external range contains the pinned current tick."
        : "The external range excludes the pinned current tick.",
    },
    {
      code: "RANGE_WIDTH_POLICY",
      status: widthPass ? "PASS" as const : "FAIL" as const,
      detail: widthPass
        ? `The external ${widthTicks}-tick range is inside the buyer's width limits.`
        : `The external ${widthTicks}-tick range is outside the buyer's ${request.constraints.minimumWidthTicks}..${request.constraints.maximumWidthTicks} limits.`,
    },
    {
      code: "MARKET_ECONOMICS",
      status: "FAIL" as const,
      detail: "The provider recommendation does not include projected fees, gas, swap cost, net benefit, or break-even time.",
    },
    {
      code: "EXACT_OUTPUT_CONTRACT",
      status: "FAIL" as const,
      detail: "The provider recommendation is not positioncrew.lp-rebalance.deliverable.v1.",
    },
  ];
  return {
    schemaVersion: "positioncrew.external-lp-job-assessment.v1",
    adapterId: "positioncrew:mcp:heyanon-v3pools:lp-job:v1",
    provider: HEYANON_V3_POOLS,
    requestId: request.requestId,
    positionId,
    positionAssessment,
    recommendation: {
      shortcut: "wide",
      providerPool: rangeEnvelope.data.pool,
      lowerPoolPrice: rangeEnvelope.data.lowerPrice,
      upperPoolPrice: rangeEnvelope.data.upperPrice,
      lowerTick,
      upperTick,
      widthTicks,
      currentPriceUsd: priceEnvelope.data.poolPrice,
      oraclePriceUsd: String(priceEnvelope.data.oraclePrice),
    },
    checks,
    attributableResult: true,
    status: widthPass ? "PARTIAL_COMPATIBILITY" : "INCOMPATIBLE_CONSTRAINTS",
    eligibleForLpRebalance: false,
    claimBoundary: [
      "The external agent produced an attributable range recommendation, not a complete bounded rebalance decision.",
      "PositionCrew independently supplied and pinned the market economics used by its first-party decision.",
      "The external candidate is not selected while buyer constraints or the exact output contract fail.",
    ],
  };
}
