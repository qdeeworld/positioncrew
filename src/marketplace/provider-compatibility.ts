import { z } from "zod";
import {
  BoundedGridDeliverableSchema,
  BoundedGridRequestSchema,
  HashSchema,
  LendingRescueDeliverableSchema,
  LendingRescueRequestSchema,
  LpRebalanceDeliverableSchema,
  LpRebalanceRequestSchema,
  PositionCrewDeliverableSchema,
  PositionCrewRequestSchema,
  ServiceTypeSchema,
  YieldOptimizationDeliverableSchema,
  YieldOptimizationRequestSchema,
  type PositionCrewDeliverable,
  type PositionCrewRequest,
} from "../contracts/index.js";
import { canonicalHash } from "../core/canonical.js";
import { parseFixed } from "../core/fixed.js";
import { createBoundedGridDeliverable } from "../providers/bounded-grid.js";
import { createLendingRescueDeliverable } from "../providers/lending-rescue.js";
import { createLpRebalanceDeliverable } from "../providers/lp-rebalance.js";
import { createYieldOptimizationDeliverable } from "../providers/yield-optimization.js";
import type { ProviderListing } from "./catalog.js";

export const PROVIDER_CONTRACT_PREFLIGHT_ROUTE = "/api/provider-contract-preflight";
export const PROVIDER_CONTRACT_PREFLIGHT_BOUNDARY =
  "This checks only caller-supplied packet structure, request binding, declared buyer limits, and the deterministic PositionCrew reference actionability gate. It does not prove ownership, identity binding, liveness, uptime, latency, real delivery, output accuracy, quality, safety, demand, payment, performance, integration, certification, or hireability.";
export const PROVIDER_CONTRACT_PREFLIGHT_VALIDATOR_VERSION =
  "positioncrew.provider-contract-preflight.v1";

type ServiceId = PositionCrewRequest["service"];
type JsonRecord = Record<string, unknown>;

const CONTRACTS = {
  LENDING_RESCUE: {
    request: LendingRescueRequestSchema,
    deliverable: LendingRescueDeliverableSchema,
    requestSchema: "positioncrew.lending-rescue.request.v1",
    deliverableSchema: "positioncrew.lending-rescue.deliverable.v1",
  },
  LP_REBALANCE: {
    request: LpRebalanceRequestSchema,
    deliverable: LpRebalanceDeliverableSchema,
    requestSchema: "positioncrew.lp-rebalance.request.v1",
    deliverableSchema: "positioncrew.lp-rebalance.deliverable.v1",
  },
  YIELD_OPTIMIZATION: {
    request: YieldOptimizationRequestSchema,
    deliverable: YieldOptimizationDeliverableSchema,
    requestSchema: "positioncrew.yield-optimization.request.v1",
    deliverableSchema: "positioncrew.yield-optimization.deliverable.v1",
  },
  BOUNDED_GRID: {
    request: BoundedGridRequestSchema,
    deliverable: BoundedGridDeliverableSchema,
    requestSchema: "positioncrew.bounded-grid.request.v1",
    deliverableSchema: "positioncrew.bounded-grid.deliverable.v1",
  },
} as const;

export const ProviderContractManifestSchema = z.object({
  schemaVersion: z.literal("positioncrew.provider-contract-manifest.v1"),
  providerId: z.string().min(8).max(160),
  operator: z.string().min(1).max(120),
  service: ServiceTypeSchema,
  requestSchema: z.string().min(1).max(160),
  deliverableSchema: z.string().min(1).max(160),
}).strict();

const ProviderContractPacketEnvelopeSchema = z.object({
  schemaVersion: z.literal("positioncrew.provider-contract-packet.v1"),
  service: ServiceTypeSchema,
  manifest: ProviderContractManifestSchema,
  request: z.unknown(),
  actionableDeliverable: z.unknown(),
  refusalDeliverable: z.unknown(),
}).strict();

export const ProviderContractPacketSchema = z.object({
  schemaVersion: z.literal("positioncrew.provider-contract-packet.v1"),
  service: ServiceTypeSchema,
  manifest: ProviderContractManifestSchema,
  request: PositionCrewRequestSchema,
  actionableDeliverable: PositionCrewDeliverableSchema,
  refusalDeliverable: PositionCrewDeliverableSchema,
}).strict();

export const ProviderContractCheckSchema = z.object({
  id: z.string().min(1).max(120),
  status: z.enum(["PASS", "FAIL", "NOT_PROVEN"]),
  summary: z.string().min(1).max(240),
  details: z.array(z.string().min(1).max(500)).max(32),
}).strict();

export const ProviderContractPreflightResultSchema = z.object({
  schemaVersion: z.literal("positioncrew.provider-contract-preflight-result.v1"),
  validatorVersion: z.literal(PROVIDER_CONTRACT_PREFLIGHT_VALIDATOR_VERSION),
  outcome: z.enum(["CONTRACT_PASS", "CONTRACT_FAIL"]),
  service: ServiceTypeSchema.nullable(),
  inputHash: HashSchema,
  resultHash: HashSchema,
  checks: z.array(ProviderContractCheckSchema).min(1),
  claimBoundary: z.literal(PROVIDER_CONTRACT_PREFLIGHT_BOUNDARY),
}).strict();

export const ProviderContractTemplateResponseSchema = z.object({
  schemaVersion: z.literal("positioncrew.provider-contract-preflight-templates.v1"),
  validatorVersion: z.literal(PROVIDER_CONTRACT_PREFLIGHT_VALIDATOR_VERSION),
  templates: z.record(ServiceTypeSchema, ProviderContractPacketSchema),
  claimBoundary: z.literal(PROVIDER_CONTRACT_PREFLIGHT_BOUNDARY),
}).strict();

export type ProviderContractPacket = z.infer<typeof ProviderContractPacketSchema>;
export type ProviderContractPreflightResult = z.infer<typeof ProviderContractPreflightResultSchema>;

const NOT_PROVEN_CHECKS = [
  ["ownership", "Provider ownership is not proven by caller-supplied JSON."],
  ["erc8004-binding", "ERC-8004 identity binding is not proven."],
  ["liveness", "Current endpoint liveness is not proven."],
  ["uptime", "Historical uptime is not proven."],
  ["latency", "Response latency is not proven."],
  ["real-delivery", "Completion of a real buyer delivery is not proven."],
  ["quality", "Output quality is not proven."],
  ["safety", "Operational or financial safety is not proven."],
  ["demand", "External demand or adoption is not proven."],
  ["payment", "Payment, settlement, or revenue is not proven."],
  ["performance", "Realised financial performance is not proven."],
] as const;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function fixed(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  try {
    return parseFixed(value);
  } catch {
    return null;
  }
}

function decimalAtMost(value: unknown, limit: unknown): boolean {
  const parsedValue = fixed(value);
  const parsedLimit = fixed(limit);
  return parsedValue !== null && parsedLimit !== null && parsedValue <= parsedLimit;
}

function decimalAtLeast(value: unknown, minimum: unknown): boolean {
  const parsedValue = fixed(value);
  const parsedMinimum = fixed(minimum);
  return parsedValue !== null && parsedMinimum !== null && parsedValue >= parsedMinimum;
}

function addressEquals(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function issues(result: z.ZodSafeParseError<unknown>): string[] {
  return result.error.issues
    .map((issue) => `${issue.path.join(".") || "packet"}: ${issue.message}`)
    .sort((left, right) => left.localeCompare(right));
}

function contractCheck(
  id: string,
  passed: boolean,
  summary: string,
  details: string[] = [],
): z.infer<typeof ProviderContractCheckSchema> {
  return { id, status: passed ? "PASS" : "FAIL", summary, details };
}

function commonDeliverableDetails(
  request: PositionCrewRequest,
  deliverable: PositionCrewDeliverable,
): string[] {
  const details: string[] = [];
  if (deliverable.requestId !== request.requestId) {
    details.push("Deliverable requestId does not match the representative request.");
  }
  const generatedAt = Date.parse(deliverable.generatedAt);
  const expiresAt = Date.parse(deliverable.expiresAt);
  if (generatedAt < Date.parse(request.requestedAt)) {
    details.push("Deliverable generatedAt predates request.requestedAt.");
  }
  if (expiresAt <= generatedAt) {
    details.push("Deliverable expiresAt must be after generatedAt.");
  }
  if (expiresAt > Date.parse(request.deadline)) {
    details.push("Deliverable expiresAt exceeds the buyer deadline.");
  }
  return details;
}

function actionableSemanticDetails(service: ServiceId, deliverable: PositionCrewDeliverable): string[] {
  const value = deliverable as unknown as JsonRecord;
  const details: string[] = [];
  if (value.status !== "ACTIONABLE") details.push("Actionable example must use status ACTIONABLE.");
  if (service === "LENDING_RESCUE") {
    if (!(["REPAY_DEBT", "ADD_COLLATERAL"] as unknown[]).includes(value.decision)) {
      details.push("Lending actionable decision must be REPAY_DEBT or ADD_COLLATERAL.");
    }
    if (value.recommendation === null) details.push("Lending actionable example requires a recommendation.");
  } else if (service === "LP_REBALANCE") {
    if (!(["WIDEN", "NARROW", "SHIFT", "EXIT"] as unknown[]).includes(value.decision)) {
      details.push("LP actionable decision must change or exit the range.");
    }
    if (value.decision !== "EXIT" && value.proposedRange === null) {
      details.push("LP range changes require a proposedRange.");
    }
  } else if (service === "YIELD_OPTIMIZATION") {
    if (!(["SUPPLY", "MIGRATE"] as unknown[]).includes(value.decision)) {
      details.push("Yield actionable decision must be SUPPLY or MIGRATE.");
    }
    if (value.selectedOpportunityId === null) {
      details.push("Yield actionable example requires a selected opportunity.");
    }
  } else {
    if (value.decision !== "BUILD_GRID") details.push("Grid actionable decision must be BUILD_GRID.");
    const orders = Array.isArray(value.orders) ? value.orders.map(record) : [];
    const sides = new Set(orders.map((order) => order.side));
    if (orders.length < 2 || !sides.has("BUY") || !sides.has("SELL")) {
      details.push("Grid actionable example requires at least one BUY and one SELL order.");
    }
  }
  return details;
}

function actionableRequestBindingDetails(
  service: ServiceId,
  request: PositionCrewRequest,
  deliverable: PositionCrewDeliverable,
): string[] {
  const req = request as unknown as JsonRecord;
  const output = deliverable as unknown as JsonRecord;
  const details: string[] = [];

  if (service === "LENDING_RESCUE") {
    const recommendation = record(output.recommendation);
    const actionAsset = record(recommendation.asset);
    const kind = recommendation.kind;
    const allowedActions = Array.isArray(req.allowedActions) ? req.allowedActions : [];
    if (!allowedActions.includes(kind)) details.push("Recommended action is not allowed by the request.");
    if (recommendation.chainId !== req.chainId) details.push("Recommendation chainId does not match the request.");
    if (recommendation.protocol !== req.protocol) details.push("Recommendation protocol does not match the request.");
    if (!addressEquals(recommendation.market, req.market)) details.push("Recommendation market does not match the request.");
    if (!addressEquals(recommendation.account, req.account)) details.push("Recommendation account does not match the request.");
    if (recommendation.kind !== output.decision) details.push("Recommendation kind does not match the deliverable decision.");
    const executeBefore = Date.parse(String(recommendation.executeBefore));
    if (executeBefore < Date.parse(deliverable.generatedAt) || executeBefore > Date.parse(deliverable.expiresAt)) {
      details.push("Recommendation executeBefore falls outside the deliverable validity window.");
    }
    if (executeBefore > Date.parse(String(req.deadline))) {
      details.push("Recommendation executeBefore exceeds the buyer deadline.");
    }
    const available = records(req.availableAssets).find((asset) => addressEquals(asset.address, actionAsset.address));
    if (!available) {
      details.push("Recommendation asset is not present in request.availableAssets.");
    } else if (!decimalAtMost(recommendation.amount, available.availableAmount)) {
      details.push("Recommendation amount exceeds the available asset amount.");
    }
    if (kind === "REPAY_DEBT") {
      const position = record(req.position);
      if (!records(position.debt).some((asset) => addressEquals(asset.address, actionAsset.address))) {
        details.push("Repay recommendation asset is not one of the request debts.");
      }
    }
  } else if (service === "LP_REBALANCE") {
    const proposed = record(output.proposedRange);
    const position = record(req.position);
    const marketState = record(req.marketState);
    const constraints = record(req.constraints);
    if (output.decision !== "EXIT") {
      const lower = proposed.lowerTick;
      const upper = proposed.upperTick;
      const spacing = constraints.tickSpacing;
      if (![lower, upper, spacing, marketState.currentTick].every(Number.isSafeInteger)) {
        details.push("Proposed range and tick constraints must be safe integers.");
      } else {
        const width = Number(upper) - Number(lower);
        if (Number(lower) >= Number(upper)) details.push("Proposed range lowerTick must be below upperTick.");
        if (width < Number(constraints.minimumWidthTicks) || width > Number(constraints.maximumWidthTicks)) {
          details.push("Proposed range width is outside the request bounds.");
        }
        if (Number(lower) % Number(spacing) !== 0 || Number(upper) % Number(spacing) !== 0) {
          details.push("Proposed range is not aligned to request tickSpacing.");
        }
        if (Number(marketState.currentTick) < Number(lower) || Number(marketState.currentTick) >= Number(upper)) {
          details.push("Proposed range does not contain the request currentTick.");
        }
        const currentWidth = Number(position.upperTick) - Number(position.lowerTick);
        if (output.decision === "WIDEN" && width <= currentWidth) details.push("WIDEN does not widen the current range.");
        if (output.decision === "NARROW" && width >= currentWidth) details.push("NARROW does not narrow the current range.");
        if (output.decision === "SHIFT" && lower === position.lowerTick && upper === position.upperTick) {
          details.push("SHIFT does not change the current range.");
        }
      }
    }
    const exposure = record(output.inventoryExposure);
    if (Number(exposure.token0Bps) > Number(constraints.maximumToken0ShareBps)) {
      details.push("Proposed token0 exposure exceeds the request maximum.");
    }
    if (Number(exposure.token1Bps) > Number(constraints.maximumToken1ShareBps)) {
      details.push("Proposed token1 exposure exceeds the request maximum.");
    }
  } else if (service === "YIELD_OPTIMIZATION") {
    const constraints = record(req.constraints);
    const selectedId = output.selectedOpportunityId;
    const candidates = output.decision === "WITHDRAW" ? records(req.currentPositions) : records(req.opportunities);
    const selected = candidates.find((candidate) => candidate.opportunityId === selectedId);
    if (!selected) {
      details.push("Selected opportunity is not present in the representative request.");
    } else if (output.decision !== "WITHDRAW") {
      const allowlist = Array.isArray(constraints.protocolAllowlist) ? constraints.protocolAllowlist : [];
      if (!allowlist.includes(selected.protocol)) details.push("Selected opportunity protocol is not allowlisted.");
      const riskRank: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
      if ((riskRank[String(selected.riskTier)] ?? 99) > (riskRank[String(constraints.maximumRiskTier)] ?? -1)) {
        details.push("Selected opportunity exceeds the maximum risk tier.");
      }
      if (!Number.isSafeInteger(selected.lockupSeconds) || Number(selected.lockupSeconds) > Number(constraints.maximumLockupSeconds)) {
        details.push("Selected opportunity exceeds the maximum lockup.");
      }
      if (!decimalAtLeast(selected.liquidityUsd, constraints.minimumLiquidityUsd)) {
        details.push("Selected opportunity is below the minimum liquidity.");
      }
      if (output.grossApyBps !== selected.grossApyBps) {
        details.push("Deliverable gross APY does not match the selected opportunity.");
      }
    }
  } else {
    const constraints = record(req.constraints);
    const orders = records(output.orders);
    if (orders.length > Number(constraints.levelCount)) {
      details.push("Grid contains more orders than the requested levelCount.");
    }
    let buyQuote = 0n;
    let sellQuote = 0n;
    for (const order of orders) {
      if (!decimalAtLeast(order.price, constraints.lowerPrice) || !decimalAtMost(order.price, constraints.upperPrice)) {
        details.push("Grid order price falls outside the requested price bounds.");
      }
      if (!decimalAtMost(order.maximumQuoteAmount, req.maxActionUsd)) {
        details.push("Grid order maximum quote amount exceeds request.maxActionUsd.");
      }
      const quote = fixed(order.maximumQuoteAmount);
      if (quote !== null && order.side === "BUY") buyQuote += quote;
      if (quote !== null && order.side === "SELL") sellQuote += quote;
    }
    const maximumInventory = fixed(constraints.maximumInventoryUsd);
    if (maximumInventory === null || buyQuote > maximumInventory || sellQuote > maximumInventory) {
      details.push("One side of the grid exceeds the requested maximum inventory.");
    }
    const lifetimeMs = Date.parse(deliverable.expiresAt) - Date.parse(deliverable.generatedAt);
    if (lifetimeMs > Number(constraints.orderExpirySeconds) * 1_000) {
      details.push("Grid lifetime exceeds request.orderExpirySeconds.");
    }
  }
  return details;
}

function canonicalReferenceActionabilityDetails(
  request: PositionCrewRequest,
  deliverable: PositionCrewDeliverable,
): string[] {
  try {
    const now = new Date(deliverable.generatedAt);
    const reference = request.service === "LENDING_RESCUE"
      ? createLendingRescueDeliverable(request, now)
      : request.service === "LP_REBALANCE"
        ? createLpRebalanceDeliverable(request, now)
        : request.service === "YIELD_OPTIMIZATION"
          ? createYieldOptimizationDeliverable(request, now)
          : createBoundedGridDeliverable(request, now);
    const details: string[] = [];
    if (reference.status !== "ACTIONABLE") {
      details.push(`PositionCrew reference provider returned ${reference.status}: ${reference.summary}`);
    }
    if (Date.parse(deliverable.expiresAt) > Date.parse(reference.expiresAt)) {
      details.push("Submitted deliverable outlives the reference evidence window.");
    }
    return details;
  } catch (error) {
    return [`PositionCrew reference provider could not evaluate the request: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function actionableLimitDetails(
  service: ServiceId,
  request: PositionCrewRequest,
  deliverable: PositionCrewDeliverable,
): string[] {
  const req = request as unknown as JsonRecord;
  const output = deliverable as unknown as JsonRecord;
  const details: string[] = [];
  if (service === "LENDING_RESCUE") {
    const recommendation = record(output.recommendation);
    if (!decimalAtMost(recommendation.amountUsd, req.maxActionUsd)) {
      details.push("Recommended amount exceeds request.maxActionUsd.");
    }
    if (!decimalAtMost(recommendation.estimatedGasUsd, req.maxGasUsd)) {
      details.push("Recommended gas exceeds request.maxGasUsd.");
    }
    if (!Number.isSafeInteger(recommendation.maxSlippageBps) || Number(recommendation.maxSlippageBps) > Number(req.maxSlippageBps)) {
      details.push("Recommended slippage exceeds request.maxSlippageBps.");
    }
  } else if (service === "LP_REBALANCE") {
    const constraints = record(req.constraints);
    if (!decimalAtMost(output.estimatedRebalanceCostUsd, req.maxActionUsd)) {
      details.push("Estimated rebalance cost exceeds request.maxActionUsd.");
    }
    if (!decimalAtLeast(output.expectedNetBenefitUsd, constraints.minimumNetBenefitUsd)) {
      details.push("Expected LP net benefit is below the request minimumNetBenefitUsd.");
    }
    if (!decimalAtMost(constraints.estimatedGasUsd, req.maxGasUsd)) {
      details.push("Requested LP gas estimate exceeds request.maxGasUsd.");
    }
  } else if (service === "YIELD_OPTIMIZATION") {
    const constraints = record(req.constraints);
    if (!decimalAtMost(output.allocationUsd, req.capitalUsd)) {
      details.push("Yield allocation exceeds request.capitalUsd.");
    }
    if (!decimalAtMost(output.migrationCostUsd, req.maxActionUsd)) {
      details.push("Yield migration cost exceeds request.maxActionUsd.");
    }
    if (!decimalAtLeast(output.netBenefitUsd, constraints.minimumNetBenefitUsd)) {
      details.push("Expected yield net benefit is below the request minimumNetBenefitUsd.");
    }
  } else {
    const constraints = record(req.constraints);
    const marketState = record(req.marketState);
    const mid = fixed(marketState.midPrice);
    const lower = fixed(constraints.lowerPrice);
    const upper = fixed(constraints.upperPrice);
    if (mid === null || lower === null || upper === null || mid <= lower || mid >= upper) {
      details.push("Grid mid price must be strictly inside the requested range.");
    }
    if (!decimalAtLeast(marketState.liquidityUsd, constraints.minimumLiquidityUsd)) {
      details.push("Grid market liquidity is below the request minimumLiquidityUsd.");
    }
    if (!Number.isSafeInteger(marketState.realizedVolatilityBps) || Number(marketState.realizedVolatilityBps) > Number(constraints.maximumVolatilityBps)) {
      details.push("Grid market volatility exceeds the request maximumVolatilityBps.");
    }
    if (!decimalAtMost(constraints.capitalUsd, req.maxActionUsd)) {
      details.push("Grid capital exceeds request.maxActionUsd.");
    }
    if (!decimalAtMost(output.worstCaseLossUsd, constraints.maximumLossUsd)) {
      details.push("Worst-case loss exceeds the request maximumLossUsd.");
    }
    if (!decimalAtMost(output.maximumInventoryUsd, constraints.maximumInventoryUsd)) {
      details.push("Maximum inventory exceeds the request maximumInventoryUsd.");
    }
    if (!decimalAtLeast(output.expectedNetProfitUsd, constraints.minimumExpectedNetProfitUsd)) {
      details.push("Expected net profit is below the request minimumExpectedNetProfitUsd.");
    }
    if (!decimalAtMost(output.estimatedGasUsd, req.maxGasUsd)) {
      details.push("Estimated grid gas exceeds request.maxGasUsd.");
    }
  }
  return details;
}

function refusalSemanticDetails(service: ServiceId, deliverable: PositionCrewDeliverable): string[] {
  const value = deliverable as unknown as JsonRecord;
  const details: string[] = [];
  if (typeof value.status !== "string" || !value.status.startsWith("REFUSED_")) {
    details.push("Refusal example must use an explicit REFUSED_* status.");
  }
  if (value.decision !== "NONE") details.push("Refusal decision must be NONE.");
  if (service === "LENDING_RESCUE") {
    if (value.recommendation !== null) details.push("Lending refusal cannot contain a recommendation.");
    if (Array.isArray(value.alternatives) && value.alternatives.length > 0) {
      details.push("Lending refusal cannot contain executable alternatives.");
    }
    if (!Array.isArray(value.refusalReasons) || value.refusalReasons.length === 0) {
      details.push("Lending refusal requires at least one refusal reason.");
    }
  } else if (service === "LP_REBALANCE") {
    if (value.proposedRange !== null) details.push("LP refusal cannot contain a proposed range.");
    if (Array.isArray(value.actionSteps) && value.actionSteps.length > 0) {
      details.push("LP refusal cannot contain action steps.");
    }
  } else if (service === "YIELD_OPTIMIZATION") {
    if (value.selectedOpportunityId !== null || Number(value.allocationUsd) !== 0) {
      details.push("Yield refusal cannot select or allocate to an opportunity.");
    }
    if (Array.isArray(value.actionSteps) && value.actionSteps.length > 0) {
      details.push("Yield refusal cannot contain action steps.");
    }
  } else if (Array.isArray(value.orders) && value.orders.length > 0) {
    details.push("Grid refusal cannot contain orders.");
  }
  return details;
}

function finalizeResult(
  input: unknown,
  service: ServiceId | null,
  checks: z.infer<typeof ProviderContractCheckSchema>[],
): ProviderContractPreflightResult {
  const base = {
    schemaVersion: "positioncrew.provider-contract-preflight-result.v1" as const,
    validatorVersion: PROVIDER_CONTRACT_PREFLIGHT_VALIDATOR_VERSION,
    outcome: checks.some((check) => check.status === "FAIL")
      ? "CONTRACT_FAIL" as const
      : "CONTRACT_PASS" as const,
    service,
    inputHash: canonicalHash(input),
    checks: [
      ...checks,
      ...NOT_PROVEN_CHECKS.map(([id, summary]) => ({
        id: `not-proven:${id}`,
        status: "NOT_PROVEN" as const,
        summary,
        details: [],
      })),
    ],
    claimBoundary: PROVIDER_CONTRACT_PREFLIGHT_BOUNDARY,
  };
  return ProviderContractPreflightResultSchema.parse({
    ...base,
    resultHash: canonicalHash(base),
  });
}

export function runProviderContractPreflight(input: unknown): ProviderContractPreflightResult {
  const envelope = ProviderContractPacketEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return finalizeResult(input, null, [
      contractCheck("packet-shape", false, "Packet does not match the strict preflight envelope.", issues(envelope)),
    ]);
  }

  const packet = envelope.data;
  const contract = CONTRACTS[packet.service];
  const checks: z.infer<typeof ProviderContractCheckSchema>[] = [
    contractCheck("packet-shape", true, "Packet matches the strict preflight envelope."),
  ];
  const manifestDetails = [
    packet.manifest.service === packet.service ? null : "Manifest service does not match packet service.",
    packet.manifest.requestSchema === contract.requestSchema ? null : `Manifest requestSchema must be ${contract.requestSchema}.`,
    packet.manifest.deliverableSchema === contract.deliverableSchema ? null : `Manifest deliverableSchema must be ${contract.deliverableSchema}.`,
  ].filter((detail): detail is string => detail !== null);
  checks.push(contractCheck(
    "manifest-binding",
    manifestDetails.length === 0,
    "Contract manifest is bound to the selected service and canonical schema IDs.",
    manifestDetails,
  ));

  const requestResult = contract.request.safeParse(packet.request);
  checks.push(contractCheck(
    "request-schema",
    requestResult.success,
    "Representative request matches the canonical service schema.",
    requestResult.success ? [] : issues(requestResult),
  ));

  const actionableResult = contract.deliverable.safeParse(packet.actionableDeliverable);
  checks.push(contractCheck(
    "actionable-schema",
    actionableResult.success,
    "Actionable example matches the canonical deliverable schema.",
    actionableResult.success ? [] : issues(actionableResult),
  ));

  const refusalResult = contract.deliverable.safeParse(packet.refusalDeliverable);
  checks.push(contractCheck(
    "refusal-schema",
    refusalResult.success,
    "Refusal example matches the canonical deliverable schema.",
    refusalResult.success ? [] : issues(refusalResult),
  ));

  if (requestResult.success && actionableResult.success) {
    const request = requestResult.data as PositionCrewRequest;
    const actionable = actionableResult.data as PositionCrewDeliverable;
    const bindingDetails = [
      ...commonDeliverableDetails(request, actionable),
      ...actionableRequestBindingDetails(packet.service, request, actionable),
    ];
    checks.push(contractCheck(
      "actionable-request-binding",
      bindingDetails.length === 0,
      "Actionable example is bound to the representative request and buyer deadline.",
      bindingDetails,
    ));
    const semanticDetails = actionableSemanticDetails(packet.service, actionable);
    checks.push(contractCheck(
      "actionable-semantics",
      semanticDetails.length === 0,
      "Actionable example contains a concrete category-specific action.",
      semanticDetails,
    ));
    const referenceDetails = canonicalReferenceActionabilityDetails(request, actionable);
    checks.push(contractCheck(
      "canonical-reference-actionability",
      referenceDetails.length === 0,
      "Representative request clears the deterministic PositionCrew reference actionability gate.",
      referenceDetails,
    ));
    const limitDetails = actionableLimitDetails(packet.service, request, actionable);
    checks.push(contractCheck(
      "buyer-limits",
      limitDetails.length === 0,
      "Actionable example stays within the representative buyer limits.",
      limitDetails,
    ));
  } else {
    checks.push(
      contractCheck("actionable-request-binding", false, "Actionable request binding cannot be evaluated.", ["Fix request and actionable schema failures first."]),
      contractCheck("actionable-semantics", false, "Actionable semantics cannot be evaluated.", ["Fix actionable schema failures first."]),
      contractCheck("canonical-reference-actionability", false, "Reference actionability cannot be evaluated.", ["Fix request and actionable schema failures first."]),
      contractCheck("buyer-limits", false, "Buyer limits cannot be evaluated.", ["Fix request and actionable schema failures first."]),
    );
  }

  if (requestResult.success && refusalResult.success) {
    const request = requestResult.data as PositionCrewRequest;
    const refusal = refusalResult.data as PositionCrewDeliverable;
    const bindingDetails = commonDeliverableDetails(request, refusal);
    checks.push(contractCheck(
      "refusal-request-binding",
      bindingDetails.length === 0,
      "Refusal example is bound to the representative request and buyer deadline.",
      bindingDetails,
    ));
    const semanticDetails = refusalSemanticDetails(packet.service, refusal);
    checks.push(contractCheck(
      "explicit-refusal",
      semanticDetails.length === 0,
      "Refusal example fails closed without an executable action.",
      semanticDetails,
    ));
  } else {
    checks.push(
      contractCheck("refusal-request-binding", false, "Refusal request binding cannot be evaluated.", ["Fix request and refusal schema failures first."]),
      contractCheck("explicit-refusal", false, "Refusal semantics cannot be evaluated.", ["Fix refusal schema failures first."]),
    );
  }

  return finalizeResult(input, packet.service, checks);
}

export function verifyProviderContractPreflightResult(input: unknown): boolean {
  const parsed = ProviderContractPreflightResultSchema.safeParse(input);
  if (!parsed.success) return false;
  const { resultHash, ...base } = parsed.data;
  return canonicalHash(base) === resultHash;
}

function refusalFromActionable(deliverable: PositionCrewDeliverable): PositionCrewDeliverable {
  const common = {
    ...(structuredClone(deliverable) as unknown as JsonRecord),
    status: "REFUSED_CONSTRAINTS" as const,
    decision: "NONE" as const,
    summary: "Reference refusal: the supplied constraints do not permit an executable action.",
  };
  if (deliverable.service === "LENDING_RESCUE") {
    return PositionCrewDeliverableSchema.parse({
      ...common,
      service: "LENDING_RESCUE",
      recommendation: null,
      alternatives: [],
      refusalReasons: ["No action is permitted by the representative constraints."],
    });
  }
  if (deliverable.service === "LP_REBALANCE") {
    return PositionCrewDeliverableSchema.parse({
      ...common,
      service: "LP_REBALANCE",
      proposedRange: null,
      estimatedRebalanceCostUsd: "0",
      expectedGrossFeesUsd: "0",
      expectedNetBenefitUsd: "0",
      breakEvenHours: null,
      actionSteps: [],
    });
  }
  if (deliverable.service === "YIELD_OPTIMIZATION") {
    return PositionCrewDeliverableSchema.parse({
      ...common,
      service: "YIELD_OPTIMIZATION",
      selectedOpportunityId: null,
      allocationUsd: "0",
      grossApyBps: null,
      annualYieldUpliftUsd: "0",
      netBenefitUsd: "0",
      migrationCostUsd: "0",
      breakEvenDays: null,
      actionSteps: [],
    });
  }
  return PositionCrewDeliverableSchema.parse({
    ...common,
    service: "BOUNDED_GRID",
    orders: [],
    grossSpreadCaptureUsd: "0",
    estimatedFeesUsd: "0",
    estimatedSlippageUsd: "0",
    estimatedGasUsd: "0",
    expectedNetProfitUsd: "0",
    worstCaseLossUsd: "0",
    maximumInventoryUsd: "0",
  });
}

export function buildProviderContractTemplate(
  provider: ProviderListing,
  request: PositionCrewRequest,
  actionableDeliverable: PositionCrewDeliverable,
): ProviderContractPacket {
  const packet = ProviderContractPacketSchema.parse({
    schemaVersion: "positioncrew.provider-contract-packet.v1",
    service: request.service,
    manifest: {
      schemaVersion: "positioncrew.provider-contract-manifest.v1",
      providerId: provider.providerId,
      operator: "PositionCrew reference packet",
      service: request.service,
      requestSchema: provider.requestSchema,
      deliverableSchema: provider.deliverableSchema,
    },
    request,
    actionableDeliverable,
    refusalDeliverable: refusalFromActionable(actionableDeliverable),
  });
  const report = runProviderContractPreflight(packet);
  if (report.outcome !== "CONTRACT_PASS") {
    throw new Error(`Reference ${request.service} provider packet does not pass its contract`);
  }
  return packet;
}
