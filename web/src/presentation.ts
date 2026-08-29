import type { FixtureJobResponse, ProviderDeliverable, ServiceId } from "./types";

export function shortHash(value: string | undefined, lead = 12): string {
  if (!value) return "Pending";
  return `${value.slice(0, lead)}...${value.slice(-8)}`;
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(value));
}

export function serviceLabel(service: ServiceId): string {
  return {
    LENDING_RESCUE: "Lending rescue",
    LP_REBALANCE: "LP rebalance",
    YIELD_OPTIMIZATION: "Yield optimisation",
    BOUNDED_GRID: "Bounded grid",
  }[service];
}

export function statusTone(status: string): "good" | "warn" | "neutral" {
  if (status === "ACTIONABLE" || status === "COMPLETED") return "good";
  if (status.startsWith("REFUSED") || status === "REJECTED") return "warn";
  return "neutral";
}

export function resultHeadline(deliverable: ProviderDeliverable): string {
  if (deliverable.service === "LENDING_RESCUE") {
    const action = deliverable.recommendation;
    return action
      ? `${action.kind === "REPAY_DEBT" ? "Repay" : "Add"} ${action.amount} ${action.asset.symbol}`
      : deliverable.decision.replaceAll("_", " ");
  }
  if (deliverable.service === "LP_REBALANCE") {
    const range = deliverable.proposedRange;
    return range
      ? `${deliverable.decision} range to ${range.lowerTick}...${range.upperTick}`
      : deliverable.decision;
  }
  if (deliverable.service === "YIELD_OPTIMIZATION") {
    return deliverable.selectedOpportunityId
      ? `${deliverable.decision} to ${deliverable.selectedOpportunityId}`
      : deliverable.decision;
  }
  return deliverable.orders?.length
    ? `Build ${deliverable.orders.length} bounded orders`
    : deliverable.decision.replaceAll("_", " ");
}

export function resultMeaning(deliverable: ProviderDeliverable): {
  tone: "action" | "hold" | "refused";
  title: string;
  body: string;
} {
  if (deliverable.status.startsWith("REFUSED") || deliverable.status === "REJECTED") {
    return {
      tone: "refused",
      title: "This job did not produce a usable decision.",
      body: "Read the provider reason below. Correct the input or reload current evidence before creating another job.",
    };
  }

  const actionable = deliverable.status === "ACTIONABLE";

  if (actionable) {
    const title = deliverable.service === "LENDING_RESCUE"
      ? "Review the rescue plan before execution."
      : deliverable.service === "LP_REBALANCE"
        ? deliverable.decision === "EXIT"
          ? "Review the proposed LP exit."
          : "Review the proposed LP rebalance."
        : deliverable.service === "YIELD_OPTIMIZATION"
          ? "Review the selected yield allocation."
          : "Review the bounded order ladder.";
    return {
      tone: "action",
      title,
      body: "This is an unsigned provider result. Check its values, guards, and expiry, then revalidate current protocol state before acting.",
    };
  }

  const title = deliverable.service === "LENDING_RESCUE"
    ? "No rescue is needed from this snapshot."
    : deliverable.service === "LP_REBALANCE"
      ? "Keep the current LP position unchanged."
      : deliverable.service === "YIELD_OPTIMIZATION"
        ? "Keep the current allocation unchanged."
        : "Do not place this grid.";
  return {
    tone: "hold",
    title,
    body: "This is a completed provider decision, not a failed job. The evaluated snapshot did not justify an action within the request constraints.",
  };
}

export function metricsFor(deliverable: ProviderDeliverable) {
  if (deliverable.service === "LENDING_RESCUE") {
    return [
      { label: "Current health", value: deliverable.position?.currentHealthFactor ?? "-" },
      { label: "Stress health", value: deliverable.position?.stressedHealthFactor ?? "-", tone: "warn" },
      { label: "Projected health", value: deliverable.recommendation?.projectedHealthFactor ?? "-", tone: "good" },
      { label: "Action value", value: `$${deliverable.recommendation?.amountUsd ?? "0"}` },
    ];
  }
  if (deliverable.service === "LP_REBALANCE") {
    return [
      { label: "New range", value: deliverable.proposedRange ? `${deliverable.proposedRange.lowerTick}...${deliverable.proposedRange.upperTick}` : "Hold" },
      { label: "Net benefit", value: `$${deliverable.expectedNetBenefitUsd ?? "0"}`, tone: "good" },
      { label: "Rebalance cost", value: `$${deliverable.estimatedRebalanceCostUsd ?? "0"}` },
      { label: "Break-even", value: `${deliverable.breakEvenHours ?? "-"}h` },
    ];
  }
  if (deliverable.service === "YIELD_OPTIMIZATION") {
    return [
      { label: "Allocation", value: `$${deliverable.allocationUsd ?? "0"}` },
      { label: "Current APY", value: `${((deliverable.currentWeightedApyBps ?? 0) / 100).toFixed(2)}%` },
      { label: "Selected APY", value: `${((deliverable.grossApyBps ?? 0) / 100).toFixed(2)}%`, tone: "good" },
      { label: "90d net benefit", value: `$${deliverable.netBenefitUsd ?? "0"}`, tone: "good" },
    ];
  }
  return [
    { label: "Orders", value: String(deliverable.orders?.length ?? 0) },
    { label: "Expected net", value: `$${deliverable.expectedNetProfitUsd ?? "0"}`, tone: "good" },
    { label: "Worst-case loss", value: `$${deliverable.worstCaseLossUsd ?? "0"}`, tone: "warn" },
    { label: "Inventory cap", value: `$${deliverable.maximumInventoryUsd ?? "0"}` },
  ];
}

export function actionDetails(deliverable: ProviderDeliverable): Array<{ label: string; value: string }> {
  if (deliverable.service === "LENDING_RESCUE" && deliverable.recommendation) {
    return [
      { label: "Exact base units", value: deliverable.recommendation.amountBaseUnits },
      { label: "Estimated gas", value: `$${deliverable.recommendation.estimatedGasUsd}` },
      { label: "Slippage ceiling", value: `${deliverable.recommendation.maxSlippageBps} bps` },
      { label: "Execute before", value: formatTimestamp(deliverable.recommendation.executeBefore) + " UTC" },
    ];
  }
  if (deliverable.service === "LP_REBALANCE") {
    return [
      { label: "Decision", value: deliverable.decision },
      { label: "Inventory after", value: `${(deliverable.inventoryExposure?.token0Bps ?? 0) / 100}% / ${(deliverable.inventoryExposure?.token1Bps ?? 0) / 100}%` },
      { label: "Estimated cost", value: `$${deliverable.estimatedRebalanceCostUsd ?? "0"}` },
      { label: "Expires", value: formatTimestamp(deliverable.expiresAt) + " UTC" },
    ];
  }
  if (deliverable.service === "YIELD_OPTIMIZATION") {
    return [
      { label: "Destination", value: deliverable.selectedOpportunityId ?? "No migration" },
      { label: "Migration cost", value: `$${deliverable.migrationCostUsd ?? "0"}` },
      { label: "Break-even", value: `${deliverable.breakEvenDays ?? "-"} days` },
      { label: "Expires", value: formatTimestamp(deliverable.expiresAt) + " UTC" },
    ];
  }
  return [
    { label: "Decision", value: deliverable.decision.replaceAll("_", " ") },
    { label: "Order count", value: String(deliverable.orders?.length ?? 0) },
    { label: "Maximum loss", value: `$${deliverable.worstCaseLossUsd ?? "0"}` },
    { label: "Expires", value: formatTimestamp(deliverable.expiresAt) + " UTC" },
  ];
}

export function conditionsFor(deliverable: ProviderDeliverable): string[] {
  if (deliverable.service === "LENDING_RESCUE") {
    return [
      ...(deliverable.refusalReasons ?? []),
      ...(deliverable.recommendation?.preconditions ?? []),
      ...(deliverable.invalidationConditions ?? []),
    ].slice(0, 5);
  }
  if (deliverable.service === "BOUNDED_GRID") {
    return deliverable.cancellationConditions?.slice(0, 5) ?? [];
  }
  return deliverable.invalidationConditions?.slice(0, 5) ?? [];
}

export interface LendingThresholdPlan {
  state: "SAFE_NOW" | "WATCH" | "ACTION_REQUIRED" | "DECISION_UNAVAILABLE";
  tone: "safe" | "watch" | "action" | "refused";
  title: string;
  body: string;
  details: null | {
    currentBuffer: string;
    stressedBuffer: string;
    targetTrigger: string;
    liquidationTrigger: string;
    stressScenario: string;
    collateralDriver: string;
    debtDriver: string;
    nextStep: string;
    caveat: string;
  };
}

type LendingRequest = FixtureJobResponse["result"]["request"];

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function healthBuffer(value: number | null, target: number | null): string {
  if (value === null || target === null) return "Not available";
  const buffer = value - target;
  return `${buffer >= 0 ? "+" : ""}${buffer.toFixed(4)} HF`;
}

function uniformDropTrigger(healthFactor: number | null, threshold: number): string {
  if (healthFactor === null) return "Not available";
  if (healthFactor <= threshold) return "Crossed now";
  return `~${((1 - threshold / healthFactor) * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function largestPositionDriver(request: LendingRequest, side: "collateral" | "debt"): string {
  const position = request.position as Record<string, unknown> | undefined;
  const entries = Array.isArray(position?.[side]) ? position[side] as Array<Record<string, unknown>> : [];
  const ranked = entries.flatMap((entry) => {
    if (side === "collateral" && (entry.enabled === false || entry.collateralEnabled === false)) return [];
    const amount = finiteNumber(entry.amount);
    const price = finiteNumber(entry.priceUsd);
    if (amount === null || price === null) return [];
    const threshold = side === "collateral"
      ? (finiteNumber(entry.liquidationThresholdBps) ?? 10_000) / 10_000
      : 1;
    return [{
      symbol: String(entry.symbol ?? entry.asset ?? "Unknown asset"),
      value: amount * price * threshold,
    }];
  }).sort((a, b) => b.value - a.value)[0];
  if (!ranked) return `No ${side} driver available`;
  return `${ranked.symbol} · ${usd(ranked.value)}${side === "collateral" ? " liquidation-weighted" : " owed"}`;
}

function recommendationText(deliverable: ProviderDeliverable): string {
  const action = deliverable.recommendation;
  if (!action) return "No executable recommendation was produced.";
  const actionLabel = action.kind === "REPAY_DEBT" ? "Repay" : "Add";
  const projected = finiteNumber(action.projectedHealthFactor);
  return `${actionLabel} ${action.amount} ${action.asset.symbol}${projected === null ? "" : ` to target a projected ${projected.toFixed(4)} health factor`}. Revalidate the snapshot before any wallet action.`;
}

export function lendingThresholdPlan(
  deliverable: ProviderDeliverable,
  request: LendingRequest,
): LendingThresholdPlan {
  if (deliverable.service !== "LENDING_RESCUE") {
    return {
      state: "DECISION_UNAVAILABLE",
      tone: "refused",
      title: "Decision unavailable",
      body: "Threshold guidance is available only for Lending Rescue results.",
      details: null,
    };
  }

  if (deliverable.status.startsWith("REFUSED") || deliverable.status === "REJECTED") {
    return {
      state: "DECISION_UNAVAILABLE",
      tone: "refused",
      title: "Decision unavailable",
      body: "Read the provider reason below. Correct the input or reload current evidence before creating another job.",
      details: null,
    };
  }

  const current = finiteNumber(deliverable.position?.currentHealthFactor);
  const stressed = finiteNumber(deliverable.position?.stressedHealthFactor);
  const target = finiteNumber(deliverable.position?.targetHealthFactor);
  const stressDrop = finiteNumber(request.stressPriceDropBps);
  const actionable = deliverable.status === "ACTIONABLE" && deliverable.decision !== "NONE";
  const watch = !actionable && target !== null && stressed !== null && stressed < target;
  const state = actionable ? "ACTION_REQUIRED" : watch ? "WATCH" : "SAFE_NOW";
  const title = actionable ? "Action required" : watch ? "Watch closely" : current === null ? "No debt to rescue" : "Safe now";
  const body = actionable
    ? "The persisted snapshot is below the requested safety target. PositionCrew produced a bounded recommendation from the allowed actions."
    : watch
      ? "The position meets the target now, but the configured stress scenario falls below it. No action is recommended from the current snapshot."
      : current === null
        ? "No complete collateral-and-debt position was available, so there is no rescue threshold to calculate."
        : "The current and configured stressed health factors remain above the requested target. No rescue is needed from this snapshot.";

  if (current === null || target === null) {
    return { state, tone: actionable ? "action" : watch ? "watch" : "safe", title, body, details: null };
  }

  const allowedActions = Array.isArray(request.allowedActions)
    ? request.allowedActions.map(String).map((action) => action === "REPAY_DEBT" ? "repay debt" : action === "ADD_COLLATERAL" ? "add collateral" : action.toLowerCase()).join(" or ")
    : "an allowed rescue action";
  const maxAction = finiteNumber(request.maxActionUsd);

  return {
    state,
    tone: actionable ? "action" : watch ? "watch" : "safe",
    title,
    body,
    details: {
      currentBuffer: healthBuffer(current, target),
      stressedBuffer: healthBuffer(stressed, target),
      targetTrigger: uniformDropTrigger(current, target),
      liquidationTrigger: uniformDropTrigger(current, 1),
      stressScenario: stressDrop === null ? "Configured stress" : `${(stressDrop / 100).toFixed(1)}% collateral stress`,
      collateralDriver: largestPositionDriver(request, "collateral"),
      debtDriver: largestPositionDriver(request, "debt"),
      nextStep: actionable
        ? recommendationText(deliverable)
        : `If the target is crossed, reload the current position and rerun eligibility. The provider will evaluate ${allowedActions}${maxAction === null ? "" : ` within the ${usd(maxAction)} action cap`}; this Hold does not invent an amount in advance.`,
      caveat: "Scenario estimate only: all enabled collateral prices are assumed to fall together while debt and protocol thresholds remain unchanged. It is not a guaranteed market price or liquidation forecast.",
    },
  };
}

export interface CapitalDecisionPlan {
  tone: "hold" | "action" | "refused";
  state: string;
  title: string;
  body: string;
  details: null | {
    metrics: Array<{ label: string; value: string }>;
    basis: string;
    trigger: string;
    nextStepLabel: string;
    nextStep: string;
    caveat: string;
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function money(value: unknown): string {
  const number = finiteNumber(value);
  return number === null ? "Not available" : usd(number);
}

function firstUseful(values: Array<string | undefined>, fallback: string): string {
  return values.find((value) => value && value.trim().length > 0) ?? fallback;
}

function lpDecisionPlan(deliverable: ProviderDeliverable, request: LendingRequest): CapitalDecisionPlan {
  const position = record(request.position);
  const market = record(request.marketState);
  const currentTick = finiteNumber(market.currentTick);
  const lowerTick = finiteNumber(position.lowerTick);
  const upperTick = finiteNumber(position.upperTick);
  const inRange = currentTick !== null && lowerTick !== null && upperTick !== null
    ? currentTick >= lowerTick && currentTick < upperTick
    : null;
  const nearestEdge = inRange && currentTick !== null && lowerTick !== null && upperTick !== null
    ? Math.min(currentTick - lowerTick, upperTick - currentTick)
    : null;
  const actionable = deliverable.status === "ACTIONABLE";
  const proposed = deliverable.proposedRange;
  return {
    tone: actionable ? "action" : "hold",
    state: actionable ? "REBALANCE READY" : "KEEP RANGE",
    title: actionable ? `${deliverable.decision.toLowerCase()} the LP range` : "Keep the current LP range",
    body: actionable
      ? "The proposed range clears the configured benefit, cost and inventory limits. Review the steps before acting."
      : "The current range remains acceptable, or a proposed change did not clear its economic and inventory limits.",
    details: {
      metrics: [
        { label: "Current tick", value: currentTick === null ? "Not available" : currentTick.toLocaleString("en-US") },
        { label: "Current range", value: lowerTick === null || upperTick === null ? "Not available" : `${lowerTick.toLocaleString("en-US")} to ${upperTick.toLocaleString("en-US")}` },
        { label: actionable ? "Proposed range" : "Nearest range edge", value: actionable && proposed ? `${proposed.lowerTick.toLocaleString("en-US")} to ${proposed.upperTick.toLocaleString("en-US")}` : inRange === false ? "Outside range" : nearestEdge === null ? "Not available" : `${nearestEdge.toLocaleString("en-US")} ticks` },
        { label: actionable ? "Projected net benefit" : "Projected change benefit", value: money(deliverable.expectedNetBenefitUsd) },
      ],
      basis: actionable
        ? `${money(deliverable.estimatedRebalanceCostUsd)} estimated cost · ${deliverable.breakEvenHours ?? "unknown"} hours to break even`
        : deliverable.summary,
      trigger: firstUseful(deliverable.invalidationConditions ?? [], "Reload when range position, volatility, fees or execution costs change."),
      nextStepLabel: actionable ? "Proposed steps" : "When to check again",
      nextStep: actionable
        ? (deliverable.actionSteps ?? []).join(" ")
        : "Reload the position when it approaches a range edge or when volatility, fees or execution costs change.",
      caveat: firstUseful(deliverable.limitations ?? [], "Fee and position estimates must be refreshed before execution."),
    },
  };
}

function yieldDecisionPlan(deliverable: ProviderDeliverable): CapitalDecisionPlan {
  const actionable = deliverable.status === "ACTIONABLE";
  const currentApy = deliverable.currentWeightedApyBps ?? 0;
  const selectedApy = deliverable.grossApyBps;
  const uplift = selectedApy == null ? null : (selectedApy - currentApy) / 100;
  return {
    tone: actionable ? "action" : "hold",
    state: actionable ? "MOVE READY" : "KEEP ALLOCATION",
    title: actionable ? (deliverable.decision === "SUPPLY" ? "Supply the bounded allocation" : "Move the bounded allocation") : "Keep the current allocation",
    body: actionable
      ? "The selected market clears the configured liquidity, risk, cost and net-benefit limits. Returns remain variable."
      : "No available market currently improves the allocation enough after liquidity, risk and migration costs.",
    details: {
      metrics: [
        { label: "Current weighted APY", value: `${(currentApy / 100).toFixed(2)}%` },
        { label: "Selected APY", value: selectedApy == null ? "No eligible move" : `${(selectedApy / 100).toFixed(2)}%` },
        { label: "APY improvement", value: uplift === null ? "Not available" : `+${uplift.toFixed(2)} points` },
        { label: "Projected net benefit", value: money(deliverable.netBenefitUsd) },
      ],
      basis: actionable
        ? `${money(deliverable.allocationUsd)} allocation · ${money(deliverable.migrationCostUsd)} migration cost · ${deliverable.breakEvenDays ?? "unknown"} days to break even`
        : deliverable.summary,
      trigger: firstUseful(deliverable.invalidationConditions ?? [], "Reload when APY, liquidity, risk, lockup or route costs change."),
      nextStepLabel: actionable ? "Proposed steps" : "When to check again",
      nextStep: actionable
        ? (deliverable.actionSteps ?? []).join(" ")
        : "Reload rates when APY, liquidity, lockup, protocol risk or route costs change.",
      caveat: firstUseful(deliverable.risks ?? [], "Quoted APY is variable and is not a guaranteed return."),
    },
  };
}

function gridDecisionPlan(deliverable: ProviderDeliverable): CapitalDecisionPlan {
  const actionable = deliverable.status === "ACTIONABLE";
  const prices = (deliverable.orders ?? []).map((order) => finiteNumber(order.price)).filter((value): value is number => value !== null);
  const buys = (deliverable.orders ?? []).filter((order) => order.side === "BUY").length;
  const sells = (deliverable.orders ?? []).filter((order) => order.side === "SELL").length;
  const range = prices.length > 0
    ? `${Math.min(...prices).toLocaleString("en-US", { maximumFractionDigits: 8 })} to ${Math.max(...prices).toLocaleString("en-US", { maximumFractionDigits: 8 })}`
    : "No grid emitted";
  return {
    tone: actionable ? "action" : "hold",
    state: actionable ? "GRID READY" : "NO GRID",
    title: actionable ? "Review the bounded grid" : "Do not place this grid",
    body: actionable
      ? "The order ladder clears the configured range, liquidity, volatility, profit, loss and inventory limits. Fills are not guaranteed."
      : "The requested grid failed at least one market, profit, inventory or maximum-loss limit, so no orders were emitted.",
    details: {
      metrics: [
        { label: "Order range", value: range },
        { label: "Order sides", value: actionable ? `${buys} buy · ${sells} sell` : "No orders" },
        { label: "Projected net profit", value: money(deliverable.expectedNetProfitUsd) },
        { label: "Worst-case loss", value: money(deliverable.worstCaseLossUsd) },
      ],
      basis: actionable
        ? `${money(deliverable.maximumInventoryUsd)} maximum inventory across ${deliverable.orders?.length ?? 0} bounded orders`
        : deliverable.summary,
      trigger: firstUseful(deliverable.cancellationConditions ?? [], "Reload when price, volatility, liquidity or available capital changes."),
      nextStepLabel: actionable ? "Before placing orders" : "When to check again",
      nextStep: actionable
        ? "Re-quote every order, confirm the frozen capital and loss limits, and cancel the whole grid if any listed condition is crossed."
        : "Adjust the requested range or reload after liquidity, volatility, expected profit, inventory or loss conditions change.",
      caveat: firstUseful(deliverable.limitations ?? [], "Projected fills and profit are not guaranteed."),
    },
  };
}

export function capitalDecisionPlan(
  deliverable: ProviderDeliverable,
  request: LendingRequest,
): CapitalDecisionPlan {
  if (deliverable.status.startsWith("REFUSED") || deliverable.status === "REJECTED") {
    return {
      tone: "refused",
      state: "DECISION UNAVAILABLE",
      title: "Decision unavailable",
      body: "Read the provider reason below. Refresh the evidence or constraints before creating another job.",
      details: null,
    };
  }
  if (deliverable.service === "LP_REBALANCE") return lpDecisionPlan(deliverable, request);
  if (deliverable.service === "YIELD_OPTIMIZATION") return yieldDecisionPlan(deliverable);
  if (deliverable.service === "BOUNDED_GRID") return gridDecisionPlan(deliverable);
  return {
    tone: "refused",
    state: "DECISION UNAVAILABLE",
    title: "Decision unavailable",
    body: "This category uses a different decision explanation.",
    details: null,
  };
}
