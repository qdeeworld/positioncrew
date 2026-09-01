import { z } from "zod";

import type {
  BoundedGridDeliverable,
  BoundedGridRequest,
} from "../contracts/bounded-grid.js";
import { createBoundedGridDeliverable } from "../providers/bounded-grid.js";

export const BRAIN_ON_BNB_GRID = {
  name: "Brain on BNB BSC Grid Planner",
  erc8004TokenId: "302258",
  endpoint: "https://brainonbnb.com/api/range-plan",
} as const;

const RangeSchema = z.object({
  width_pct: z.number().positive().nullable(),
  full_range: z.boolean(),
  price_range: z.object({
    low: z.number().positive(),
    high: z.number().positive(),
    unit: z.string().min(1),
  }).strict().nullable(),
  swaps_in_range: z.number().int().nonnegative(),
  swaps_total: z.number().int().positive(),
  share_of_window_in_range_pct: z.number().nonnegative(),
  times_it_crossed_the_edge: z.number().int().nonnegative(),
  fees_usd_in_window: z.number().nonnegative(),
  assumed_rebalance_cost_usd: z.number().nonnegative(),
  net_after_rebalancing_usd_in_window: z.number(),
}).strict();

const BrainGridResponseSchema = z.object({
  tool: z.literal("pancakeswap_range_plan"),
  pair: z.object({
    token: z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      symbol: z.string().min(1),
      decimals: z.number().int().nonnegative(),
    }).strict(),
    quote: z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      symbol: z.string().min(1),
      decimals: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  pool: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  fee_pct: z.number().nonnegative(),
  tier_chosen_because: z.string().min(1),
  price_now: z.number().positive(),
  capital_considered_usd: z.number().positive(),
  measured_window: z.object({
    from_block: z.number().int().positive(),
    to_block: z.number().int().positive(),
    blocks: z.number().int().positive(),
    minutes: z.number().positive(),
    swaps: z.number().int().positive(),
    fees_the_pool_paid_usd: z.number().nonnegative(),
    note: z.string().min(1),
  }).strict(),
  ranges: z.array(RangeSchema).min(1),
  best_earning_range_in_this_window: z.string().min(1),
  best_range_after_paying_to_put_it_back: z.string().min(1),
  rebalance_cost_usd_assumed: z.number().nonnegative(),
  narrowest_range_that_held_the_whole_window: z.string().min(1),
  times_better_than_full_range: z.number().nonnegative(),
  caveats: z.array(z.string().min(1)).min(1),
}).strict();

export type BrainOnBnbGridComparison = {
  provider: typeof BRAIN_ON_BNB_GRID;
  evaluatedAt: string;
  outcome: "SEMANTICALLY_COMPARABLE" | "INCOMPATIBLE" | "UNAVAILABLE";
  pool: string;
  positionCrewDecision: BoundedGridDeliverable["decision"];
  externalRecommendation: "BUILD_GRID" | "NO_GRID" | null;
  externalState: "RANGE_REPLAY_READY" | null;
  exactRequestAccepted: false;
  eligibleForRangeAssessmentActivation: boolean;
  eligibleForGridSelection: boolean;
  eligibleForLiveMatch: boolean;
  attributable: boolean;
  adapterNormalized: boolean;
  providerRange: {
    widthPct: number;
    lowerPrice: number;
    upperPrice: number;
    netAfterRebalancingUsdInWindow: number;
  } | null;
  measuredWindow: {
    fromBlock: number;
    toBlock: number;
    swaps: number;
    minutes: number;
  } | null;
  normalizedDeliverable?: BoundedGridDeliverable;
  selection?: {
    selectedProvider: "POSITIONCREW" | "EXTERNAL";
    externalEligible: boolean;
    basis: string;
  };
  checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
  boundary: string;
};

function requestBlock(request: BoundedGridRequest): number | null {
  const source = request.sources.find(({ sourceId }) => sourceId === request.marketState.sourceId);
  if (!source) return null;
  const match = source.uri.match(/\/block\/(\d+)(?:$|[/?#])/);
  const idMatch = source.sourceId.match(/block-(\d+)$/);
  const uriBlock = match ? Number(match[1]) : null;
  const idBlock = idMatch ? Number(idMatch[1]) : null;
  if (uriBlock !== null && idBlock !== null && uriBlock !== idBlock) return null;
  return uriBlock ?? idBlock;
}

function priceDifferenceBps(left: number, right: number): number {
  return Math.abs(left - right) / right * 10_000;
}

function replayActivityIsConsistent(
  candidate: z.infer<typeof RangeSchema>,
  window: z.infer<typeof BrainGridResponseSchema>["measured_window"],
  rangeFeeLexeme: string | null,
  windowFeeLexeme: string | null,
): boolean {
  const calculatedShare = candidate.swaps_in_range / candidate.swaps_total * 100;
  const rangeFees = rangeFeeLexeme ? numericLexemeToPlainDecimal(rangeFeeLexeme) : null;
  const windowFees = windowFeeLexeme ? numericLexemeToPlainDecimal(windowFeeLexeme) : null;
  return candidate.swaps_total === window.swaps &&
    candidate.swaps_in_range <= candidate.swaps_total &&
    candidate.share_of_window_in_range_pct <= 100 &&
    Math.abs(candidate.share_of_window_in_range_pct - calculatedShare) <= 0.1 &&
    rangeFees !== null && windowFees !== null && decimalLessThanOrEqual(rangeFees, windowFees);
}

function declaredBestWidthPct(value: string): string | null {
  const match = value.trim().match(/^±(\d+(?:\.\d+)?)%$/);
  return match?.[1] ?? null;
}

function numberToPlainDecimal(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const source = String(value).toLowerCase();
  if (!source.includes("e")) return source;
  const [coefficient, exponentText] = source.split("e");
  const exponent = Number(exponentText);
  if (!coefficient || !Number.isInteger(exponent) || Math.abs(exponent) > 100) return null;
  const [whole = "", fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + exponent;
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function numericLexemeToPlainDecimal(source: string): string | null {
  if (source.length > 256) return null;
  const normalized = source.toLowerCase();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/.test(normalized)) return null;
  if (!normalized.includes("e")) return normalized;
  const [coefficient, exponentText] = normalized.split("e");
  const exponent = Number(exponentText);
  if (!coefficient || !Number.isInteger(exponent) || Math.abs(exponent) > 100) return null;
  const [whole = "", fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + exponent;
  const expanded = decimalIndex <= 0
    ? `0.${"0".repeat(-decimalIndex)}${digits}`
    : decimalIndex >= digits.length
      ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
      : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return expanded.length <= 256 ? expanded : null;
}

function canonicalDecimalLexeme(source: string): { digits: string; power: number } | null {
  if (source.length > 256) return null;
  const match = source.toLowerCase().match(/^(0|[1-9]\d*)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match?.[1]) return null;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  let digits = `${match[1]}${fraction}`.replace(/^0+/, "");
  if (!digits) return { digits: "0", power: 0 };
  let trailingZeros = 0;
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    trailingZeros += 1;
  }
  return { digits, power: exponent - fraction.length + trailingZeros };
}

function decimalLexemesEqualExact(left: string, right: string): boolean {
  const a = canonicalDecimalLexeme(left);
  const b = canonicalDecimalLexeme(right);
  return a !== null && b !== null && a.digits === b.digits && a.power === b.power;
}

function rawUnsignedIntegerLexemeMatches(source: string | null, value: number): boolean {
  return source !== null &&
    /^(?:0|[1-9]\d*)$/.test(source) &&
    Number.isSafeInteger(value) &&
    BigInt(source) === BigInt(value);
}

function scanJsonNumericFields(source: string): {
  hasDuplicateKeys: boolean;
  fields: Map<string, Array<string | null>>;
} {
  const fields = new Map<string, Array<string | null>>();
  const stack: Array<{ kind: "OBJECT"; keys: Set<string> } | { kind: "ARRAY" }> = [];
  let hasDuplicateKeys = false;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === "{") {
      stack.push({ kind: "OBJECT", keys: new Set() });
      index += 1;
      continue;
    }
    if (character === "[") {
      stack.push({ kind: "ARRAY" });
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      stack.pop();
      index += 1;
      continue;
    }
    if (character !== '"') {
      index += 1;
      continue;
    }
    let end = index + 1;
    for (; end < source.length; end += 1) {
      if (source[end] === "\\") {
        end += 1;
        continue;
      }
      if (source[end] === '"') break;
    }
    if (end >= source.length) break;
    let cursor = end + 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    const container = stack.at(-1);
    if (source[cursor] === ":" && container?.kind === "OBJECT") {
      const key = JSON.parse(source.slice(index, end + 1)) as string;
      if (container.keys.has(key)) hasDuplicateKeys = true;
      container.keys.add(key);
      cursor += 1;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      const valueMatch = source.slice(cursor).match(/^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|null)/);
      if (valueMatch?.[1]) {
        const values = fields.get(key) ?? [];
        values.push(valueMatch[1] === "null" ? null : valueMatch[1]);
        fields.set(key, values);
      }
    }
    index = end + 1;
  }
  return { hasDuplicateKeys, fields };
}

async function readResponseTextLimited(response: Response, maximumBytes = 1_000_000): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumBytes) {
    await response.body?.cancel();
    throw new Error("Brain on BNB Grid response exceeds the admitted size");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel();
      throw new Error("Brain on BNB Grid response exceeds the admitted size");
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup is best-effort and must not suppress retry or fail-closed handling.
  }
}

function parseUnsignedDecimal(value: string): { units: bigint; scale: bigint } {
  if (value.length > 256) throw new Error("Decimal precision exceeds the admitted bound");
  const [whole, fraction = ""] = value.split(".");
  const scale = 10n ** BigInt(fraction.length);
  return { units: BigInt(`${whole}${fraction}`), scale };
}

function decimalsEqual(left: string, right: string): boolean {
  const a = parseUnsignedDecimal(left);
  const b = parseUnsignedDecimal(right);
  return a.units * b.scale === b.units * a.scale;
}

function decimalLessThan(left: string, right: string): boolean {
  const a = parseUnsignedDecimal(left);
  const b = parseUnsignedDecimal(right);
  return a.units * b.scale < b.units * a.scale;
}

function decimalLessThanOrEqual(left: string, right: string): boolean {
  return decimalLessThan(left, right) || decimalsEqual(left, right);
}

function decimalDifferenceEquals(minuend: string, subtrahend: string, result: string): boolean {
  const a = parseUnsignedDecimal(minuend);
  const b = parseUnsignedDecimal(subtrahend);
  const c = parseUnsignedDecimal(result);
  const differenceNumerator = a.units * b.scale - b.units * a.scale;
  if (differenceNumerator <= 0n || c.units <= 0n) return false;
  return differenceNumerator * c.scale === c.units * a.scale * b.scale;
}

function decimalTimesIntegerEquals(value: string, multiplier: bigint, expected: string): boolean {
  const a = parseUnsignedDecimal(value);
  const b = parseUnsignedDecimal(expected);
  return a.units * multiplier * b.scale === b.units * a.scale;
}

function replayEconomicsAreConsistent(
  feesLexeme: string | null,
  costLexeme: string | null,
  netLexeme: string | null,
  declaredCostLexeme: string | null,
): boolean {
  if (!feesLexeme || !costLexeme || !netLexeme || !declaredCostLexeme) return false;
  const fees = numericLexemeToPlainDecimal(feesLexeme);
  const cost = numericLexemeToPlainDecimal(costLexeme);
  const net = numericLexemeToPlainDecimal(netLexeme);
  const declaredCost = numericLexemeToPlainDecimal(declaredCostLexeme);
  return fees !== null && cost !== null && net !== null && declaredCost !== null &&
    decimalsEqual(cost, declaredCost) && decimalDifferenceEquals(fees, cost, net);
}

function rationalDecimal(
  numerator: bigint,
  denominator: bigint,
  direction: "UP" | "DOWN",
): string {
  const decimalScale = 10n ** 18n;
  const scaledNumerator = numerator * decimalScale;
  const scaled = direction === "UP"
    ? (scaledNumerator + denominator - 1n) / denominator
    : scaledNumerator / denominator;
  const whole = scaled / decimalScale;
  const fraction = String(scaled % decimalScale).padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function recenteredRange(
  midPrice: string,
  widthPct: string,
  buyerLower: string,
  buyerUpper: string,
): { fitsBuyerBounds: boolean; lowerPrice: string; upperPrice: string } | null {
  const mid = parseUnsignedDecimal(midPrice);
  const widthText = numericLexemeToPlainDecimal(widthPct);
  if (!widthText) return null;
  const width = parseUnsignedDecimal(widthText);
  const lower = parseUnsignedDecimal(buyerLower);
  const upper = parseUnsignedDecimal(buyerUpper);
  const hundredAtWidthScale = 100n * width.scale;
  if (width.units >= hundredAtWidthScale) return null;
  const denominator = mid.scale * hundredAtWidthScale;
  const lowerNumerator = mid.units * (hundredAtWidthScale - width.units);
  const upperNumerator = mid.units * (hundredAtWidthScale + width.units);
  return {
    fitsBuyerBounds:
      lowerNumerator * lower.scale >= lower.units * denominator &&
      upperNumerator * upper.scale <= upper.units * denominator,
    lowerPrice: rationalDecimal(lowerNumerator, denominator, "UP"),
    upperPrice: rationalDecimal(upperNumerator, denominator, "DOWN"),
  };
}

export async function auditionBrainOnBnbGrid(
  request: BoundedGridRequest,
  firstParty: BoundedGridDeliverable,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<BrainOnBnbGridComparison> {
  const now = options.now ?? new Date();
  const boundary = "Brain on BNB independently replayed live PancakeSwap swaps and supplied a range thesis. PositionCrew bound that evidence to the requested pool and market window, then applied the unchanged capital, liquidity, volatility, fee, slippage, gas, inventory, loss, expiry, and output-contract rules through a disclosed adapter. No payment, authority grant, order placement, swap, or protocol transaction occurred.";
  const base = {
    provider: BRAIN_ON_BNB_GRID,
    evaluatedAt: now.toISOString(),
    pool: request.venue,
    positionCrewDecision: firstParty.decision,
    exactRequestAccepted: false as const,
  };
  const firstPartyEligible = firstParty.status === "ACTIONABLE" && firstParty.decision === "BUILD_GRID";

  try {
    const url = new URL(BRAIN_ON_BNB_GRID.endpoint);
    url.searchParams.set("address", request.baseAsset.address);
    const fetchImpl = options.fetchImpl ?? fetch;
    let response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (response.status >= 500) {
      await cancelResponseBody(response);
      await new Promise((resolve) => setTimeout(resolve, 250));
      response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(4_000),
      });
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`Brain on BNB Grid returned HTTP ${response.status}`);
    }
    const rawResponse = await readResponseTextLimited(response);
    const parsed = BrainGridResponseSchema.parse(JSON.parse(rawResponse));
    const rawStructure = scanJsonNumericFields(rawResponse);
    const rawJsonKeySafe = !rawStructure.hasDuplicateKeys;
    const rawLexemes = (key: string) => rawStructure.fields.get(key) ?? [];
    const capitalLexemes = rawLexemes("capital_considered_usd");
    const decimalLexemes = rawLexemes("decimals");
    const feeTierLexemes = rawLexemes("fee_pct");
    const widthLexemes = rawLexemes("width_pct");
    const rangeFeeLexemes = rawLexemes("fees_usd_in_window");
    const windowFeeLexemes = rawLexemes("fees_the_pool_paid_usd");
    const rangeCostLexemes = rawLexemes("assumed_rebalance_cost_usd");
    const rangeNetLexemes = rawLexemes("net_after_rebalancing_usd_in_window");
    const declaredCostLexemes = rawLexemes("rebalance_cost_usd_assumed");
    const fromBlockLexemes = rawLexemes("from_block");
    const toBlockLexemes = rawLexemes("to_block");
    const blockCountLexemes = rawLexemes("blocks");
    const windowSwapLexemes = rawLexemes("swaps");
    const inRangeSwapLexemes = rawLexemes("swaps_in_range");
    const totalSwapLexemes = rawLexemes("swaps_total");
    const exactChain = request.chainId === 56;
    const exactPool = parsed.pool.toLowerCase() === request.venue.toLowerCase();
    const tokenDecimalLexeme = decimalLexemes[0] ?? null;
    const quoteDecimalLexeme = decimalLexemes[1] ?? null;
    const exactTokenDecimals = decimalLexemes.length === 2 &&
      tokenDecimalLexeme !== null &&
      quoteDecimalLexeme !== null &&
      decimalLexemesEqualExact(tokenDecimalLexeme, String(request.baseAsset.decimals)) &&
      decimalLexemesEqualExact(quoteDecimalLexeme, String(request.quoteAsset.decimals));
    const exactPair =
      parsed.pair.token.address.toLowerCase() === request.baseAsset.address.toLowerCase() &&
      parsed.pair.token.decimals === request.baseAsset.decimals &&
      parsed.pair.quote.address.toLowerCase() === request.quoteAsset.address.toLowerCase() &&
      parsed.pair.quote.decimals === request.quoteAsset.decimals &&
      exactTokenDecimals;
    const providerCapital = capitalLexemes.length === 1 && capitalLexemes[0]
      ? numericLexemeToPlainDecimal(capitalLexemes[0])
      : null;
    const exactCapital = providerCapital !== null && decimalsEqual(providerCapital, request.constraints.capitalUsd);
    const providerFeeTier = feeTierLexemes.length === 1 && feeTierLexemes[0]
      ? numericLexemeToPlainDecimal(feeTierLexemes[0])
      : null;
    const exactFeeTier = providerFeeTier !== null &&
      decimalTimesIntegerEquals(providerFeeTier, 100n, String(request.marketState.venueFeeBps));
    const safeWindowBlocks = fromBlockLexemes.length === 1 &&
      toBlockLexemes.length === 1 &&
      blockCountLexemes.length === 1 &&
      rawUnsignedIntegerLexemeMatches(fromBlockLexemes[0] ?? null, parsed.measured_window.from_block) &&
      rawUnsignedIntegerLexemeMatches(toBlockLexemes[0] ?? null, parsed.measured_window.to_block) &&
      rawUnsignedIntegerLexemeMatches(blockCountLexemes[0] ?? null, parsed.measured_window.blocks);
    const safeWindowSwaps = windowSwapLexemes.length === 1 &&
      rawUnsignedIntegerLexemeMatches(windowSwapLexemes[0] ?? null, parsed.measured_window.swaps);
    const exactWindowBlockCount = safeWindowBlocks && parsed.measured_window.blocks ===
      parsed.measured_window.to_block - parsed.measured_window.from_block + 1;
    const pinnedBlock = requestBlock(request);
    const windowBindsRequest = pinnedBlock !== null &&
      pinnedBlock >= parsed.measured_window.from_block &&
      pinnedBlock <= parsed.measured_window.to_block;
    const priceCoherent = priceDifferenceBps(parsed.price_now, Number(request.marketState.midPrice)) <= 25;
    const midPrice = Number(request.marketState.midPrice);
    const buyerLower = Number(request.constraints.lowerPrice);
    const buyerUpper = Number(request.constraints.upperPrice);
    const rawRangeBindsProviderAndBuyer = (candidate: z.infer<typeof RangeSchema>): boolean => {
      if (candidate.width_pct === null || candidate.full_range || !candidate.price_range) return false;
      const expectedLower = parsed.price_now * (1 - candidate.width_pct / 100);
      const expectedUpper = parsed.price_now * (1 + candidate.width_pct / 100);
      const expectedUnit = `${request.quoteAsset.symbol} per ${request.baseAsset.symbol}`.toLowerCase();
      return candidate.price_range.unit.toLowerCase() === expectedUnit &&
        candidate.price_range.low < parsed.price_now &&
        parsed.price_now < candidate.price_range.high &&
        priceDifferenceBps(candidate.price_range.low, expectedLower) <= 5 &&
        priceDifferenceBps(candidate.price_range.high, expectedUpper) <= 5 &&
        candidate.price_range.low >= buyerLower * (1 - 25 / 10_000) &&
        candidate.price_range.high <= buyerUpper * (1 + 25 / 10_000);
    };
    const bestWidthPct = declaredBestWidthPct(parsed.best_range_after_paying_to_put_it_back);
    const rangeRows = parsed.ranges.map((candidate, index) => ({
      candidate,
      widthLexeme: widthLexemes.length === parsed.ranges.length ? widthLexemes[index] ?? null : null,
      feesLexeme: rangeFeeLexemes.length === parsed.ranges.length ? rangeFeeLexemes[index] ?? null : null,
      costLexeme: rangeCostLexemes.length === parsed.ranges.length ? rangeCostLexemes[index] ?? null : null,
      netLexeme: rangeNetLexemes.length === parsed.ranges.length ? rangeNetLexemes[index] ?? null : null,
      inRangeSwapLexeme: inRangeSwapLexemes.length === parsed.ranges.length ? inRangeSwapLexemes[index] ?? null : null,
      totalSwapLexeme: totalSwapLexemes.length === parsed.ranges.length ? totalSwapLexemes[index] ?? null : null,
    }));
    const declaredCostLexeme = declaredCostLexemes.length === 1
      ? declaredCostLexemes[0] ?? null
      : null;
    const windowFeeLexeme = windowFeeLexemes.length === 1
      ? windowFeeLexemes[0] ?? null
      : null;
    const declaredCandidates = bestWidthPct === null
      ? []
      : rangeRows.filter(({ candidate, widthLexeme }) => {
          if (candidate.width_pct === null || candidate.full_range || candidate.price_range === null || widthLexeme === null) return false;
          return decimalLexemesEqualExact(widthLexeme, bestWidthPct);
        });
    const declaredCandidateRow = declaredCandidates[0];
    const declaredCandidate = declaredCandidateRow?.candidate;
    const unambiguousDeclaredCandidate = declaredCandidates.length === 1;
    const providerRangeBinding = unambiguousDeclaredCandidate && declaredCandidate
      ? rawRangeBindsProviderAndBuyer(declaredCandidate)
      : false;
    const candidates = !unambiguousDeclaredCandidate || !declaredCandidate
      ? []
      : [declaredCandidateRow].flatMap(({ candidate, widthLexeme, feesLexeme, costLexeme, netLexeme, inRangeSwapLexeme, totalSwapLexeme }) => {
      if (candidate.width_pct === null || candidate.full_range || !candidate.price_range) return [];
      const candidateWidth = widthLexeme ? numericLexemeToPlainDecimal(widthLexeme) : null;
      if (
        bestWidthPct === null ||
        widthLexeme === null ||
        candidateWidth === null ||
        !decimalLexemesEqualExact(widthLexeme, bestWidthPct)
      ) return [];
      if (!rawRangeBindsProviderAndBuyer(candidate)) return [];
      if (
        !rawUnsignedIntegerLexemeMatches(inRangeSwapLexeme, candidate.swaps_in_range) ||
        !rawUnsignedIntegerLexemeMatches(totalSwapLexeme, candidate.swaps_total) ||
        !replayActivityIsConsistent(candidate, parsed.measured_window, feesLexeme, windowFeeLexeme) ||
        candidate.swaps_in_range < 100 ||
        BigInt(candidate.swaps_in_range) * 10n < BigInt(candidate.swaps_total) ||
        candidate.fees_usd_in_window <= 0 ||
        !replayEconomicsAreConsistent(feesLexeme, costLexeme, netLexeme, declaredCostLexeme)
      ) return [];
      const normalizedRange = recenteredRange(
        request.marketState.midPrice,
        widthLexeme!,
        request.constraints.lowerPrice,
        request.constraints.upperPrice,
      );
      if (!normalizedRange) return [];
      const representableRange = decimalLessThan(normalizedRange.lowerPrice, normalizedRange.upperPrice);
      let deliverable: BoundedGridDeliverable | undefined;
      if (normalizedRange.fitsBuyerBounds && representableRange) {
        try {
          deliverable = createBoundedGridDeliverable({
            ...request,
            constraints: {
              ...request.constraints,
              lowerPrice: normalizedRange.lowerPrice,
              upperPrice: normalizedRange.upperPrice,
            },
          }, now);
        } catch {
          deliverable = undefined;
        }
      }
      return [{ candidate, normalizedRange, deliverable, feesLexeme, costLexeme, netLexeme }];
    });
    const selected = candidates[0];
    const selectedRange = selected?.candidate;
    const widthPct = selectedRange?.width_pct ?? null;
    const rangeInsideBuyerBounds = selected?.normalizedRange.fitsBuyerBounds === true;
    const providerEvidenceSufficient = safeWindowSwaps && Boolean(selectedRange) &&
      parsed.measured_window.swaps >= 100 &&
      replayActivityIsConsistent(
        selectedRange!,
        parsed.measured_window,
        selected!.feesLexeme,
        windowFeeLexeme,
      ) &&
      replayEconomicsAreConsistent(
        selected!.feesLexeme,
        selected!.costLexeme,
        selected!.netLexeme,
        declaredCostLexeme,
      );
    const normalizedDeliverable = selected?.deliverable;
    const exactOutputContract = normalizedDeliverable?.status === "ACTIONABLE" &&
      normalizedDeliverable.decision === "BUILD_GRID";
    const externalEligible = rawJsonKeySafe && exactChain && exactPool && exactPair && exactCapital && exactFeeTier &&
      exactWindowBlockCount && windowBindsRequest &&
      priceCoherent && rangeInsideBuyerBounds && providerEvidenceSufficient && exactOutputContract;
    const liveMatchEligible = externalEligible && firstPartyEligible;
    const checks: BrainOnBnbGridComparison["checks"] = [
      { code: "RAW_JSON_KEY_SAFETY", status: rawJsonKeySafe ? "PASS" : "FAIL", detail: rawJsonKeySafe ? "Every decoded object key is unique within its JSON object." : "At least one JSON object contains duplicate keys after escape decoding, so raw numeric evidence is untrustworthy." },
      { code: "EXACT_CHAIN", status: exactChain ? "PASS" : "FAIL", detail: exactChain ? "The request targets BSC mainnet, the chain measured by this provider." : "The provider evidence is BSC mainnet-only and cannot bind this request chain." },
      { code: "EXACT_POOL_AND_PAIR", status: exactPool && exactPair ? "PASS" : "FAIL", detail: exactPool && exactPair ? "The provider measured the requested PancakeSwap WBNB/USDT pool." : "The provider result did not bind the requested pool and pair." },
      { code: "EXACT_CAPITAL", status: exactCapital ? "PASS" : "FAIL", detail: exactCapital ? "The replay used the buyer's exact capital amount." : "The replay used a different capital amount." },
      { code: "EXACT_FEE_TIER", status: exactFeeTier ? "PASS" : "FAIL", detail: exactFeeTier ? "The replay used the same venue fee tier as the pinned buyer request." : "The provider replay and buyer request use different venue fee tiers." },
      { code: "MEASURED_WINDOW_BLOCK_COUNT", status: exactWindowBlockCount ? "PASS" : "FAIL", detail: exactWindowBlockCount ? "The declared replay block count matches its inclusive endpoints." : "The replay block count is inconsistent with its disclosed endpoints." },
      { code: "MEASURED_WINDOW_BINDING", status: windowBindsRequest ? "PASS" : "FAIL", detail: windowBindsRequest ? "The request's pinned block is inside the provider's disclosed replay window." : "The provider replay window does not bind the request's pinned market observation." },
      { code: "CURRENT_PRICE_COHERENCE", status: priceCoherent ? "PASS" : "FAIL", detail: priceCoherent ? "Provider and PositionCrew prices differ by no more than 25 bps." : "Provider and PositionCrew prices diverge beyond the admitted tolerance." },
      { code: "PROVIDER_RANGE_BINDING", status: providerRangeBinding ? "PASS" : "FAIL", detail: providerRangeBinding ? "At least one returned low/high pair matches its declared width and unit, and remains inside the buyer boundary within the admitted price-coherence tolerance." : "No returned low/high pair binds its declared width, unit, and buyer boundary." },
      { code: "PROVIDER_RANGE_INSIDE_BUYER_BOUND", status: rangeInsideBuyerBounds ? "PASS" : "FAIL", detail: rangeInsideBuyerBounds ? `The provider's declared best post-rebalance range, ±${widthPct}%, remains inside the buyer's maximum range after centering on the pinned request price.` : "The provider's declared best post-rebalance range is unavailable, outside the buyer boundary, or fails the unchanged economics contract." },
      { code: "ATTRIBUTABLE_REPLAY_EVIDENCE", status: providerEvidenceSufficient ? "PASS" : "FAIL", detail: providerEvidenceSufficient ? `The admitted width captured at least 100 of ${parsed.measured_window.swaps} replayed swaps, covered at least 10% of the window, earned fees, and preserved positive observed net value after the provider's rebalance-cost model.` : "The provider did not demonstrate meaningful in-range activity and positive replay economics for an admitted width." },
      { code: "EXACT_OUTPUT_CONTRACT", status: exactOutputContract ? "PASS" : "FAIL", detail: exactOutputContract ? "PositionCrew normalized the provider range through the unchanged bounded order, economics, inventory, loss, expiry, and refusal contract." : "The provider thesis did not survive the unchanged PositionCrew grid contract." },
      { code: "FIRST_PARTY_ACTIONABLE_RESULT", status: firstPartyEligible ? "PASS" : "FAIL", detail: firstPartyEligible ? "The first-party provider also returned an actionable grid under the same buyer contract." : "The first-party provider did not return an actionable grid, so PositionCrew cannot claim a two-provider live match." },
    ];
    return {
      ...base,
      outcome: liveMatchEligible ? "SEMANTICALLY_COMPARABLE" : "INCOMPATIBLE",
      externalRecommendation: declaredCandidate ? "BUILD_GRID" : "NO_GRID",
      externalState: "RANGE_REPLAY_READY",
      eligibleForRangeAssessmentActivation: externalEligible,
      eligibleForGridSelection: liveMatchEligible,
      eligibleForLiveMatch: liveMatchEligible,
      attributable: exactPool && exactPair,
      adapterNormalized: Boolean(normalizedDeliverable),
      providerRange: declaredCandidate && declaredCandidate.width_pct !== null && declaredCandidate.price_range
        ? {
            widthPct: declaredCandidate.width_pct,
            lowerPrice: declaredCandidate.price_range.low,
            upperPrice: declaredCandidate.price_range.high,
            netAfterRebalancingUsdInWindow: declaredCandidate.net_after_rebalancing_usd_in_window,
          }
        : null,
      measuredWindow: {
        fromBlock: parsed.measured_window.from_block,
        toBlock: parsed.measured_window.to_block,
        swaps: parsed.measured_window.swaps,
        minutes: parsed.measured_window.minutes,
      },
      ...(normalizedDeliverable ? { normalizedDeliverable } : {}),
      ...(liveMatchEligible
        ? {
            selection: {
              selectedProvider: "POSITIONCREW" as const,
              externalEligible: true,
              basis: "The first-party provider won the native exact-contract tiebreak; the external replay-derived range remained attributable and fully evaluated.",
            },
          }
        : {}),
      checks,
      boundary,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "UNAVAILABLE",
      externalRecommendation: null,
      externalState: null,
      eligibleForRangeAssessmentActivation: false,
      eligibleForGridSelection: false,
      eligibleForLiveMatch: false,
      attributable: false,
      adapterNormalized: false,
      providerRange: null,
      measuredWindow: null,
      ...(firstPartyEligible
        ? {
            selection: {
              selectedProvider: "POSITIONCREW" as const,
              externalEligible: false,
              basis: "The external provider was unavailable; the first-party provider still returned an actionable bounded grid.",
            },
          }
        : {}),
      checks: [{ code: "CALLABLE_RESULT", status: "FAIL", detail: error instanceof Error ? error.message : "Brain on BNB Grid was unavailable." }],
      boundary,
    };
  }
}
