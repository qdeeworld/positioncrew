import { z } from "zod";
import {
  AddressSchema,
  PositiveDecimalSchema,
  UnsignedDecimalSchema,
} from "../contracts/common.js";
import { LpRebalanceRequestSchema } from "../contracts/lp-rebalance.js";
import { YieldOptimizationRequestSchema } from "../contracts/yield-optimization.js";
import { BoundedGridRequestSchema } from "../contracts/bounded-grid.js";
import { PositionCrewRequestSchema } from "../contracts/index.js";
import {
  inspectPancakePosition,
  inspectPancakeGridMarket,
  inspectVenusStableYields,
} from "../telemetry/bsc.js";

export const TERMIX_SERVICES = {
  LENDING_RESCUE: {
    agentId: "cmt4dzxvcli4tw70125nd5ra8",
    listingId: "cmt4e8j3nlmuiw7019f4qf24x",
    credential: "lending",
  },
  LP_REBALANCE: {
    agentId: "cmtvave8t02wgw001wgg2ckgr",
    listingId: "cmtvay77n03cguu01yha0429i",
    credential: "lp",
  },
  YIELD_OPTIMIZATION: {
    agentId: "cmtvavee602wow001ob536zaf",
    listingId: "cmtvay8gz03d2uu01qv1h1r91",
    credential: "yield",
  },
  BOUNDED_GRID: {
    agentId: "cmtvavnib02y4w001uum4edob",
    listingId: "cmtvay99y03dguu011pkb99wv",
    credential: "grid",
  },
} as const;
export const TermixServiceSchema = z.enum([
  "LENDING_RESCUE",
  "LP_REBALANCE",
  "YIELD_OPTIMIZATION",
  "BOUNDED_GRID",
]);
export type TermixService = z.infer<typeof TermixServiceSchema>;
export function serviceForOrder(order: {
  providerAgentId: string;
  listingId: string;
}): TermixService {
  const service = (Object.keys(TERMIX_SERVICES) as TermixService[]).find(
    (s) =>
      TERMIX_SERVICES[s].agentId === order.providerAgentId &&
      TERMIX_SERVICES[s].listingId === order.listingId,
  );
  if (!service)
    throw new Error("Order is not bound to a supported dedicated service");
  return service;
}
const base = {
  schemaVersion: z.literal("positioncrew.termix-capital-request.v1"),
  orderId: z.string().min(1).max(200),
  analysisOnly: z.literal(true),
  maxActionUsd: PositiveDecimalSchema,
  maxGasUsd: PositiveDecimalSchema,
  maxSlippageBps: z.number().int().min(0).max(2000),
};
const lpShape = LpRebalanceRequestSchema.shape.constraints.shape;
const {
  tickSpacing: _tick,
  estimatedGasUsd: _gas,
  estimatedSwapCostUsd: _swap,
  ...lpLimits
} = lpShape;
const gridShape = BoundedGridRequestSchema.shape.constraints.shape;
const {
  estimatedGasUsd: _gridGas,
  capitalUsd: _capital,
  ...gridLimits
} = gridShape;
const Capital = z
  .string()
  .regex(/^\d+(?:\.\d{1,2})?$/)
  .refine(
    (v) => Number(v) >= 1 && Number(v) <= 10000000,
    "Capital must be 1–10000000 USD, at most two decimal places",
  );
export const CapitalBuyerRequestSchema = z.discriminatedUnion("service", [
  z
    .object({
      ...base,
      service: z.literal("LP_REBALANCE"),
      positionTokenId: z
        .string()
        .regex(/^[1-9][0-9]{0,77}$/)
        .refine((v) => BigInt(v) < 2n ** 256n),
      constraints: z
        .object(lpLimits)
        .strict()
        .refine((v) => v.minimumWidthTicks <= v.maximumWidthTicks),
    })
    .strict(),
  z
    .object({
      ...base,
      service: z.literal("YIELD_OPTIMIZATION"),
      account: AddressSchema,
      capitalUsd: Capital,
      capitalSource: z.literal("HYPOTHETICAL"),
      maxExecutionCostUsd: UnsignedDecimalSchema,
      constraints: YieldOptimizationRequestSchema.shape.constraints,
    })
    .strict(),
  z
    .object({
      ...base,
      service: z.literal("BOUNDED_GRID"),
      account: AddressSchema,
      capitalUsd: Capital,
      capitalSource: z.literal("HYPOTHETICAL"),
      constraints: z
        .object({
          ...gridLimits,
          levelCount: z.literal(5),
          orderExpirySeconds: z.number().int().min(60).max(120),
        })
        .strict()
        .refine((v) => Number(v.lowerPrice) < Number(v.upperPrice)),
    })
    .strict(),
]);
export type CapitalBuyerRequest = z.infer<typeof CapitalBuyerRequestSchema>;
export const CapitalBuyerEvidenceSchema = z
  .object({
    source: z.enum(["TERMIX_RUNTIME_INBOX", "TERMIX_ORDER_SCOPE"]),
    conversationId: z.string(),
    messageId: z.string(),
    senderAccountId: z.string(),
    senderWalletAddress: AddressSchema.nullable(),
    messageCreatedAt: z.string().datetime(),
    rawMessageHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    parsedRequestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const CapitalIntakeSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.termix-capital-intake.v1"),
    orderId: z.string(),
    requirements: CapitalBuyerRequestSchema,
    buyerEvidence: CapitalBuyerEvidenceSchema,
  })
  .strict()
  .refine((v) => v.orderId === v.requirements.orderId);
export type CapitalIntake = z.infer<typeof CapitalIntakeSchema>;
export function parseCapitalRequirements(
  text: string,
  orderId: string,
  service: TermixService,
) {
  const input = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  const value = CapitalBuyerRequestSchema.parse({
    ...input,
    orderId: input.orderId ?? orderId,
  });
  if (value.orderId !== orderId || value.service !== service)
    throw new Error("Buyer requirements name a different order or service");
  return value;
}
/** Only live chain facts enter observations. Buyer input controls policy, never prices/costs/addresses of venues. */
export async function observeCapital(intake: CapitalIntake) {
  const r = intake.requirements;
  if (r.service === "LP_REBALANCE") {
    const probe = await inspectPancakePosition(r.positionTokenId);
    if (r.maxSlippageBps > probe.lpRequest.maxSlippageBps)
      throw new Error(
        "Requested slippage exceeds supported live LP cost model",
      );
    const request = LpRebalanceRequestSchema.parse({
      ...probe.lpRequest,
      maxActionUsd: r.maxActionUsd,
      maxGasUsd: r.maxGasUsd,
      maxSlippageBps: r.maxSlippageBps,
      constraints: { ...probe.lpRequest.constraints, ...r.constraints },
    });
    return {
      request: PositionCrewRequestSchema.parse(request),
      source: probe.source,
      generatedAt: probe.generatedAt,
    };
  }
  if (r.service === "YIELD_OPTIMIZATION") {
    const probe = await inspectVenusStableYields({
      account: r.account,
      capitalUsd: Number(r.capitalUsd),
    });
    const request = YieldOptimizationRequestSchema.parse({
      ...probe.yieldRequest,
      maxActionUsd: r.maxActionUsd,
      maxExecutionCostUsd: r.maxExecutionCostUsd,
      maxGasUsd: r.maxGasUsd,
      maxSlippageBps: r.maxSlippageBps,
      constraints: r.constraints,
    });
    return {
      request: PositionCrewRequestSchema.parse(request),
      source: probe.source,
      generatedAt: probe.generatedAt,
    };
  }
  const probe = await inspectPancakeGridMarket({
    account: r.account,
    capitalUsd: Number(r.capitalUsd),
  });
  const request = BoundedGridRequestSchema.parse({
    ...probe.gridRequest,
    maxActionUsd: r.maxActionUsd,
    maxGasUsd: r.maxGasUsd,
    maxSlippageBps: r.maxSlippageBps,
    constraints: { ...probe.gridRequest.constraints, ...r.constraints },
  });
  return {
    request: PositionCrewRequestSchema.parse(request),
    source: probe.source,
    generatedAt: probe.generatedAt,
  };
}
export function capitalRequirementsGuide(
  service: TermixService,
  orderId: string,
) {
  return (
    `This service needs explicit analysis-only requirements before acceptance. Send one JSON object with schemaVersion "positioncrew.termix-capital-request.v1", orderId "${orderId}", service "${service}", analysisOnly true, maxActionUsd, maxGasUsd, maxSlippageBps and constraints. ` +
    (service === "LP_REBALANCE"
      ? "Include positionTokenId and LP limits: minimumWidthTicks, maximumWidthTicks, edgeBufferBps, highVolatilityBps, maximumToken0ShareBps, maximumToken1ShareBps, minimumNetBenefitUsd, evaluationHorizonHours. Slippage at most 30bps."
      : service === "YIELD_OPTIMIZATION"
        ? "Include account, capitalUsd, capitalSource HYPOTHETICAL, maxExecutionCostUsd and limits: protocolAllowlist [Venus Core Pool], maximumRiskTier, maximumProtocolConcentrationBps, maximumLockupSeconds, minimumLiquidityUsd, minimumNetBenefitUsd, evaluationHorizonDays."
        : "Include account, capitalUsd, capitalSource HYPOTHETICAL and limits: lowerPrice, upperPrice, levelCount 5, maximumInventoryUsd, maximumLossUsd, minimumExpectedNetProfitUsd, minimumLiquidityUsd, maximumVolatilityBps, expectedCompletedCycles, orderExpirySeconds (60–120).") +
    " USD amounts are decimal strings. Observed data and transaction costs are read from BSC. Reports do not execute trades; hypothetical capital is not a verified wallet balance."
  );
}
