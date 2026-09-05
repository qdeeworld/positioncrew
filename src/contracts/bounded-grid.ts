import { z } from "zod";
import {
  AddressSchema,
  AssetIdentitySchema,
  BaseRequestFields,
  PositiveDecimalSchema,
  ProviderStatusSchema,
  TimestampSchema,
  UnsignedDecimalSchema,
  validateRequestWindow,
} from "./common.js";

export const BoundedGridRequestSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.bounded-grid.request.v1"),
    service: z.literal("BOUNDED_GRID"),
    ...BaseRequestFields,
    venue: AddressSchema,
    baseAsset: AssetIdentitySchema,
    quoteAsset: AssetIdentitySchema,
    marketState: z
      .object({
        midPrice: PositiveDecimalSchema,
        liquidityUsd: UnsignedDecimalSchema,
        realizedVolatilityBps: z.number().int().min(0).max(100_000),
        venueFeeBps: z.number().int().min(0).max(1_000),
        observedAt: TimestampSchema,
        sourceId: z.string().min(1).max(120),
      })
      .strict(),
    constraints: z
      .object({
        capitalUsd: PositiveDecimalSchema,
        lowerPrice: PositiveDecimalSchema,
        upperPrice: PositiveDecimalSchema,
        levelCount: z.number().int().min(2).max(100),
        maximumInventoryUsd: PositiveDecimalSchema,
        maximumLossUsd: PositiveDecimalSchema,
        minimumExpectedNetProfitUsd: UnsignedDecimalSchema,
        minimumLiquidityUsd: PositiveDecimalSchema,
        maximumVolatilityBps: z.number().int().min(1).max(100_000),
        expectedCompletedCycles: z.number().int().min(1).max(1_000),
        estimatedGasUsd: UnsignedDecimalSchema,
        orderExpirySeconds: z.number().int().min(60).max(604_800),
      })
      .strict()
      .refine((value) => Number(value.lowerPrice) < Number(value.upperPrice), {
        message: "lowerPrice must be below upperPrice",
        path: ["upperPrice"],
      }),
  })
  .strict()
  .superRefine(validateRequestWindow);

export const GridOrderSchema = z
  .object({
    side: z.enum(["BUY", "SELL"]),
    price: PositiveDecimalSchema,
    baseAmount: PositiveDecimalSchema,
    maximumQuoteAmount: PositiveDecimalSchema,
  })
  .strict();

export const BoundedGridDeliverableSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.bounded-grid.deliverable.v1"),
    service: z.literal("BOUNDED_GRID"),
    requestId: z.string().min(8).max(120),
    generatedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    status: ProviderStatusSchema,
    decision: z.enum(["BUILD_GRID", "NO_GRID", "NONE"]),
    orders: z.array(GridOrderSchema),
    grossSpreadCaptureUsd: UnsignedDecimalSchema,
    estimatedFeesUsd: UnsignedDecimalSchema,
    estimatedSlippageUsd: UnsignedDecimalSchema,
    estimatedGasUsd: UnsignedDecimalSchema,
    expectedNetProfitUsd: UnsignedDecimalSchema,
    riskModel: z.literal("FINITE_GRID_ZERO_PRICE_STRESS_V1").optional(),
    worstCaseLossUsd: UnsignedDecimalSchema,
    maximumInventoryUsd: UnsignedDecimalSchema,
    summary: z.string().min(1).max(400),
    cancellationConditions: z.array(z.string().min(1).max(240)).min(1),
    limitations: z.array(z.string().min(1).max(240)).min(1),
  })
  .strict();

export type BoundedGridRequest = z.infer<typeof BoundedGridRequestSchema>;
export type BoundedGridDeliverable = z.infer<typeof BoundedGridDeliverableSchema>;
