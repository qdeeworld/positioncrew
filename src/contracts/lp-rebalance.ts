import { z } from "zod";
import {
  AssetIdentitySchema,
  BaseRequestFields,
  PositiveDecimalSchema,
  ProviderStatusSchema,
  TimestampSchema,
  UnsignedDecimalSchema,
  validateRequestWindow,
} from "./common.js";

export const LpRebalanceRequestSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.lp-rebalance.request.v1"),
    service: z.literal("LP_REBALANCE"),
    ...BaseRequestFields,
    pool: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    token0: AssetIdentitySchema,
    token1: AssetIdentitySchema,
    position: z
      .object({
        lowerTick: z.number().int(),
        upperTick: z.number().int(),
        liquidity: PositiveDecimalSchema,
        positionValueUsd: PositiveDecimalSchema,
        feesEarnedUsd: UnsignedDecimalSchema,
        token0ShareBps: z.number().int().min(0).max(10_000),
        token1ShareBps: z.number().int().min(0).max(10_000),
      })
      .strict()
      .refine((value) => value.lowerTick < value.upperTick, {
        message: "lowerTick must be below upperTick",
        path: ["upperTick"],
      })
      .refine((value) => value.token0ShareBps + value.token1ShareBps === 10_000, {
        message: "inventory shares must sum to 10000 bps",
        path: ["token1ShareBps"],
      }),
    marketState: z
      .object({
        currentTick: z.number().int(),
        token0PriceUsd: PositiveDecimalSchema,
        token1PriceUsd: PositiveDecimalSchema,
        volume24hUsd: UnsignedDecimalSchema,
        fees24hUsd: UnsignedDecimalSchema,
        poolLiquidityUsd: PositiveDecimalSchema,
        realizedVolatilityBps: z.number().int().min(0).max(100_000),
        volumeMeasurementWindowSeconds: z.number().int().positive().optional(),
        volumeNormalizationFactor: PositiveDecimalSchema.optional(),
        swapCount: z.number().int().nonnegative().optional(),
        observedAt: TimestampSchema,
        sourceId: z.string().min(1).max(120),
      })
      .strict(),
    constraints: z
      .object({
        minimumWidthTicks: z.number().int().positive(),
        maximumWidthTicks: z.number().int().positive(),
        tickSpacing: z.number().int().positive(),
        edgeBufferBps: z.number().int().min(100).max(5_000),
        highVolatilityBps: z.number().int().min(1).max(100_000),
        maximumToken0ShareBps: z.number().int().min(0).max(10_000),
        maximumToken1ShareBps: z.number().int().min(0).max(10_000),
        minimumNetBenefitUsd: UnsignedDecimalSchema,
        estimatedGasUsd: UnsignedDecimalSchema,
        estimatedSwapCostUsd: UnsignedDecimalSchema,
        evaluationHorizonHours: z.number().int().min(1).max(720),
      })
      .strict()
      .refine((value) => value.minimumWidthTicks <= value.maximumWidthTicks, {
        message: "minimum width cannot exceed maximum width",
        path: ["maximumWidthTicks"],
      }),
  })
  .strict()
  .superRefine(validateRequestWindow);

export const LpRebalanceDeliverableSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.lp-rebalance.deliverable.v1"),
    service: z.literal("LP_REBALANCE"),
    requestId: z.string().min(8).max(120),
    generatedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    status: ProviderStatusSchema,
    decision: z.enum(["HOLD", "WIDEN", "NARROW", "SHIFT", "EXIT", "NONE"]),
    proposedRange: z
      .object({ lowerTick: z.number().int(), upperTick: z.number().int() })
      .strict()
      .nullable(),
    estimatedRebalanceCostUsd: UnsignedDecimalSchema,
    expectedGrossFeesUsd: UnsignedDecimalSchema,
    expectedNetBenefitUsd: UnsignedDecimalSchema,
    breakEvenHours: UnsignedDecimalSchema.nullable(),
    // Optional only for immutable legacy receipts. New actionable results must
    // expose the assumptions used by the independent financial checker.
    feeProjection: z.object({
      model: z.literal("POOL_SHARE_UPTIME_V1"),
      currentUptimeBps: z.number().int().min(0).max(10_000),
      proposedUptimeBps: z.number().int().min(0).max(10_000),
    }).strict().optional(),
    inventoryExposure: z
      .object({ token0Bps: z.number().int().min(0).max(10_000), token1Bps: z.number().int().min(0).max(10_000) })
      .strict(),
    summary: z.string().min(1).max(400),
    actionSteps: z.array(z.string().min(1).max(240)),
    invalidationConditions: z.array(z.string().min(1).max(240)).min(1),
    limitations: z.array(z.string().min(1).max(240)).min(1),
  })
  .strict();

export type LpRebalanceRequest = z.infer<typeof LpRebalanceRequestSchema>;
export type LpRebalanceDeliverable = z.infer<typeof LpRebalanceDeliverableSchema>;
