import { z } from "zod";
import { BoundedGridRequestSchema } from "../contracts/bounded-grid.js";
import { LendingRescueRequestSchema } from "../contracts/lending-rescue.js";
import { LpRebalanceDeliverableSchema, LpRebalanceRequestSchema } from "../contracts/lp-rebalance.js";
import { YieldOptimizationDeliverableSchema, YieldOptimizationRequestSchema } from "../contracts/yield-optimization.js";
import { LendingProviderAuditionSchema } from "../marketplace/lending-provider-audition.js";

export const FRESH_MARKETPLACE_HISTORICAL_TASKS = {
  "lending-rescue": {
    providerSlug: "lending-rescue",
    service: "LENDING_RESCUE",
    requestSchema: "positioncrew.lending-rescue.request.v1",
  },
  "lp-rebalance": {
    providerSlug: "lp-rebalance",
    service: "LP_REBALANCE",
    requestSchema: "positioncrew.lp-rebalance.request.v1",
  },
  "bounded-grid": {
    providerSlug: "bounded-grid",
    service: "BOUNDED_GRID",
    requestSchema: "positioncrew.bounded-grid.request.v1",
  },
} as const;

export const FRESH_MARKETPLACE_TASKS = {
  ...FRESH_MARKETPLACE_HISTORICAL_TASKS,
  "yield-optimization": {
    providerSlug: "yield-optimization",
    service: "YIELD_OPTIMIZATION",
    requestSchema: "positioncrew.yield-optimization.request.v1",
  },
} as const;

export const FRESH_MARKETPLACE_HISTORICAL_CLAIM_BOUNDARY = [
  "This is a public-workspace run of a frozen historical benchmark fixture.",
  "The run costs $0.00, requires no wallet, and creates no payment or settlement.",
  "The server receipt proves only this PositionCrew request, provider selection, result, and timing trace.",
  "It does not establish an external buyer, paid demand, third-party protocol execution, onchain immutability, or live financial advice.",
] as const;

export const FRESH_MARKETPLACE_CURRENT_CLAIM_BOUNDARY = [
  "This run evaluates the exact block-referenced BSC observation persisted when the public hire was created.",
  "The run costs $0.00, requires no wallet, and creates no payment, settlement, custody, signature, or protocol transaction.",
  "The server receipt commits to the request, provider binding, declared block evidence, bounded result, evaluation, and timing trace.",
  "The observation is caller-supplied and is not independently re-fetched during execution; the result must be revalidated before any financial action.",
] as const;

// Backward-compatible name used by the frozen fixture evidence and its tests.
export const FRESH_MARKETPLACE_CLAIM_BOUNDARY = FRESH_MARKETPLACE_HISTORICAL_CLAIM_BOUNDARY;

const IdempotencyKeySchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });
const baseRequest = {
  schemaVersion: z.literal("positioncrew.fresh-marketplace-hire-request.v1"),
  idempotencyKey: IdempotencyKeySchema,
};
const CurrentBlockPinnedObservationSchema = z.object({
  blockNumber: z.string().regex(/^[1-9]\d*$/),
  observedAt: IsoTimestampSchema,
  explorerUrl: z.string().url(),
}).strict();

type CurrentBlockBinding = {
  observation: z.infer<typeof CurrentBlockPinnedObservationSchema>;
  request: {
    chainId: number;
    protocol: string;
    sources: Array<{
      sourceId: string;
      uri: string;
      observedAt: string;
    }>;
  };
};

function validateCurrentBlockBinding(
  value: CurrentBlockBinding,
  context: z.RefinementCtx,
  expected: { protocol: string; sourceId: string },
): void {
  const expectedExplorerUrl = `https://bscscan.com/block/${value.observation.blockNumber}`;
  const source = value.request.sources[0];
  if (value.request.chainId !== 56) {
    context.addIssue({
      code: "custom",
      path: ["request", "chainId"],
      message: "Current marketplace hires require BSC mainnet chainId 56",
    });
  }
  if (value.request.protocol !== expected.protocol) {
    context.addIssue({
      code: "custom",
      path: ["request", "protocol"],
      message: `Current marketplace hire protocol must be ${expected.protocol}`,
    });
  }
  if (value.request.sources.length !== 1 || source?.sourceId !== expected.sourceId) {
    context.addIssue({
      code: "custom",
      path: ["request", "sources"],
      message: `Current marketplace hire must contain exactly source ${expected.sourceId}`,
    });
  }
  if (
    value.observation.explorerUrl !== expectedExplorerUrl ||
    source?.uri !== value.observation.explorerUrl ||
    source?.observedAt !== value.observation.observedAt
  ) {
    context.addIssue({
      code: "custom",
      path: ["observation"],
      message: "Observation block, explorer URL, and source timestamp must match exactly",
    });
  }
}

export const CurrentBlockPinnedEvidenceSchema = z.object({
  schemaVersion: z.literal("positioncrew.current-block-pinned-evidence.v1"),
  evidenceClass: z.literal("CURRENT_BLOCK_PINNED"),
  chainId: z.literal(56),
  source: CurrentBlockPinnedObservationSchema,
  freshnessAtCreation: z.enum(["FRESH", "STALE", "FUTURE_DATED"]),
  evaluatedAt: IsoTimestampSchema,
  maxDataAgeSeconds: z.number().int().min(15).max(3_600),
  providerAudition: LendingProviderAuditionSchema.optional(),
  externalLendingComparison: z.object({
    schemaVersion: z.literal("positioncrew.external-lending-comparison-summary.v1"),
    provider: z.object({
      name: z.string().min(1),
      erc8004TokenId: z.string().regex(/^[1-9]\d*$/),
      endpoint: z.string().url(),
    }).strict(),
    evaluatedAt: IsoTimestampSchema,
    account: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    outcome: z.enum(["SEMANTICALLY_COMPARABLE", "INCOMPATIBLE", "UNAVAILABLE"]),
    attributableResult: z.boolean(),
    completedSamePositionAssessment: z.boolean(),
    persistedByProvider: z.boolean(),
    externalHealthFactor: z.string().nullable(),
    firstPartyHealthFactor: z.string().nullable(),
    healthFactorDifferenceBps: z.number().nonnegative().nullable(),
    externalRiskStatus: z.string().min(1),
    firstPartyDecision: z.string().min(1),
    exactRequestAccepted: z.literal(false),
    eligibleForMonitoringActivation: z.boolean(),
    eligibleForRescueSelection: z.literal(false),
    eligibleForLiveMatch: z.literal(false),
    checks: z.array(z.object({
      code: z.string().min(1),
      status: z.enum(["PASS", "FAIL"]),
      detail: z.string().min(1),
    }).strict()).min(1),
    boundary: z.string().min(1),
  }).strict().optional(),
  externalProviderComparison: z.object({
    schemaVersion: z.literal("positioncrew.external-lp-comparison-summary.v1"),
    provider: z.object({
      name: z.string().min(1),
      erc8004TokenId: z.string().regex(/^[1-9]\d*$/),
      endpoint: z.string().url(),
    }).strict(),
    evaluatedAt: IsoTimestampSchema,
    positionTokenId: z.string().regex(/^[1-9]\d*$/),
    outcome: z.enum(["SEMANTICALLY_COMPARABLE", "INCOMPATIBLE", "UNAVAILABLE"]),
    attributableResult: z.boolean(),
    completedSamePositionAssessment: z.boolean(),
    persistedByProvider: z.boolean(),
    externalDecision: z.enum(["HOLD", "REBALANCE", "UNKNOWN"]),
    firstPartyDecision: z.string().min(1),
    exactRequestAccepted: z.literal(false),
    eligibleForPositionAssessmentActivation: z.boolean(),
    eligibleForLiveMatch: z.boolean(),
    adapterNormalized: z.boolean().optional(),
    externalRange: z.object({
      lowerTick: z.number().int(),
      upperTick: z.number().int(),
      widthTicks: z.number().int().positive(),
    }).strict().optional(),
    normalizedDeliverable: LpRebalanceDeliverableSchema.optional(),
    selection: z.object({
      selectedProvider: z.enum(["POSITIONCREW", "EXTERNAL"]),
      externalEligible: z.boolean(),
      basis: z.string().min(1),
    }).strict().optional(),
    checks: z.array(z.object({
      code: z.string().min(1),
      status: z.enum(["PASS", "FAIL"]),
      detail: z.string().min(1),
    }).strict()).min(1),
    boundary: z.string().min(1),
  }).strict().optional(),
  externalGridComparison: z.object({
    schemaVersion: z.literal("positioncrew.external-grid-comparison-summary.v1"),
    provider: z.object({
      name: z.string().min(1),
      erc8004TokenId: z.string().regex(/^[1-9]\d*$/),
      endpoint: z.string().url(),
    }).strict(),
    evaluatedAt: IsoTimestampSchema,
    pool: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    outcome: z.enum(["PARTIAL_COMPATIBILITY", "INCOMPATIBLE", "UNAVAILABLE"]),
    positionCrewDecision: z.string().min(1),
    externalRecommendation: z.string().min(1).nullable(),
    externalState: z.string().min(1).nullable(),
    tickLower: z.number().int().nullable(),
    tickUpper: z.number().int().nullable(),
    exactRangeAccepted: z.boolean(),
    attributable: z.boolean(),
    persisted: z.boolean(),
    exactRequestAccepted: z.literal(false),
    eligibleForRangeAssessmentActivation: z.boolean(),
    eligibleForGridSelection: z.literal(false),
    eligibleForLiveMatch: z.literal(false),
    checks: z.array(z.object({
      code: z.string().min(1),
      status: z.enum(["PASS", "FAIL"]),
      detail: z.string().min(1),
    }).strict()).min(1),
    boundary: z.string().min(1),
  }).strict().optional(),
  externalYieldComparison: z.object({
    schemaVersion: z.literal("positioncrew.external-yield-comparison-summary.v1"),
    provider: z.object({
      name: z.string().min(1),
      erc8004TokenId: z.string().regex(/^[1-9]\d*$/),
      endpoint: z.string().url(),
    }).strict(),
    evaluatedAt: IsoTimestampSchema,
    outcome: z.enum(["SEMANTICALLY_COMPARABLE", "PARTIAL_COMPATIBILITY", "INCOMPATIBLE", "UNAVAILABLE"]),
    marketCount: z.number().int().positive(),
    positionCrewSelectedMarket: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullable(),
    externalRecommendedMarket: z.string().regex(/^0x[a-fA-F0-9]{40}$/).nullable(),
    sameRateLeader: z.boolean(),
    positionCrewGrossApyBps: z.number().int().nonnegative().nullable(),
    externalSimpleAnnualRateBps: z.number().int().nonnegative().nullable(),
    rateDifferenceBps: z.number().int().nonnegative().nullable(),
    attributable: z.boolean(),
    persisted: z.boolean(),
    exactRequestAccepted: z.literal(false),
    eligibleForRateRankingActivation: z.boolean(),
    eligibleForYieldSelection: z.boolean(),
    eligibleForLiveMatch: z.boolean(),
    adapterNormalized: z.boolean().optional(),
    normalizedDeliverable: YieldOptimizationDeliverableSchema.optional(),
    selection: z.object({
      selectedProvider: z.enum(["POSITIONCREW", "EXTERNAL"]),
      externalEligible: z.boolean(),
      basis: z.string().min(1),
    }).strict().optional(),
    checks: z.array(z.object({
      code: z.string().min(1),
      status: z.enum(["PASS", "FAIL"]),
      detail: z.string().min(1),
    }).strict()).min(1),
    boundary: z.string().min(1),
  }).strict().optional(),
}).strict();

export const HistoricalFixtureEvidenceSchema = z.object({
  schemaVersion: z.literal("positioncrew.historical-fixture-evidence.v1"),
  evidenceClass: z.literal("HISTORICAL_FIXTURE"),
  benchmarkSlug: z.enum(["lending-rescue", "lp-rebalance", "bounded-grid"]),
  requestSchema: z.string().min(1),
}).strict();

export const CurrentLendingMarketplaceHireRequestSchema = z.object({
  schemaVersion: z.literal("positioncrew.fresh-marketplace-hire-request.v2"),
  idempotencyKey: IdempotencyKeySchema,
  benchmarkSlug: z.literal("lending-rescue"),
  providerSlug: z.literal("lending-rescue"),
  evidenceMode: z.literal("CURRENT_BLOCK_PINNED"),
  observation: CurrentBlockPinnedObservationSchema,
  request: LendingRescueRequestSchema,
}).strict().superRefine((value, context) => {
  validateCurrentBlockBinding(value, context, {
    protocol: "Venus Classic",
    sourceId: `venus-mainnet-block-${value.observation.blockNumber}`,
  });
  if (value.request.market.toLowerCase() !== "0xfd36e2c2a6789db23113685031d7f16329158384") {
    context.addIssue({ code: "custom", path: ["request", "market"], message: "Current lending hires require the Venus Classic Comptroller" });
  }
  // Entry-level timestamp/source inconsistencies remain valid persisted inputs so the
  // existing provider and evaluator can return a durable REFUSED_INCONSISTENT_DATA receipt.
});

export const LendingProviderAuditionHireRequestSchema = z.object({
  schemaVersion: z.literal("positioncrew.lending-provider-audition-hire-request.v1"),
  idempotencyKey: IdempotencyKeySchema,
  evidenceMode: z.literal("CURRENT_BLOCK_PINNED"),
  observation: CurrentBlockPinnedObservationSchema,
  request: LendingRescueRequestSchema,
}).strict().superRefine((value, context) => {
  validateCurrentBlockBinding(value, context, {
    protocol: "Venus Classic",
    sourceId: `venus-mainnet-block-${value.observation.blockNumber}`,
  });
  if (value.request.market.toLowerCase() !== "0xfd36e2c2a6789db23113685031d7f16329158384") {
    context.addIssue({
      code: "custom",
      path: ["request", "market"],
      message: "Current lending auditions require the Venus Classic Comptroller",
    });
  }
});

export const CurrentLpMarketplaceHireRequestSchema = z.object({
  schemaVersion: z.literal("positioncrew.fresh-marketplace-hire-request.v2"),
  idempotencyKey: IdempotencyKeySchema,
  benchmarkSlug: z.literal("lp-rebalance"),
  providerSlug: z.literal("lp-rebalance"),
  evidenceMode: z.literal("CURRENT_BLOCK_PINNED"),
  observation: CurrentBlockPinnedObservationSchema,
  request: LpRebalanceRequestSchema,
}).strict().superRefine((value, context) => {
  validateCurrentBlockBinding(value, context, {
    protocol: "PancakeSwap V3 position analysis",
    sourceId: `pancake-position-mainnet-block-${value.observation.blockNumber}`,
  });
  if (!new RegExp(`^pancake-position-[1-9]\\d*-${value.observation.blockNumber}$`).test(value.request.requestId)) {
    context.addIssue({
      code: "custom",
      path: ["request", "requestId"],
      message: "LP requestId must bind the position token ID and observation block",
    });
  }
});

export const CurrentYieldMarketplaceHireRequestSchema = z.object({
  schemaVersion: z.literal("positioncrew.fresh-marketplace-hire-request.v2"),
  idempotencyKey: IdempotencyKeySchema,
  benchmarkSlug: z.literal("yield-optimization"),
  providerSlug: z.literal("yield-optimization"),
  evidenceMode: z.literal("CURRENT_BLOCK_PINNED"),
  observation: CurrentBlockPinnedObservationSchema,
  request: YieldOptimizationRequestSchema,
}).strict().superRefine((value, context) => {
  validateCurrentBlockBinding(value, context, {
    protocol: "Venus Core Pool stablecoin supply",
    sourceId: `venus-yield-mainnet-block-${value.observation.blockNumber}`,
  });
  if (value.request.requestId !== `venus-yield-${value.observation.blockNumber}`) {
    context.addIssue({
      code: "custom",
      path: ["request", "requestId"],
      message: "Yield requestId must bind the observation block",
    });
  }
});

export const CurrentGridMarketplaceHireRequestSchema = z.object({
  schemaVersion: z.literal("positioncrew.fresh-marketplace-hire-request.v2"),
  idempotencyKey: IdempotencyKeySchema,
  benchmarkSlug: z.literal("bounded-grid"),
  providerSlug: z.literal("bounded-grid"),
  evidenceMode: z.literal("CURRENT_BLOCK_PINNED"),
  observation: CurrentBlockPinnedObservationSchema,
  request: BoundedGridRequestSchema,
}).strict().superRefine((value, context) => {
  validateCurrentBlockBinding(value, context, {
    protocol: "PancakeSwap V3 bounded grid policy",
    sourceId: `pancake-v3-mainnet-block-${value.observation.blockNumber}`,
  });
  if (value.request.requestId !== `pancake-grid-${value.observation.blockNumber}`) {
    context.addIssue({
      code: "custom",
      path: ["request", "requestId"],
      message: "Grid requestId must bind the observation block",
    });
  }
});

export const FreshMarketplaceHireRequestSchema = z.union([
  z.object({
    ...baseRequest,
    benchmarkSlug: z.literal("lending-rescue"),
    providerSlug: z.literal("lending-rescue"),
  }).strict(),
  z.object({
    ...baseRequest,
    benchmarkSlug: z.literal("lp-rebalance"),
    providerSlug: z.literal("lp-rebalance"),
  }).strict(),
  z.object({
    ...baseRequest,
    benchmarkSlug: z.literal("bounded-grid"),
    providerSlug: z.literal("bounded-grid"),
  }).strict(),
  CurrentLendingMarketplaceHireRequestSchema,
  CurrentLpMarketplaceHireRequestSchema,
  CurrentYieldMarketplaceHireRequestSchema,
  CurrentGridMarketplaceHireRequestSchema,
]);

export const FreshMarketplaceJobStateSchema = z.enum([
  "CREATED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
]);

export const FreshMarketplaceChainSchema = z.object({
  schemaVersion: z.literal("positioncrew.fresh-marketplace-chain.v1"),
  claimBoundary: z.union([
    z.tuple([
      z.literal(FRESH_MARKETPLACE_HISTORICAL_CLAIM_BOUNDARY[0]),
      z.literal(FRESH_MARKETPLACE_HISTORICAL_CLAIM_BOUNDARY[1]),
      z.literal(FRESH_MARKETPLACE_HISTORICAL_CLAIM_BOUNDARY[2]),
      z.literal(FRESH_MARKETPLACE_HISTORICAL_CLAIM_BOUNDARY[3]),
    ]),
    z.tuple([
      z.literal(FRESH_MARKETPLACE_CURRENT_CLAIM_BOUNDARY[0]),
      z.literal(FRESH_MARKETPLACE_CURRENT_CLAIM_BOUNDARY[1]),
      z.literal(FRESH_MARKETPLACE_CURRENT_CLAIM_BOUNDARY[2]),
      z.literal(FRESH_MARKETPLACE_CURRENT_CLAIM_BOUNDARY[3]),
    ]),
  ]),
  hire: z.object({
    hireId: z.string().uuid(),
    idempotencyKey: IdempotencyKeySchema,
    providerSlug: z.enum(["lending-rescue", "lp-rebalance", "yield-optimization", "bounded-grid"]),
    providerId: z.string().min(1),
    benchmarkSlug: z.enum(["lending-rescue", "lp-rebalance", "yield-optimization", "bounded-grid"]),
    service: z.enum(["LENDING_RESCUE", "LP_REBALANCE", "YIELD_OPTIMIZATION", "BOUNDED_GRID"]),
    evidenceMode: z.enum(["HISTORICAL_FIXTURE", "CURRENT_BLOCK_PINNED"]),
    commerce: z.object({
      directCostUsd: z.literal("0.00"),
      walletRequired: z.literal(false),
      settlement: z.literal("NO_PAYMENT"),
    }).strict(),
    request: z.record(z.string(), z.unknown()),
    requestHash: Sha256Schema,
    providerHash: Sha256Schema.nullable(),
    evidence: z.union([
      HistoricalFixtureEvidenceSchema,
      CurrentBlockPinnedEvidenceSchema,
    ]).nullable(),
    evidenceHash: Sha256Schema.nullable(),
    createdAt: IsoTimestampSchema,
  }).strict(),
  job: z.object({
    jobId: z.string().uuid(),
    state: FreshMarketplaceJobStateSchema,
    status: z.enum(["HIRE_RECORDED", "RUNNING", "COMPLETED", "FAILED"]),
    createdAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.nullable(),
    completedAt: IsoTimestampSchema.nullable(),
    apiDurationMilliseconds: z.number().int().positive().nullable(),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().nullable(),
  }).strict(),
  receipt: z.object({
    receiptId: z.string().uuid(),
    publicUrl: z.string().startsWith("/api/benchmark-receipts/"),
    responseHash: Sha256Schema,
    deliverableHash: Sha256Schema,
    evaluationHash: Sha256Schema,
    createdAt: IsoTimestampSchema,
    response: z.unknown(),
  }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (
    value.hire.evidenceMode === "CURRENT_BLOCK_PINNED" &&
    (value.hire.providerHash === null || value.hire.evidenceHash === null ||
      value.hire.evidence?.evidenceClass !== "CURRENT_BLOCK_PINNED")
  ) {
    context.addIssue({
      code: "custom",
      path: ["hire", "evidence"],
      message: "Current block-pinned hires require provider and evidence commitments",
    });
  }
  const evidence = value.hire.evidence;
  if (evidence?.evidenceClass === "CURRENT_BLOCK_PINNED") {
    const audition = evidence.providerAudition;
    if (audition && (
      value.hire.service !== "LENDING_RESCUE" ||
      audition.requestHash !== value.hire.requestHash ||
      audition.selection.winnerProviderId !== value.hire.providerId ||
      audition.selection.winnerProviderSlug !== value.hire.providerSlug ||
      audition.observation.blockNumber !== evidence.source.blockNumber ||
      audition.observation.observedAt !== evidence.source.observedAt ||
      audition.observation.explorerUrl !== evidence.source.explorerUrl
    )) {
      context.addIssue({
        code: "custom",
        path: ["hire", "evidence", "providerAudition"],
        message: "Provider audition must bind the persisted request, observation, and selected provider",
      });
    }
  }
});

export type FreshMarketplaceHireRequest = z.infer<typeof FreshMarketplaceHireRequestSchema>;
export type FreshMarketplaceChain = z.infer<typeof FreshMarketplaceChainSchema>;
export type FreshMarketplaceHistoricalBenchmarkSlug = keyof typeof FRESH_MARKETPLACE_HISTORICAL_TASKS;
export type FreshMarketplaceBenchmarkSlug = keyof typeof FRESH_MARKETPLACE_TASKS;
export type CurrentBlockPinnedEvidence = z.infer<typeof CurrentBlockPinnedEvidenceSchema>;
export type HistoricalFixtureEvidence = z.infer<typeof HistoricalFixtureEvidenceSchema>;

export function freshMarketplaceClaimBoundary(
  evidenceMode: FreshMarketplaceChain["hire"]["evidenceMode"],
): typeof FRESH_MARKETPLACE_HISTORICAL_CLAIM_BOUNDARY | typeof FRESH_MARKETPLACE_CURRENT_CLAIM_BOUNDARY {
  return evidenceMode === "CURRENT_BLOCK_PINNED"
    ? FRESH_MARKETPLACE_CURRENT_CLAIM_BOUNDARY
    : FRESH_MARKETPLACE_HISTORICAL_CLAIM_BOUNDARY;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) output[key] = canonicalValue(item);
    }
    return output;
  }
  throw new Error("Canonical JSON accepts JSON values only");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Commitment(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return "sha256:" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function freshMarketplaceTaskForService(
  service: string,
): [FreshMarketplaceBenchmarkSlug, (typeof FRESH_MARKETPLACE_TASKS)[FreshMarketplaceBenchmarkSlug]] | null {
  const match = Object.entries(FRESH_MARKETPLACE_TASKS).find(([, task]) => task.service === service);
  return match as [FreshMarketplaceBenchmarkSlug, (typeof FRESH_MARKETPLACE_TASKS)[FreshMarketplaceBenchmarkSlug]] | null;
}
