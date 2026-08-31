import { z } from "zod";
import { AddressSchema } from "../contracts/common.js";
import {
  LendingRescueRequestSchema,
  type LendingRescueRequest,
} from "../contracts/lending-rescue.js";

export const HEYANON_VENUS_ENDPOINT = "https://erc8004.heyanon.ai/mcp/venus";
export const HEYANON_VENUS_IDENTITY = {
  chainId: 56,
  tokenId: "43129",
  registry: "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
  owner: "0xda977767452c5dd021624511f14df67b6c9c2c1b",
} as const;

const NumericStringSchema = z.string().regex(/^\d+(?:\.\d+)?$/);

const McpEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().int(),
  result: z.object({
    structuredContent: z.unknown(),
  }).passthrough(),
}).passthrough();

const LiquidityContentSchema = z.object({
  project: z.literal("venus"),
  operation: z.literal("getAccountLiquidity"),
  data: z.array(z.object({
    chain: z.literal("bsc"),
    pool: z.literal("CORE"),
    borrowLimit: NumericStringSchema,
    shortfall: NumericStringSchema,
  }).strict()).length(1),
}).strict();

const EnabledCollateralContentSchema = z.object({
  project: z.literal("venus"),
  operation: z.literal("getEnabledCollateral"),
  data: z.object({
    enabledAssets: z.array(z.object({
      symbol: z.string().min(1),
      address: AddressSchema,
    }).strict()),
  }).strict(),
}).strict();

const BalanceContentSchema = z.object({
  project: z.literal("venus"),
  operation: z.enum(["getVenusBalance", "getBorrowBalance"]),
  data: z.object({
    chainName: z.literal("bsc"),
    pool: z.literal("CORE"),
    balances: z.array(z.object({
      tokenSymbol: z.string().min(1),
      balance: NumericStringSchema,
    }).strict()),
  }).strict(),
}).strict();

const SupportedTokensContentSchema = z.object({
  project: z.literal("venus"),
  operation: z.literal("getSupportedTokens"),
  data: z.array(z.object({
    chain: z.literal("bsc"),
    tokens: z.array(z.string().min(1)),
  }).strict()).length(1),
}).strict();

export const HeyAnonVenusSnapshotSchema = z.object({
  schemaVersion: z.literal("positioncrew.heyanon-venus-snapshot.v1"),
  observedAt: z.string().datetime({ offset: true }),
  requestedAccount: AddressSchema,
  chainId: z.literal(56),
  pool: z.literal("CORE"),
  identity: z.object({
    chainId: z.literal(56),
    tokenId: z.literal("43129"),
    registry: AddressSchema,
    owner: AddressSchema,
  }).strict(),
  endpoint: z.literal(HEYANON_VENUS_ENDPOINT),
  endpointDomainVerified: z.literal(false),
  supportedTokens: SupportedTokensContentSchema,
  omittedRequestSymbols: z.array(z.string().min(1)),
  liquidity: LiquidityContentSchema,
  enabledCollateral: EnabledCollateralContentSchema,
  supplied: BalanceContentSchema,
  borrowed: BalanceContentSchema,
}).strict();

export type HeyAnonVenusSnapshot = z.infer<typeof HeyAnonVenusSnapshotSchema>;

export const HeyAnonCompatibilityCheckSchema = z.object({
  code: z.enum([
    "PUBLIC_REMOTE_ENDPOINT",
    "OUTPUT_ACCOUNT_ATTRIBUTION",
    "BSC_CORE_POOL_BINDING",
    "POSITION_BALANCE_COVERAGE",
    "PROTOCOL_LIQUIDITY",
    "BLOCK_ATTRIBUTION",
    "PRICE_AND_THRESHOLD_EVIDENCE",
    "HEALTH_FACTOR",
    "STRESS_TABLE",
    "BOUNDED_RESCUE_DECISION",
    "ENDPOINT_DOMAIN_CONTROL",
  ]),
  status: z.enum(["PASS", "FAIL"]),
  detail: z.string().min(1).max(320),
}).strict();

export const HeyAnonCompatibilityResultSchema = z.object({
  schemaVersion: z.literal("positioncrew.heyanon-compatibility.v1"),
  status: z.literal("PARTIAL_COMPATIBILITY"),
  eligibleForLendingRescue: z.literal(false),
  checks: z.array(HeyAnonCompatibilityCheckSchema).length(11),
  boundary: z.literal(
    "The external endpoint is callable and can independently read current Venus account state, but it does not satisfy the complete block-pinned PositionCrew Lending Rescue contract.",
  ),
}).strict();

export type HeyAnonCompatibilityResult = z.infer<typeof HeyAnonCompatibilityResultSchema>;

function normalizedSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function amountAgrees(left: string, right: string): boolean {
  if (left.trim() === "" || right.trim() === "") return false;
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(0.00001, Math.max(Math.abs(a), Math.abs(b)) * 0.000001);
}

async function callMcpTool(
  id: number,
  name: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(HEYANON_VENUS_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HeyAnon ${name} returned HTTP ${response.status}`);
  const envelope = McpEnvelopeSchema.parse(await response.json());
  return envelope.result.structuredContent;
}

export async function probeHeyAnonVenus(
  requestInput: LendingRescueRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<HeyAnonVenusSnapshot> {
  const request = LendingRescueRequestSchema.parse(requestInput);
  if (request.chainId !== 56 || request.protocol !== "Venus Classic") {
    throw new Error("HeyAnon Venus adapter supports only Venus Classic on BSC mainnet");
  }
  const tokenSymbols = [...new Set([
    ...request.position.collateral.map((entry) => normalizedSymbol(entry.symbol)),
    ...request.position.debt.map((entry) => normalizedSymbol(entry.symbol)),
  ])];
  const common = { chainName: "bsc", pool: "CORE", userAddress: request.account };
  const supportedTokens = SupportedTokensContentSchema.parse(await callMcpTool(
    1,
    "getSupportedTokens",
    { chainNames: ["bsc"], pool: "CORE" },
    fetchImpl,
  ));
  const supportedByNormalizedSymbol = new Map(supportedTokens.data[0]!.tokens.map((symbol) => [
    normalizedSymbol(symbol),
    symbol,
  ]));
  const callableSymbols = tokenSymbols.flatMap((symbol) => {
    const supported = supportedByNormalizedSymbol.get(symbol);
    return supported ? [supported] : [];
  });
  const omittedRequestSymbols = tokenSymbols.filter((symbol) =>
    !supportedByNormalizedSymbol.has(symbol)
  );
  const [liquidity, enabledCollateral, supplied, borrowed] = await Promise.all([
    callMcpTool(2, "getAccountLiquidity", {
      chainNames: ["bsc"],
      pool: "CORE",
      userAddress: request.account,
    }, fetchImpl),
    callMcpTool(3, "getEnabledCollateral", common, fetchImpl),
    callMcpTool(4, "getVenusBalance", {
      ...common,
      tokenSymbols: callableSymbols,
    }, fetchImpl),
    callMcpTool(5, "getBorrowBalance", {
      ...common,
      tokenSymbols: callableSymbols,
    }, fetchImpl),
  ]);

  return HeyAnonVenusSnapshotSchema.parse({
    schemaVersion: "positioncrew.heyanon-venus-snapshot.v1",
    observedAt: new Date().toISOString(),
    requestedAccount: request.account,
    chainId: 56,
    pool: "CORE",
    identity: HEYANON_VENUS_IDENTITY,
    endpoint: HEYANON_VENUS_ENDPOINT,
    endpointDomainVerified: false,
    supportedTokens,
    omittedRequestSymbols,
    liquidity: LiquidityContentSchema.parse(liquidity),
    enabledCollateral: EnabledCollateralContentSchema.parse(enabledCollateral),
    supplied: BalanceContentSchema.parse(supplied),
    borrowed: BalanceContentSchema.parse(borrowed),
  });
}

export function evaluateHeyAnonCompatibility(
  requestInput: LendingRescueRequest,
  snapshotInput: HeyAnonVenusSnapshot,
  positionCrewLiquidityUsd?: string,
): HeyAnonCompatibilityResult {
  const request = LendingRescueRequestSchema.parse(requestInput);
  const snapshot = HeyAnonVenusSnapshotSchema.parse(snapshotInput);
  const supplied = new Map(snapshot.supplied.data.balances.map((entry) => [
    normalizedSymbol(entry.tokenSymbol),
    entry.balance,
  ]));
  const borrowed = new Map(snapshot.borrowed.data.balances.map((entry) => [
    normalizedSymbol(entry.tokenSymbol),
    entry.balance,
  ]));
  const missingOrDifferent = [
    ...request.position.collateral
      .filter((entry) => !amountAgrees(entry.amount, supplied.get(normalizedSymbol(entry.symbol)) ?? ""))
      .map((entry) => `supplied ${entry.symbol}`),
    ...request.position.debt
      .filter((entry) => !amountAgrees(entry.amount, borrowed.get(normalizedSymbol(entry.symbol)) ?? ""))
      .map((entry) => `borrowed ${entry.symbol}`),
  ];
  const externalLiquidity = snapshot.liquidity.data[0]!.borrowLimit;
  const liquidityAgrees = positionCrewLiquidityUsd !== undefined &&
    Math.abs(Number(externalLiquidity) - Number(positionCrewLiquidityUsd)) < 0.01;

  return HeyAnonCompatibilityResultSchema.parse({
    schemaVersion: "positioncrew.heyanon-compatibility.v1",
    status: "PARTIAL_COMPATIBILITY",
    eligibleForLendingRescue: false,
    checks: [
      {
        code: "PUBLIC_REMOTE_ENDPOINT",
        status: "PASS",
        detail: "The anonymous public MCP endpoint returned structured Venus results.",
      },
      {
        code: "OUTPUT_ACCOUNT_ATTRIBUTION",
        status: "FAIL",
        detail: `The call was made for ${request.account}, but the returned payload does not echo or cryptographically bind the account.`,
      },
      {
        code: "BSC_CORE_POOL_BINDING",
        status: "PASS",
        detail: "All returned balance and liquidity records identify BSC and the Venus Core Pool.",
      },
      {
        code: "POSITION_BALANCE_COVERAGE",
        status: missingOrDifferent.length === 0 ? "PASS" : "FAIL",
        detail: missingOrDifferent.length === 0
          ? "Returned supplied and borrowed balances agree with the current PositionCrew request within the bounded timing tolerance."
          : `Missing or divergent balances: ${missingOrDifferent.join(", ")}. Unsupported request symbols: ${snapshot.omittedRequestSymbols.join(", ") || "none"}.`,
      },
      {
        code: "PROTOCOL_LIQUIDITY",
        status: liquidityAgrees ? "PASS" : "FAIL",
        detail: liquidityAgrees
          ? `External borrow limit ${externalLiquidity} agrees with PositionCrew ${positionCrewLiquidityUsd} to the external provider's precision.`
          : "No matching PositionCrew protocol-liquidity observation was supplied for comparison.",
      },
      {
        code: "BLOCK_ATTRIBUTION",
        status: "FAIL",
        detail: "The external output does not identify the BSC block used for any read.",
      },
      {
        code: "PRICE_AND_THRESHOLD_EVIDENCE",
        status: "FAIL",
        detail: "The output omits oracle prices, collateral factors, and liquidation thresholds.",
      },
      {
        code: "HEALTH_FACTOR",
        status: "FAIL",
        detail: "The output does not calculate or return a health factor.",
      },
      {
        code: "STRESS_TABLE",
        status: "FAIL",
        detail: "The output does not stress the position under collateral price declines.",
      },
      {
        code: "BOUNDED_RESCUE_DECISION",
        status: "FAIL",
        detail: "The output does not return a bounded repay or add-collateral decision with expiry and guards.",
      },
      {
        code: "ENDPOINT_DOMAIN_CONTROL",
        status: "FAIL",
        detail: "8004scan reports that the advertised endpoint domains do not publish a matching domain-control record.",
      },
    ],
    boundary: "The external endpoint is callable and can independently read current Venus account state, but it does not satisfy the complete block-pinned PositionCrew Lending Rescue contract.",
  });
}
