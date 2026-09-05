import {
  YieldOptimizationDeliverableSchema,
  YieldOptimizationRequestSchema,
  type YieldOptimizationDeliverable,
  type YieldOptimizationRequest,
} from "../contracts/yield-optimization.js";
import { FIXED_SCALE, formatFixed, minimum, parseFixed } from "../core/fixed.js";
import { validateEvidence } from "./provider-utils.js";

const RISK_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
type Position = YieldOptimizationRequest["currentPositions"][number];
const protocolKey = (protocol: string): string => protocol.trim().toLowerCase();
const assetKey = (position: Position): string =>
  `${position.asset.address.toLowerCase()}:${position.asset.decimals}`;
const availableWithdrawal = (position: Position): bigint =>
  minimum(parseFixed(position.amountUsd), parseFixed(position.liquidityUsd));

function currentWeightedApy(request: YieldOptimizationRequest): number {
  let totalUsd = 0n;
  let weighted = 0n;
  for (const position of request.currentPositions) {
    const value = parseFixed(position.amountUsd);
    totalUsd += value;
    weighted += value * BigInt(position.grossApyBps);
  }
  return totalUsd === 0n ? 0 : Number(weighted / totalUsd);
}

function portfolioInputIssues(request: YieldOptimizationRequest): string[] {
  const issues: string[] = [];
  const held = request.currentPositions.reduce((sum, position) => sum + parseFixed(position.amountUsd), 0n);
  if (held > parseFixed(request.capitalUsd)) {
    issues.push("Current positions exceed capitalUsd, which includes both invested and idle capital.");
  }
  for (const positions of [request.currentPositions, request.opportunities]) {
    if (new Set(positions.map((position) => position.opportunityId)).size !== positions.length) {
      issues.push("Opportunity identifiers must be unique within each position list.");
    }
  }
  const markets = new Map<string, string>();
  const identities = new Map<string, string>();
  const heldMarkets = new Set<string>();
  for (const position of [...request.currentPositions, ...request.opportunities]) {
    const market = position.vaultOrMarket.toLowerCase();
    const identity = `${protocolKey(position.protocol)}:${assetKey(position)}`;
    if (markets.has(market) && markets.get(market) !== identity) {
      issues.push("A vault or market has conflicting protocol or asset identities.");
    }
    if (identities.has(position.opportunityId) && identities.get(position.opportunityId) !== `${market}:${identity}`) {
      issues.push("An opportunity identifier has conflicting market identities.");
    }
    markets.set(market, identity);
    identities.set(position.opportunityId, `${market}:${identity}`);
  }
  for (const position of request.currentPositions) {
    const market = position.vaultOrMarket.toLowerCase();
    if (heldMarkets.has(market)) {
      issues.push("Current positions contain a duplicate vault or market balance.");
    }
    heldMarkets.add(market);
  }
  return issues;
}

/** Plan one supply using only principal already accounted for by capitalUsd. */
function candidatePlan(
  request: YieldOptimizationRequest,
  opportunity: Position,
  potentialSources: Position[],
  heldByProtocol: Map<string, bigint>,
  idleCapital: bigint,
) {
  let sources = potentialSources;
  const capital = parseFixed(request.capitalUsd);
  const destination = protocolKey(opportunity.protocol);
  // Remove unused sources and their full quoted exit fees until the plan is
  // stable. This loop strictly shrinks its source set, so cannot oscillate.
  for (;;) {
    const migrationCost = parseFixed(opportunity.estimatedEntryCostUsd) +
      sources.reduce((sum, source) => sum + parseFixed(source.estimatedExitCostUsd), 0n);
    if (migrationCost >= capital) return null;
    const postMigrationCapital = capital - migrationCost;
    const protocolLimit = postMigrationCapital *
      BigInt(request.constraints.maximumProtocolConcentrationBps) / 10_000n;
    const availableByProtocol = new Map<string, bigint>();
    for (const source of sources) {
      const key = protocolKey(source.protocol);
      availableByProtocol.set(key, (availableByProtocol.get(key) ?? 0n) + availableWithdrawal(source));
    }
    const destinationHeadroom = protocolLimit - (heldByProtocol.get(destination) ?? 0n) +
      (availableByProtocol.get(destination) ?? 0n);
    const spendable = idleCapital + sources.reduce((sum, source) => sum + availableWithdrawal(source), 0n) - migrationCost;
    const allocation = minimum(
      minimum(parseFixed(opportunity.amountUsd), parseFixed(opportunity.liquidityUsd)),
      minimum(destinationHeadroom, spendable),
    );
    if (allocation <= 0n) return null;

    const withdrawals = new Map<string, bigint>();
    let totalWithdrawn = 0n;
    // First repair each protocol's final exposure, including retained holdings.
    for (const [protocol, held] of heldByProtocol) {
      let required = held + (protocol === destination ? allocation : 0n) - protocolLimit;
      if (required <= 0n) continue;
      if (required > (availableByProtocol.get(protocol) ?? 0n)) return null;
      for (const source of sources) {
        if (protocolKey(source.protocol) !== protocol || required === 0n) continue;
        const amount = minimum(required, availableWithdrawal(source));
        if (amount > 0n) withdrawals.set(source.opportunityId, amount);
        required -= amount;
        totalWithdrawn += amount;
      }
    }
    const spend = allocation + migrationCost;
    // A migration does not silently liquidate additional capital into cash.
    if (totalWithdrawn > spend) return null;
    let fundingShortfall = spend - totalWithdrawn - idleCapital;
    for (const source of sources) {
      if (fundingShortfall <= 0n) break;
      const alreadyWithdrawn = withdrawals.get(source.opportunityId) ?? 0n;
      const amount = minimum(fundingShortfall, availableWithdrawal(source) - alreadyWithdrawn);
      if (amount > 0n) withdrawals.set(source.opportunityId, alreadyWithdrawn + amount);
      fundingShortfall -= amount;
      totalWithdrawn += amount;
    }
    if (fundingShortfall > 0n) return null;
    const usedSources = sources.filter((source) => withdrawals.has(source.opportunityId));
    if (usedSources.length !== sources.length) {
      sources = usedSources;
      continue;
    }
    if (migrationCost > parseFixed(request.maxActionUsd) || migrationCost > parseFixed(request.maxGasUsd)) return null;

    const idleCapitalUsed = spend - totalWithdrawn;
    const finalByProtocol = new Map(heldByProtocol);
    let foregoneAnnualYieldNumerator = 0n;
    for (const source of sources) {
      const withdrawn = withdrawals.get(source.opportunityId)!;
      const protocol = protocolKey(source.protocol);
      finalByProtocol.set(protocol, finalByProtocol.get(protocol)! - withdrawn);
      foregoneAnnualYieldNumerator += withdrawn * BigInt(source.grossApyBps);
    }
    finalByProtocol.set(destination, (finalByProtocol.get(destination) ?? 0n) + allocation);
    if ([...finalByProtocol.values()].some((value) => value < 0n || value > protocolLimit)) return null;

    const annualYieldUplift = (allocation * BigInt(opportunity.grossApyBps) - foregoneAnnualYieldNumerator) / 10_000n;
    if (annualYieldUplift <= 0n) return null;
    const netBenefit = annualYieldUplift * BigInt(request.constraints.evaluationHorizonDays) / 365n - migrationCost;
    if (netBenefit < parseFixed(request.constraints.minimumNetBenefitUsd)) return null;
    return {
      opportunity,
      allocation,
      annualYieldUplift,
      migrationCost,
      netBenefit,
      breakEvenDays: migrationCost * 365n * FIXED_SCALE / annualYieldUplift,
      withdrawals: sources.map((source) => ({
        opportunityId: source.opportunityId,
        amountUsd: formatFixed(withdrawals.get(source.opportunityId)!, 18),
      })),
      idleCapitalUsed,
      remainingIdleCapital: idleCapital - idleCapitalUsed,
      postMigrationCapital,
      finalProtocolAllocations: [...finalByProtocol.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([protocol, amount]) => ({ protocol, amountUsd: formatFixed(amount, 18) })),
    };
  }
}

function* fundingSourceSets(
  request: YieldOptimizationRequest,
  opportunity: Position,
  sources: Position[],
): Generator<Position[]> {
  yield [];
  const entryCost = parseFixed(opportunity.estimatedEntryCostUsd);
  const costLimit = minimum(parseFixed(request.maxActionUsd), parseFixed(request.maxGasUsd));
  const byApy = (left: Position, right: Position): number =>
    left.grossApyBps - right.grossApyBps || left.opportunityId.localeCompare(right.opportunityId);
  const affordable = sources.map((source) => ({
    source,
    exitCost: parseFixed(source.estimatedExitCostUsd),
    available: availableWithdrawal(source),
  })).filter((item) => entryCost + item.exitCost <= costLimit);
  const compare = (left: bigint, right: bigint): number => left < right ? -1 : left > right ? 1 : 0;
  // Compare fee per available dollar without losing fixed-point precision.
  const byFundingCost = (left: typeof affordable[number], right: typeof affordable[number]): number =>
    compare(left.exitCost * right.available, right.exitCost * left.available) ||
    byApy(left.source, right.source);
  const orderings = [
    affordable,
    [...affordable].sort((left, right) => compare(left.exitCost, right.exitCost) || byFundingCost(left, right)),
    [...affordable].sort(byFundingCost),
  ];
  for (const item of affordable) yield [item.source];
  // At most 4n+1 plans, streamed with O(n) search memory, not a power set.
  // These complementary greedy orders are a bounded search, not an optimizer
  // over every combination. Every result still passes candidatePlan's gates.
  for (const ordering of orderings) {
    let cost = entryCost;
    const selected: Position[] = [];
    for (const item of ordering) {
      if (cost + item.exitCost > costLimit) continue;
      cost += item.exitCost;
      selected.push(item.source);
      if (selected.length > 1) yield [...selected].sort(byApy);
    }
  }
}

export function createYieldOptimizationDeliverable(
  input: YieldOptimizationRequest,
  now: Date,
): YieldOptimizationDeliverable {
  const request = YieldOptimizationRequestSchema.parse(input);
  const evidence = validateEvidence({
    sources: request.sources,
    observations: [...request.currentPositions, ...request.opportunities],
    requestedAt: request.requestedAt,
    deadline: request.deadline,
    maxDataAgeSeconds: request.maxDataAgeSeconds,
    now,
  });
  const base = {
    schemaVersion: "positioncrew.yield-optimization.deliverable.v1" as const,
    service: "YIELD_OPTIMIZATION" as const,
    requestId: request.requestId,
    generatedAt: now.toISOString(),
    expiresAt: evidence.expiresAt,
    currentWeightedApyBps: currentWeightedApy(request),
    invalidationConditions: [
      "APY, liquidity, lockup, protocol allowlist, or route costs change.",
      `Current time passes ${evidence.expiresAt}.`,
    ],
  };
  const empty = {
    selectedOpportunityId: null,
    allocationUsd: "0",
    grossApyBps: null,
    annualYieldUpliftUsd: "0",
    netBenefitUsd: "0",
    migrationCostUsd: "0",
    breakEvenDays: null,
    actionSteps: [],
  };
  const inputIssues = portfolioInputIssues(request);
  if (evidence.status !== "OK" || inputIssues.length > 0) {
    return YieldOptimizationDeliverableSchema.parse({
      ...base,
      ...empty,
      status: evidence.status !== "OK" ? evidence.status : "REFUSED_INCONSISTENT_DATA",
      decision: "NONE",
      summary: "Yield evidence is unsafe, inconsistent, or expired; no allocation was proposed.",
      risks: [...evidence.reasons, ...inputIssues],
    });
  }

  const heldByProtocol = new Map<string, bigint>();
  let held = 0n;
  for (const position of request.currentPositions) {
    const protocol = protocolKey(position.protocol);
    const amount = parseFixed(position.amountUsd);
    held += amount;
    heldByProtocol.set(protocol, (heldByProtocol.get(protocol) ?? 0n) + amount);
  }
  const idleCapital = parseFixed(request.capitalUsd) - held;
  const allowlist = new Set(request.constraints.protocolAllowlist.map(protocolKey));
  const candidates = request.opportunities.flatMap((opportunity) => {
    if (!allowlist.has(protocolKey(opportunity.protocol)) ||
      opportunity.lockupSeconds > request.constraints.maximumLockupSeconds ||
      parseFixed(opportunity.liquidityUsd) < parseFixed(request.constraints.minimumLiquidityUsd) ||
      RISK_RANK[opportunity.riskTier] > RISK_RANK[request.constraints.maximumRiskTier]) return [];
    const sources = request.currentPositions.filter((position) =>
      availableWithdrawal(position) > 0n && position.lockupSeconds === 0 &&
      assetKey(position) === assetKey(opportunity) &&
      position.vaultOrMarket.toLowerCase() !== opportunity.vaultOrMarket.toLowerCase(),
    ).sort((left, right) => left.grossApyBps - right.grossApyBps ||
      left.opportunityId.localeCompare(right.opportunityId));
    let best: ReturnType<typeof candidatePlan> = null;
    for (const sourceSet of fundingSourceSets(request, opportunity, sources)) {
      const candidate = candidatePlan(request, opportunity, sourceSet, heldByProtocol, idleCapital);
      if (candidate !== null && (best === null || candidate.netBenefit > best.netBenefit)) best = candidate;
    }
    return best === null ? [] : [best];
  }).sort((left, right) =>
    left.netBenefit === right.netBenefit
      ? left.opportunity.opportunityId.localeCompare(right.opportunity.opportunityId)
      : left.netBenefit > right.netBenefit ? -1 : 1,
  );

  const selected = candidates[0];
  if (!selected) {
    return YieldOptimizationDeliverableSchema.parse({
      ...base,
      ...empty,
      status: "NO_ACTION",
      decision: "HOLD",
      summary: "No evaluated funded yield move clears final portfolio concentration, liquidity, risk, gas, cost, and net-benefit limits.",
      risks: [
        "Yield can change before the next evaluation.",
        "Entry and selected exit quotes lack a gas breakdown; their full sum must fit both maxGasUsd and the maxActionUsd cost budget.",
        "A HOLD result does not certify that existing holdings satisfy the requested concentration cap.",
        "The bounded funding search does not examine every withdrawal combination; HOLD does not prove that no feasible migration exists.",
      ],
    });
  }

  const decision = selected.withdrawals.length === 0 ? "SUPPLY" : "MIGRATE";
  return YieldOptimizationDeliverableSchema.parse({
    ...base,
    status: "ACTIONABLE",
    decision,
    selectedOpportunityId: selected.opportunity.opportunityId,
    allocationUsd: formatFixed(selected.allocation, 18),
    grossApyBps: selected.opportunity.grossApyBps,
    annualYieldUpliftUsd: formatFixed(selected.annualYieldUplift, 18),
    netBenefitUsd: formatFixed(selected.netBenefit, 18),
    migrationCostUsd: formatFixed(selected.migrationCost, 18),
    breakEvenDays: formatFixed(selected.breakEvenDays, 18),
    withdrawals: selected.withdrawals,
    idleCapitalUsedUsd: formatFixed(selected.idleCapitalUsed, 18),
    remainingIdleCapitalUsd: formatFixed(selected.remainingIdleCapital, 18),
    postMigrationCapitalUsd: formatFixed(selected.postMigrationCapital, 18),
    finalProtocolAllocations: selected.finalProtocolAllocations,
    summary: `${decision} ${formatFixed(selected.allocation, 2)} USD to ${selected.opportunity.opportunityId}; projected ${request.constraints.evaluationHorizonDays}-day net benefit is ${formatFixed(selected.netBenefit, 2)} USD.`,
    actionSteps: [
      ...selected.withdrawals.map((withdrawal) => `Withdraw ${withdrawal.amountUsd} USD from ${withdrawal.opportunityId}.`),
      `Reserve ${formatFixed(selected.migrationCost, 18)} USD from managed capital for the quoted entry and exit costs.`,
      `Supply ${formatFixed(selected.allocation, 18)} USD to ${selected.opportunity.vaultOrMarket}.`,
      `Re-evaluate before ${evidence.expiresAt}.`,
    ],
    risks: [
      `${selected.opportunity.protocol} risk tier is ${selected.opportunity.riskTier}.`,
      "Quoted APY is variable and is not a guaranteed return.",
      `Liquidity snapshot is ${selected.opportunity.liquidityUsd} USD.`,
      "Entry and selected exit quotes lack a gas breakdown; their full sum is bounded by maxGasUsd and the maxActionUsd cost budget.",
      "The withdrawal plan uses same-asset unlocked positions; it does not quote swaps or borrowing-market collateral checks.",
      "The bounded funding search compares APY and withdrawal-cost orderings; the selected plan is not guaranteed globally optimal.",
    ],
  });
}
