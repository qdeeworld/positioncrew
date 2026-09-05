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

const YieldPositionSchema = z
  .object({
    opportunityId: z.string().min(1).max(160),
    protocol: z.string().min(1).max(80),
    vaultOrMarket: AddressSchema,
    asset: AssetIdentitySchema,
    amountUsd: UnsignedDecimalSchema,
    grossApyBps: z.number().int().min(0).max(1_000_000),
    liquidityUsd: UnsignedDecimalSchema,
    lockupSeconds: z.number().int().min(0),
    estimatedEntryCostUsd: UnsignedDecimalSchema,
    estimatedExitCostUsd: UnsignedDecimalSchema,
    riskTier: z.enum(["LOW", "MEDIUM", "HIGH"]),
    observedAt: TimestampSchema,
    sourceId: z.string().min(1).max(120),
  })
  .strict();

export const YieldOptimizationRequestSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.yield-optimization.request.v1"),
    service: z.literal("YIELD_OPTIMIZATION"),
    ...BaseRequestFields,
    capitalUsd: PositiveDecimalSchema.describe(
      "Total managed principal, including current positions and idle funds; migration costs are funded from this amount.",
    ),
    currentPositions: z.array(YieldPositionSchema),
    opportunities: z.array(YieldPositionSchema).min(1),
    constraints: z
      .object({
        protocolAllowlist: z.array(z.string().min(1).max(80)).min(1),
        maximumRiskTier: z.enum(["LOW", "MEDIUM", "HIGH"]),
        maximumProtocolConcentrationBps: z.number().int().min(1).max(10_000),
        maximumLockupSeconds: z.number().int().min(0),
        minimumLiquidityUsd: UnsignedDecimalSchema,
        minimumNetBenefitUsd: UnsignedDecimalSchema,
        evaluationHorizonDays: z.number().int().min(1).max(365),
      })
      .strict(),
  })
  .strict()
  .superRefine(validateRequestWindow);

export const YieldOptimizationDeliverableSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.yield-optimization.deliverable.v1"),
    service: z.literal("YIELD_OPTIMIZATION"),
    requestId: z.string().min(8).max(120),
    generatedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    status: ProviderStatusSchema,
    decision: z.enum(["HOLD", "SUPPLY", "WITHDRAW", "MIGRATE", "NONE"]),
    selectedOpportunityId: z.string().min(1).max(160).nullable(),
    allocationUsd: UnsignedDecimalSchema,
    grossApyBps: z.number().int().min(0).nullable(),
    currentWeightedApyBps: z.number().int().min(0),
    annualYieldUpliftUsd: UnsignedDecimalSchema,
    netBenefitUsd: UnsignedDecimalSchema,
    migrationCostUsd: UnsignedDecimalSchema,
    breakEvenDays: UnsignedDecimalSchema.nullable(),
    // Optional for historical v1 records. New actionable results include the
    // complete funding plan so an independent evaluator can reconstruct it.
    withdrawals: z.array(z.object({
      opportunityId: z.string().min(1).max(160),
      amountUsd: PositiveDecimalSchema,
    }).strict()).optional(),
    idleCapitalUsedUsd: UnsignedDecimalSchema.optional(),
    finalProtocolAllocations: z.array(z.object({
      protocol: z.string().min(1).max(80),
      amountUsd: UnsignedDecimalSchema,
    }).strict()).optional(),
    remainingIdleCapitalUsd: UnsignedDecimalSchema.optional(),
    postMigrationCapitalUsd: UnsignedDecimalSchema.optional(),
    summary: z.string().min(1).max(400),
    actionSteps: z.array(z.string().min(1).max(240)),
    risks: z.array(z.string().min(1).max(240)).min(1),
    invalidationConditions: z.array(z.string().min(1).max(240)).min(1),
  })
  .strict();

export type YieldOptimizationRequest = z.infer<typeof YieldOptimizationRequestSchema>;
export type YieldOptimizationDeliverable = z.infer<typeof YieldOptimizationDeliverableSchema>;
