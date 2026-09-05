import { z } from "zod";
import {
  AddressSchema,
  AssetIdentitySchema,
  BaseRequestFields,
  PositiveDecimalSchema,
  PricedBalanceSchema,
  ProviderStatusSchema,
  SourceObservationSchema,
  TimestampSchema,
  UnsignedDecimalSchema,
  validateRequestWindow,
} from "./common.js";

export const LendingCollateralSchema = PricedBalanceSchema.extend({
  liquidationThresholdBps: z.number().int().min(1).max(10_000),
  collateralEnabled: z.boolean(),
}).strict();

export const LendingDebtSchema = PricedBalanceSchema.strict();

export const AvailableAssetSchema = AssetIdentitySchema.extend({
  availableAmount: UnsignedDecimalSchema,
}).strict();

export const LendingRescueRequestSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.lending-rescue.request.v1"),
    service: z.literal("LENDING_RESCUE"),
    ...BaseRequestFields,
    market: AddressSchema,
    position: z
      .object({
        collateral: z.array(LendingCollateralSchema).max(32),
        debt: z.array(LendingDebtSchema).max(32),
      })
      .strict(),
    availableAssets: z.array(AvailableAssetSchema),
    allowedActions: z
      .array(z.enum(["REPAY_DEBT", "ADD_COLLATERAL"]))
      .min(1)
      .max(2),
    targetHealthFactor: PositiveDecimalSchema,
    stressPriceDropBps: z.number().int().min(0).max(5_000),
    oracleDeviationToleranceBps: z.number().int().min(1).max(2_000),
    estimatedGasUsd: UnsignedDecimalSchema,
  })
  .strict()
  .superRefine(validateRequestWindow)
  .superRefine((value, context) => {
    if (Number(value.targetHealthFactor) <= 1) {
      context.addIssue({
        code: "custom",
        path: ["targetHealthFactor"],
        message: "targetHealthFactor must be greater than 1",
      });
    }
  });

export const LendingActionPlanSchema = z
  .object({
    actionId: z.string().min(8).max(160),
    kind: z.enum(["REPAY_DEBT", "ADD_COLLATERAL"]),
    chainId: z.union([z.literal(56), z.literal(97)]),
    protocol: z.string().min(1).max(80),
    market: AddressSchema,
    account: AddressSchema,
    asset: AssetIdentitySchema,
    amount: PositiveDecimalSchema,
    amountBaseUnits: z.string().regex(/^\d+$/),
    amountUsd: PositiveDecimalSchema,
    estimatedGasUsd: UnsignedDecimalSchema,
    // Null means repayment clears all observed debt; admission verifies that condition.
    projectedHealthFactor: PositiveDecimalSchema.nullable(),
    executeBefore: TimestampSchema,
    maxSlippageBps: z.number().int().min(0).max(2_000),
    preconditions: z.array(z.string().min(1).max(240)).min(1),
  })
  .strict();

export const LendingRescueDeliverableSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.lending-rescue.deliverable.v1"),
    service: z.literal("LENDING_RESCUE"),
    requestId: z.string().min(8).max(120),
    generatedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    status: ProviderStatusSchema,
    decision: z.enum(["REPAY_DEBT", "ADD_COLLATERAL", "NONE"]),
    summary: z.string().min(1).max(400),
    position: z
      .object({
        collateralValueUsd: UnsignedDecimalSchema,
        liquidationWeightedCollateralUsd: UnsignedDecimalSchema,
        debtValueUsd: UnsignedDecimalSchema,
        currentHealthFactor: UnsignedDecimalSchema.nullable(),
        stressedHealthFactor: UnsignedDecimalSchema.nullable(),
        targetHealthFactor: PositiveDecimalSchema,
      })
      .strict(),
    recommendation: LendingActionPlanSchema.nullable(),
    alternatives: z.array(LendingActionPlanSchema),
    refusalReasons: z.array(z.string().min(1).max(240)),
    invalidationConditions: z.array(z.string().min(1).max(240)).min(1),
    limitations: z.array(z.string().min(1).max(240)).min(1),
    sources: z.array(SourceObservationSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const actionable = value.status === "ACTIONABLE";
    if (actionable && (value.decision === "NONE" || value.recommendation === null)) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "ACTIONABLE deliverables require a concrete recommendation",
      });
    }
    if (!actionable && (value.decision !== "NONE" || value.recommendation !== null)) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "Non-actionable deliverables cannot contain an executable recommendation",
      });
    }
  });

export type LendingRescueRequest = z.infer<typeof LendingRescueRequestSchema>;
export type LendingRescueDeliverable = z.infer<typeof LendingRescueDeliverableSchema>;
export type LendingActionPlan = z.infer<typeof LendingActionPlanSchema>;
