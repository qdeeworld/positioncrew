import { RecentJobsPanel } from "./RecentJobsPanel";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  Code2,
  Download,
  ExternalLink,
  FileJson2,
  LoaderCircle,
  Play,
  RefreshCw,
  ReceiptText,
  ShieldCheck,
  Trash2,
  WalletCards,
} from "lucide-react";
import {
  actionDetails,
  conditionsFor,
  formatTimestamp,
  metricsFor,
  resultHeadline,
  resultMeaning,
  serviceLabel,
  shortHash,
  statusTone,
} from "../presentation";
import { TASKS } from "../task-config";
import type {
  AgentAdvantagePublicationStatus,
  FounderAgentAdvantagePublicationStatus,
  FounderAgentAdvantageAtAGlance,
  FounderAgentAdvantageAtAGlanceLoadState,
  PublicationLoadState,
  BenchmarkRepeatabilityResponse,
  BoundedGridForwardShadowLedger,
  BoundedGridForwardShadowWindow,
  CurrentMarketplaceObservation,
  FixtureJobResponse,
  FreshMarketplaceChain,
  JobRequestMode,
  MarketplaceInvocationEvidence,
  PancakeGridProbe,
  PancakePositionProbe,
  ProviderListing,
  ServiceId,
  SessionJob,
  SystemTelemetry,
  TermixBenchmarkService,
  VenusAccountProbe,
  VenusYieldProbe,
} from "../types";
import { isVerifiedFounderAgentAdvantagePublication } from "../types";

type ResultView = "summary" | "json" | "receipt";
type WorkspaceInputMode = "interactive" | "locked";

interface JobDraft {
  targetHealth: string;
  maxAction: string;
  stressDrop: string;
  maxSlippage: string;
  allowRepay: boolean;
  allowCollateral: boolean;
  lpCurrentTick: string;
  lpMinimumBenefit: string;
  lpGas: string;
  lpSwapCost: string;
  lpHorizon: string;
  lpMaximumGas: string;
  yieldCapital: string;
  yieldCandidateApy: string;
  yieldMinimumLiquidity: string;
  yieldMinimumBenefit: string;
  yieldHorizon: string;
  yieldRisk: "LOW" | "MEDIUM" | "HIGH";
  gridMidPrice: string;
  gridLowerPrice: string;
  gridUpperPrice: string;
  gridCapital: string;
  gridLevels: string;
  gridMaximumInventory: string;
  gridMaximumLoss: string;
  gridMinimumProfit: string;
  gridMaximumVolatility: string;
  gridExpectedCycles: string;
}

const EMPTY_DRAFT: JobDraft = {
  targetHealth: "1.25",
  maxAction: "250",
  stressDrop: "1000",
  maxSlippage: "30",
  allowRepay: true,
  allowCollateral: true,
  lpCurrentTick: "150",
  lpMinimumBenefit: "5",
  lpGas: "0.05",
  lpSwapCost: "0.95",
  lpHorizon: "24",
  lpMaximumGas: "0.10",
  yieldCapital: "1000",
  yieldCandidateApy: "900",
  yieldMinimumLiquidity: "1000000",
  yieldMinimumBenefit: "5",
  yieldHorizon: "90",
  yieldRisk: "MEDIUM",
  gridMidPrice: "10",
  gridLowerPrice: "9",
  gridUpperPrice: "11",
  gridCapital: "1000",
  gridLevels: "5",
  gridMaximumInventory: "600",
  gridMaximumLoss: "150",
  gridMinimumProfit: "100",
  gridMaximumVolatility: "1000",
  gridExpectedCycles: "10",
};

const REFERENCE_PANCAKE_POSITION_ID = "1456267";
const SAFE_REFUSAL_ACCOUNT = "0x0000000000000000000000000000000000000000";
const EVM_ACCOUNT_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const PROBE_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let timedOut = false;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (requestError) {
    if (timedOut) {
      throw new Error(
        `Venus data did not respond within ${Math.ceil(timeoutMs / 1_000)} seconds. ` +
        "No position or refusal was inferred; your address is unchanged, so retry Load position.",
      );
    }
    throw requestError;
  } finally {
    window.clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

type JobRequest = FixtureJobResponse["result"]["request"];

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function draftFromRequest(request: JobRequest | undefined): JobDraft {
  if (!request) return EMPTY_DRAFT;
  const next = { ...EMPTY_DRAFT };
  if (request.service === "LENDING_RESCUE") {
    const actions = Array.isArray(request.allowedActions) ? request.allowedActions : [];
    return {
      ...next,
      targetHealth: String(request.targetHealthFactor ?? next.targetHealth),
      maxAction: String(request.maxActionUsd ?? next.maxAction),
      stressDrop: String(request.stressPriceDropBps ?? next.stressDrop),
      maxSlippage: String(request.maxSlippageBps ?? next.maxSlippage),
      allowRepay: actions.includes("REPAY_DEBT"),
      allowCollateral: actions.includes("ADD_COLLATERAL"),
    };
  }
  if (request.service === "LP_REBALANCE") {
    const market = objectValue(request.marketState);
    const constraints = objectValue(request.constraints);
    return {
      ...next,
      lpCurrentTick: String(market.currentTick ?? next.lpCurrentTick),
      lpMinimumBenefit: String(constraints.minimumNetBenefitUsd ?? next.lpMinimumBenefit),
      lpGas: String(constraints.estimatedGasUsd ?? next.lpGas),
      lpSwapCost: String(constraints.estimatedSwapCostUsd ?? next.lpSwapCost),
      lpHorizon: String(constraints.evaluationHorizonHours ?? next.lpHorizon),
      lpMaximumGas: String(request.maxGasUsd ?? next.lpMaximumGas),
    };
  }
  if (request.service === "YIELD_OPTIMIZATION") {
    const constraints = objectValue(request.constraints);
    const opportunities = Array.isArray(request.opportunities) ? request.opportunities : [];
    const candidate = objectValue(opportunities[0]);
    const risk = constraints.maximumRiskTier;
    return {
      ...next,
      yieldCapital: String(request.capitalUsd ?? next.yieldCapital),
      yieldCandidateApy: String(candidate.grossApyBps ?? next.yieldCandidateApy),
      yieldMinimumLiquidity: String(constraints.minimumLiquidityUsd ?? next.yieldMinimumLiquidity),
      yieldMinimumBenefit: String(constraints.minimumNetBenefitUsd ?? next.yieldMinimumBenefit),
      yieldHorizon: String(constraints.evaluationHorizonDays ?? next.yieldHorizon),
      yieldRisk: risk === "LOW" || risk === "HIGH" ? risk : "MEDIUM",
    };
  }
  const market = objectValue(request.marketState);
  const constraints = objectValue(request.constraints);
  return {
    ...next,
    gridMidPrice: String(market.midPrice ?? next.gridMidPrice),
    gridLowerPrice: String(constraints.lowerPrice ?? next.gridLowerPrice),
    gridUpperPrice: String(constraints.upperPrice ?? next.gridUpperPrice),
    gridCapital: String(constraints.capitalUsd ?? next.gridCapital),
    gridLevels: String(constraints.levelCount ?? next.gridLevels),
    gridMaximumInventory: String(constraints.maximumInventoryUsd ?? next.gridMaximumInventory),
    gridMaximumLoss: String(constraints.maximumLossUsd ?? next.gridMaximumLoss),
    gridMinimumProfit: String(constraints.minimumExpectedNetProfitUsd ?? next.gridMinimumProfit),
    gridMaximumVolatility: String(constraints.maximumVolatilityBps ?? next.gridMaximumVolatility),
    gridExpectedCycles: String(constraints.expectedCompletedCycles ?? next.gridExpectedCycles),
  };
}

function applyDraft(
  request: JobRequest,
  draft: JobDraft,
  lockObservations = false,
): JobRequest {
  const next = structuredClone(request);
  if (next.service === "LENDING_RESCUE") {
    next.targetHealthFactor = draft.targetHealth;
    next.maxActionUsd = draft.maxAction;
    next.stressPriceDropBps = Number(draft.stressDrop);
    next.maxSlippageBps = Number(draft.maxSlippage);
    next.allowedActions = [
      ...(draft.allowRepay ? ["REPAY_DEBT"] : []),
      ...(draft.allowCollateral ? ["ADD_COLLATERAL"] : []),
    ];
  } else if (next.service === "LP_REBALANCE") {
    const market = objectValue(next.marketState);
    const constraints = objectValue(next.constraints);
    if (!lockObservations) market.currentTick = Number(draft.lpCurrentTick);
    constraints.minimumNetBenefitUsd = draft.lpMinimumBenefit;
    constraints.estimatedGasUsd = draft.lpGas;
    constraints.estimatedSwapCostUsd = draft.lpSwapCost;
    constraints.evaluationHorizonHours = Number(draft.lpHorizon);
    next.maxGasUsd = draft.lpMaximumGas;
  } else if (next.service === "YIELD_OPTIMIZATION") {
    const constraints = objectValue(next.constraints);
    const opportunities = Array.isArray(next.opportunities) ? next.opportunities : [];
    const candidate = objectValue(opportunities[0]);
    next.capitalUsd = draft.yieldCapital;
    for (const opportunity of opportunities) {
      const market = objectValue(opportunity);
      const liquidityUsd = Number(market.liquidityUsd);
      const capitalUsd = Number(draft.yieldCapital);
      market.amountUsd = String(
        Number.isFinite(liquidityUsd) && Number.isFinite(capitalUsd)
          ? Math.min(capitalUsd, liquidityUsd)
          : draft.yieldCapital,
      );
    }
    if (!lockObservations) candidate.grossApyBps = Number(draft.yieldCandidateApy);
    constraints.minimumLiquidityUsd = draft.yieldMinimumLiquidity;
    constraints.minimumNetBenefitUsd = draft.yieldMinimumBenefit;
    constraints.evaluationHorizonDays = Number(draft.yieldHorizon);
    constraints.maximumRiskTier = draft.yieldRisk;
  } else {
    const market = objectValue(next.marketState);
    const constraints = objectValue(next.constraints);
    if (!lockObservations) market.midPrice = draft.gridMidPrice;
    constraints.lowerPrice = draft.gridLowerPrice;
    constraints.upperPrice = draft.gridUpperPrice;
    constraints.capitalUsd = draft.gridCapital;
    constraints.levelCount = Number(draft.gridLevels);
    constraints.maximumInventoryUsd = draft.gridMaximumInventory;
    constraints.maximumLossUsd = draft.gridMaximumLoss;
    constraints.minimumExpectedNetProfitUsd = draft.gridMinimumProfit;
    constraints.maximumVolatilityBps = Number(draft.gridMaximumVolatility);
    constraints.expectedCompletedCycles = Number(draft.gridExpectedCycles);
    next.maxActionUsd = draft.gridCapital;
  }
  return next;
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
  min,
  max,
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  min: string;
  max: string;
  step: string;
}) {
  const errorId = useId();
  const error = numericFieldError(value, label, min, max, step);
  return (
    <label>
      <span>{label}</span>
      <input
        disabled={disabled}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        required
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && <small className="field-error" id={errorId}>{error}</small>}
    </label>
  );
}

function numericFieldError(value: string, label: string, min: string, max: string, step: string): string | null {
  if (!value.trim()) return `${label} is required.`;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `${label} must be a number.`;
  if (parsed < Number(min) || parsed > Number(max)) return `${label} must be between ${min} and ${max}.`;
  if (Number(step) >= 1 && !Number.isInteger(parsed)) return `${label} must be a whole number.`;
  return null;
}

function draftValidationErrors(service: ServiceId, draft: JobDraft): string[] {
  const fields: Array<[string, string, string, string, string]> = service === "LENDING_RESCUE"
    ? [
        [draft.targetHealth, "Target health factor", "1.01", "3", "0.01"],
        [draft.maxAction, "Maximum action", "1", "10000", "1"],
        [draft.stressDrop, "Stress price drop", "0", "5000", "100"],
        [draft.maxSlippage, "Maximum slippage", "0", "2000", "1"],
      ]
    : service === "LP_REBALANCE"
      ? [
          [draft.lpCurrentTick, "Current tick", "-887272", "887272", "1"],
          [draft.lpMinimumBenefit, "Minimum net benefit", "0", "100000", "0.01"],
          [draft.lpGas, "Estimated gas", "0", "10000", "0.01"],
          [draft.lpSwapCost, "Estimated swap cost", "0", "10000", "0.01"],
          [draft.lpHorizon, "Evaluation horizon", "1", "720", "1"],
          [draft.lpMaximumGas, "Maximum gas", "0", "10000", "0.01"],
        ]
      : service === "YIELD_OPTIMIZATION"
        ? [
            [draft.yieldCapital, "Capital", "1", "10000000", "1"],
            [draft.yieldCandidateApy, "Leading base APY", "0", "1000000", "1"],
            [draft.yieldMinimumLiquidity, "Minimum liquidity", "0", "10000000000", "1"],
            [draft.yieldMinimumBenefit, "Minimum net benefit", "0", "1000000", "0.01"],
            [draft.yieldHorizon, "Evaluation horizon", "1", "365", "1"],
          ]
        : [
            [draft.gridMidPrice, "Mid price", "0.000001", "10000000", "0.01"],
            [draft.gridLowerPrice, "Lower price", "0.000001", "10000000", "0.01"],
            [draft.gridUpperPrice, "Upper price", "0.000001", "10000000", "0.01"],
            [draft.gridCapital, "Capital", "1", "10000000", "1"],
            [draft.gridLevels, "Grid levels", "2", "100", "1"],
            [draft.gridMaximumInventory, "Maximum inventory", "1", "10000000", "1"],
            [draft.gridMaximumLoss, "Maximum loss", "0.01", "10000000", "0.01"],
            [draft.gridMinimumProfit, "Minimum expected profit", "0", "10000000", "0.01"],
            [draft.gridMaximumVolatility, "Maximum volatility", "1", "100000", "1"],
            [draft.gridExpectedCycles, "Expected completed cycles", "1", "1000", "1"],
          ];
  return fields.map(([value, label, min, max, step]) => numericFieldError(value, label, min, max, step)).filter((error): error is string => Boolean(error));
}

function displayHealthFactor(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "No debt";
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function healthMarkerPercent(value: number | null, upperBound: number): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, ((value - 0.8) / (upperBound - 0.8)) * 100));
}

function healthMarkerPosition(value: number | null, upperBound: number): string {
  return `${healthMarkerPercent(value, upperBound)}%`;
}

function lendingPositionMetrics(request: JobRequest | null) {
  if (!request || request.service !== "LENDING_RESCUE") {
    return { current: null, stressed: null, target: "-" };
  }
  const position = objectValue(request.position);
  const collateral = Array.isArray(position.collateral) ? position.collateral : [];
  const debt = Array.isArray(position.debt) ? position.debt : [];
  const weightedCollateral = collateral.reduce((total, item) => {
    const balance = objectValue(item);
    if (balance.collateralEnabled !== true) return total;
    return total +
      Number(balance.amount ?? 0) *
      Number(balance.priceUsd ?? 0) *
      Number(balance.liquidationThresholdBps ?? 0) / 10_000;
  }, 0);
  const debtValue = debt.reduce((total, item) => {
    const balance = objectValue(item);
    return total + Number(balance.amount ?? 0) * Number(balance.priceUsd ?? 0);
  }, 0);
  const current = debtValue > 0 ? weightedCollateral / debtValue : null;
  const stressMultiplier = 1 - Number(request.stressPriceDropBps ?? 0) / 10_000;
  return {
    current,
    stressed: current === null ? null : current * Math.max(0, stressMultiplier),
    target: String(request.targetHealthFactor ?? "-"),
  };
}

function LendingPositionBar({ request }: { request: JobRequest | null }) {
  const position = lendingPositionMetrics(request);
  const target = Number(position.target);
  const upperBound = Math.max(
    1.5,
    Number.isFinite(target) ? target * 1.2 : 0,
    position.current ?? 0,
    position.stressed ?? 0,
  ) * 1.05;
  const dangerWidth = healthMarkerPercent(1, upperBound);
  const targetPosition = healthMarkerPercent(Number.isFinite(target) ? target : 1.2, upperBound);
  const bufferWidth = Math.max(0, targetPosition - dangerWidth);
  const safeWidth = Math.max(0, 100 - dangerWidth - bufferWidth);
  return (
    <div className="position-bar" aria-label="Lending position health">
      <div
        className="position-bar-track"
        aria-hidden="true"
        style={{ gridTemplateColumns: `${dangerWidth}% ${bufferWidth}% ${safeWidth}%` }}
      >
        <span className="zone-danger" />
        <span className="zone-buffer" />
        <span className="zone-safe" />
        <i className="marker stressed" style={{ left: healthMarkerPosition(position.stressed, upperBound) }} />
        <i className="marker current" style={{ left: healthMarkerPosition(position.current, upperBound) }} />
        <i className="marker target" style={{ left: healthMarkerPosition(target, upperBound) }} />
      </div>
      <div className="position-bar-labels">
        <span><i className="dot stressed" /> Stress {displayHealthFactor(position.stressed)}</span>
        <span><i className="dot current" /> Current {displayHealthFactor(position.current)}</span>
        <span><i className="dot target" /> Target {position.target}</span>
      </div>
    </div>
  );
}

function LendingProviderAuditionPanel({
  trace,
}: {
  trace: FreshMarketplaceChain | null;
}) {
  const evidence = trace?.hire.evidence;
  const audition = evidence?.evidenceClass === "CURRENT_BLOCK_PINNED"
    ? evidence.providerAudition
    : undefined;
  if (!audition) return null;
  const eligibleCount = audition.candidates.filter((candidate) =>
    candidate.checks.every((check) => check.status === "PASS")
  ).length;

  return (
    <section
      className="provider-audition-panel"
      aria-labelledby="provider-audition-title"
      data-testid="lending-provider-audition"
    >
      <div className="provider-audition-heading">
        <div>
          <span className="section-kicker">Eligibility before execution</span>
          <h3 id="provider-audition-title">{eligibleCount === 1 ? "Sole eligible provider selected" : "Provider eligibility recorded"}</h3>
          <p>
            The same block-pinned Lending request was checked against each candidate&apos;s
            contract and execution path. This is an eligibility decision, not a performance ranking.
          </p>
        </div>
        <span className="provider-audition-selection">
          <CheckCircle2 size={15} aria-hidden="true" /> {eligibleCount} eligible / {audition.candidates.length} checked
        </span>
      </div>

      <div className="provider-audition-grid">
        {audition.candidates.map((candidate) => {
          const selected = candidate.candidateId === audition.selection.winnerCandidateId;
          return (
            <article
              className={`provider-audition-candidate ${selected ? "selected" : "ineligible"}`}
              key={candidate.candidateId}
            >
              <div className="provider-audition-candidate-head">
                <div>
                  <span>{candidate.relationship === "FIRST_PARTY" ? "First-party provider" : "External identity"}</span>
                  <h4>{candidate.name}</h4>
                </div>
                <strong>
                  {selected ? <Check size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
                  {selected ? "Eligible / selected" : "Ineligible / not invoked"}
                </strong>
              </div>

              <div className="provider-audition-facts">
                <div>
                  <span>Identity evidence</span>
                  <b>ERC-8004 / BSC mainnet / token #{candidate.identity.agentTokenId}</b>
                  <small>
                    {selected
                      ? "Mainnet identity evidence only; it does not create or prove a TermiX order."
                      : "The identity snapshot is evidence of registration, not a callable PositionCrew job contract."}
                  </small>
                </div>
                <div>
                  <span>Execution path</span>
                  <b>{candidate.executionAdapter.callable ? "Local PositionCrew adapter" : "No supported adapter"}</b>
                  <small>
                    {selected
                      ? "The existing durable worker evaluates the persisted request locally."
                      : "PositionCrew did not call this external provider."}
                  </small>
                </div>
              </div>

              <ul className="provider-audition-checks">
                {candidate.checks.map((check) => (
                  <li className={check.status.toLowerCase()} key={check.code}>
                    <span>{check.status}</span>
                    <p>{check.detail}</p>
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>

      <footer className="provider-audition-boundary">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>
          No payment, marketplace order, external-provider execution, settlement, signature, custody,
          or protocol transaction occurred. Audition receipt <code>{shortHash(audition.auditionHash, 18)}</code>.
        </span>
      </footer>
    </section>
  );
}

const BENCHMARK_SERVICES = new Set<TermixBenchmarkService>([
  "LENDING_RESCUE",
  "LP_REBALANCE",
  "BOUNDED_GRID",
]);

function ResultAdvantageBand({
  service,
  conformanceScore,
  benchmarks,
  marketplaceProvenance,
  advantagePublication,
  founderAdvantagePublication,
  founderAdvantageAtAGlance,
  founderAdvantageAtAGlanceLoadState,
  advantagePublicationLoadState,
  founderAdvantagePublicationLoadState,
}: {
  service: ServiceId;
  conformanceScore: number;
  benchmarks: BenchmarkRepeatabilityResponse[];
  marketplaceProvenance: MarketplaceInvocationEvidence | null;
  advantagePublication: AgentAdvantagePublicationStatus | null;
  founderAdvantagePublication: FounderAgentAdvantagePublicationStatus | null;
  founderAdvantageAtAGlance: FounderAgentAdvantageAtAGlance | null;
  founderAdvantageAtAGlanceLoadState: FounderAgentAdvantageAtAGlanceLoadState;
  advantagePublicationLoadState: PublicationLoadState;
  founderAdvantagePublicationLoadState: PublicationLoadState;
}) {
  const benchmarked = BENCHMARK_SERVICES.has(service as TermixBenchmarkService);
  const repeatability = benchmarks.find((record) => record.service === service);
  const delivery = marketplaceProvenance?.summaries.find((summary) => summary.service === service);
  const published = advantagePublication?.status === "PUBLISHED" ? advantagePublication : null;
  const publishedFounder = isVerifiedFounderAgentAdvantagePublication(
    founderAdvantagePublication,
  )
    ? founderAdvantagePublication
    : null;
  const founderTask = founderAdvantageAtAGlanceLoadState === "AVAILABLE"
    ? founderAdvantageAtAGlance?.tasks.find((task) => task.service === service) ?? null
    : null;

  if (!benchmarked) {
    return (
      <section className="result-advantage-band neutral" aria-label="Evidence status">
        <div className="result-advantage-copy">
          <span className="result-advantage-state"><ShieldCheck size={13} /> Conformance only</span>
          <strong>Verified output contract, outside the three-task comparison.</strong>
          <small>Yield optimisation is not one of the pre-registered Agent Advantage tasks. Its {conformanceScore}/100 receipt is a deterministic conformance result, not an advantage claim.</small>
        </div>
        <a href="#evidence">Inspect evidence <ArrowRight size={13} /></a>
      </section>
    );
  }

  if (
    !advantagePublication &&
    !founderAdvantagePublication &&
    (advantagePublicationLoadState === "LOADING" ||
      founderAdvantagePublicationLoadState === "LOADING")
  ) {
    return (
      <section className="result-advantage-band neutral" aria-label="Agent Advantage status">
        <div className="result-advantage-copy">
          <span className="result-advantage-state"><Clock3 size={13} /> Evidence status loading</span>
          <strong>The useful result remains available while its comparison record loads.</strong>
          <small>The {conformanceScore}/100 receipt is deterministic conformance. PositionCrew does not infer an Agent Advantage result when the independent publication record is unavailable.</small>
        </div>
        <a href="#evidence">Inspect evidence <ArrowRight size={13} /></a>
      </section>
    );
  }

  if (
    !advantagePublication &&
    !founderAdvantagePublication &&
    advantagePublicationLoadState === "UNAVAILABLE" &&
    founderAdvantagePublicationLoadState === "UNAVAILABLE"
  ) {
    return (
      <section className="result-advantage-band neutral" aria-label="Agent Advantage status unavailable">
        <div className="result-advantage-copy">
          <span className="result-advantage-state"><AlertTriangle size={13} /> Evidence status unavailable</span>
          <strong>Neither tracked benchmark publication record is currently available.</strong>
          <small>The conformance receipt remains visible, but no independent or founder comparison result and no report link is inferred.</small>
        </div>
        <a href="#evidence">Inspect evidence <ArrowRight size={13} /></a>
      </section>
    );
  }

  if (published) {
    return (
      <section className="result-advantage-band published" aria-label="Agent Advantage status">
        <div className="result-advantage-copy">
          <span className="result-advantage-state"><BadgeCheck size={13} /> Independent report published</span>
          <strong>{published.supportedAdvantageCount}/3 frozen tasks support the pre-registered advantage rule.</strong>
          <small>{published.agentBlindQualityScore}/300 blind agent quality score. Scope is limited to the published report and does not establish live investment performance.</small>
        </div>
        <a href={published.reportUrl}>Open report <ArrowRight size={13} /></a>
      </section>
    );
  }

  if (publishedFounder && founderTask) {
    return (
      <section className="result-advantage-band published task-detail" aria-label="Founder Agent Advantage comparison status">
        <div className="result-advantage-copy">
          <span className="result-advantage-state"><BadgeCheck size={13} /> Founder comparison published</span>
          <strong>{founderTask.title}: exact canonical output match.</strong>
          <div className="result-advantage-metrics" aria-label="Recorded task comparison">
            <span><small>Agent D1 API</small><b>{founderTask.agentElapsedMilliseconds.toLocaleString("en-US")} ms</b></span>
            <span><small>Manual wall clock</small><b>{founderTask.manualElapsedMilliseconds.toLocaleString("en-US")} ms</b></span>
            <span><small>Direct cost</small><b>$0 / $0</b></span>
          </div>
          <small>Quality was evaluated by exact canonical output parity; no separate numeric rating exists. Agent API duration and founder wall-clock time are different execution contexts, not a controlled speedup claim. Historical, founder-operated, non-independent, and non-blind; no payment, live execution, or investment performance.</small>
        </div>
        <a href={founderTask.receiptUrl} target="_blank" rel="noreferrer">Open task receipt <ArrowRight size={13} /></a>
      </section>
    );
  }

  if (publishedFounder) {
    return (
      <section className="result-advantage-band neutral" aria-label="Founder Agent Advantage comparison status">
        <div className="result-advantage-copy">
          <span className="result-advantage-state"><AlertTriangle size={13} /> Founder task detail unavailable</span>
          <strong>The published comparison remains linked, but this task's detail was not projected.</strong>
          <small>No task timing, cost, quality, or receipt metric is inferred while the report is loading, unavailable, or commitment-mismatched.</small>
        </div>
        <a href={publishedFounder.reportUrl}>Open founder report <ArrowRight size={13} /></a>
      </section>
    );
  }

  return (
    <section className="result-advantage-band pending" aria-label="Agent Advantage status">
      <div className="result-advantage-copy">
        <span className="result-advantage-state"><Clock3 size={13} /> Independent comparison pending</span>
        <strong>{delivery ? `${delivery.successCount}/2 controlled endpoint observations retained${delivery.medianElapsedMilliseconds != null ? ` at ${delivery.medianElapsedMilliseconds} ms median` : ""}.` : "The endpoint observation record is still loading."}</strong>
        <small>{repeatability ? `${repeatability.runs.length} source-committed agent candidates are locked. ` : "The source-committed candidate record is still loading. "}{service === "BOUNDED_GRID" ? "Grid still has an unresolved fresh-input versus historical-result mode contradiction. " : ""}{founderAdvantagePublicationLoadState === "UNAVAILABLE" ? "The founder publication status is unavailable. " : founderAdvantagePublication?.status === "PUBLISHED" && !publishedFounder ? "The founder publication record failed verification, so no claim or link is enabled. " : ""}This is partial E2 evidence, not a marketplace hire or fresh execution. {advantagePublicationLoadState === "UNAVAILABLE" ? "The independent publication status is unavailable." : "Independent blind evaluation remains pending."}</small>
      </div>
      <a href="#evidence">Inspect evidence <ArrowRight size={13} /></a>
    </section>
  );
}

function SummaryResult({
  response,
  benchmarks,
  marketplaceProvenance,
  advantagePublication,
  founderAdvantagePublication,
  founderAdvantageAtAGlance,
  founderAdvantageAtAGlanceLoadState,
  advantagePublicationLoadState,
  founderAdvantagePublicationLoadState,
}: {
  response: FixtureJobResponse;
  benchmarks: BenchmarkRepeatabilityResponse[];
  marketplaceProvenance: MarketplaceInvocationEvidence | null;
  advantagePublication: AgentAdvantagePublicationStatus | null;
  founderAdvantagePublication: FounderAgentAdvantagePublicationStatus | null;
  founderAdvantageAtAGlance: FounderAgentAdvantageAtAGlance | null;
  founderAdvantageAtAGlanceLoadState: FounderAgentAdvantageAtAGlanceLoadState;
  advantagePublicationLoadState: PublicationLoadState;
  founderAdvantagePublicationLoadState: PublicationLoadState;
}) {
  const deliverable = response.result.deliverable;
  const meaning = resultMeaning(deliverable);
  const MeaningIcon = meaning.tone === "refused" ? AlertTriangle : meaning.tone === "action" ? CheckCircle2 : ShieldCheck;
  const metrics = metricsFor(deliverable);
  const details = actionDetails(deliverable);
  const conditions = conditionsFor(deliverable);
  const sources = Array.isArray(response.result.request.sources)
    ? response.result.request.sources
    : [];
  const usesBlockPinnedVenusInput = sources.some((source) =>
    String(objectValue(source).sourceId ?? "").startsWith("venus-mainnet-block-"),
  );
  const usesBlockPinnedPancakeGridInput = sources.some((source) =>
    String(objectValue(source).sourceId ?? "").startsWith("pancake-v3-mainnet-block-"),
  );
  const usesBlockPinnedPancakePositionInput = sources.some((source) =>
    String(objectValue(source).sourceId ?? "").startsWith("pancake-position-mainnet-block-"),
  );
  const usesBlockPinnedVenusYieldInput = sources.some((source) =>
    String(objectValue(source).sourceId ?? "").startsWith("venus-yield-mainnet-block-"),
  );
  return (
    <div className="result-summary-view">
      <div className="decision-header">
        <div>
          <span className={`state-label ${statusTone(deliverable.status)}`}>
            <MeaningIcon size={13} /> {deliverable.status.replaceAll("_", " ")}
          </span>
          <h2>{resultHeadline(deliverable)}</h2>
          <p>{deliverable.summary}</p>
        </div>
        <span className="expires-label"><Clock3 size={13} /> Expires {formatTimestamp(deliverable.expiresAt)} UTC</span>
      </div>
      <section className={`result-meaning ${meaning.tone}`} aria-label="What this result means">
        <MeaningIcon size={18} aria-hidden="true" />
        <div>
          <span>What this means</span>
          <strong>{meaning.title}</strong>
          <p>{meaning.body}</p>
        </div>
      </section>
      <div className={`result-boundary ${response.evidenceMode === "FROZEN_BSC_TEST_FIXTURE" ? "locked" : "interactive"}`}>
        {response.evidenceMode === "FROZEN_BSC_TEST_FIXTURE" ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
        <span>{response.evidenceMode === "FROZEN_BSC_TEST_FIXTURE"
          ? "Locked historical fixture. This is a reproducible receipt, not a currently executable instruction."
          : usesBlockPinnedVenusInput
            ? "Block-pinned Venus input. The provider output is unsigned and must be revalidated against current protocol state before execution."
            : usesBlockPinnedVenusYieldInput
              ? "Block-pinned Venus yield input. Base rates exclude incentives; the unsigned allocation must be revalidated before execution."
            : usesBlockPinnedPancakePositionInput
              ? "Block-pinned PancakeSwap position. NFT state and collectible fees were read-only simulations; swap activity is an extrapolated 24-hour run rate. Revalidate before execution."
            : usesBlockPinnedPancakeGridInput
              ? "Block-pinned PancakeSwap input. The grid is unsigned, assumes future fills, and must be re-quoted before execution."
            : "Interactive scenario only. Its inputs were not fetched live and must be revalidated against current protocol state before execution."}</span>
      </div>
      <div className="decision-metrics">
        {metrics.map((metric) => (
          <div key={metric.label} className={metric.tone ?? ""}>
            <span>{metric.label}</span><strong>{metric.value}</strong>
          </div>
        ))}
      </div>
      <div className="decision-detail-grid">
        <section>
          <h3>{meaning.tone === "action" ? "Action specification" : "Decision record"}</h3>
          <dl className="spec-list">
            {details.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}
          </dl>
        </section>
        <section>
          <h3>{meaning.tone === "action" ? "Execution guards" : meaning.tone === "refused" ? "Provider reasons" : "Evidence and invalidation"}</h3>
          <ul className="guard-list">
            {conditions.map((condition) => <li key={condition}><Check size={14} /><span>{condition}</span></li>)}
          </ul>
        </section>
      </div>
      {deliverable.service === "LENDING_RESCUE" && deliverable.alternatives?.[0] && (
        <div className="alternative-action">
          <span><strong>Alternative</strong>Add {deliverable.alternatives[0].amount} {deliverable.alternatives[0].asset.symbol} (${deliverable.alternatives[0].amountUsd})</span>
          <span>Projected HF <strong>{deliverable.alternatives[0].projectedHealthFactor}</strong></span>
        </div>
      )}
      <ResultAdvantageBand
        service={deliverable.service}
        conformanceScore={response.result.evaluation.score}
        benchmarks={benchmarks}
        marketplaceProvenance={marketplaceProvenance}
        advantagePublication={advantagePublication}
        founderAdvantagePublication={founderAdvantagePublication}
        founderAdvantageAtAGlance={founderAdvantageAtAGlance}
        founderAdvantageAtAGlanceLoadState={founderAdvantageAtAGlanceLoadState}
        advantagePublicationLoadState={advantagePublicationLoadState}
        founderAdvantagePublicationLoadState={founderAdvantagePublicationLoadState}
      />
    </div>
  );
}

function ReceiptView({
  response,
  marketplaceTrace,
  shadowWindow,
}: {
  response: FixtureJobResponse;
  marketplaceTrace: FreshMarketplaceChain | null;
  shadowWindow: BoundedGridForwardShadowWindow | null;
}) {
  const { job, evaluation } = response.result;
  function downloadReceipt() {
    const body = JSON.stringify(response, null, 2);
    const href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = `${job.jobId}.receipt.json`;
    link.click();
    URL.revokeObjectURL(href);
  }
  return (
    <div className="receipt-view">
      <div className="receipt-actions">
        <span><ShieldCheck size={14} /> {response.receipt.mode.replaceAll("_", " ")}</span>
        <div>
          {shadowWindow && <a href={shadowWindow.receiptUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Separate shadow evidence</a>}
          {marketplaceTrace?.receipt && <a href={marketplaceTrace.receipt.publicUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Reload durable receipt</a>}
          {response.receipt.path && <a href={response.receipt.path} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Public receipt</a>}
          <button type="button" onClick={downloadReceipt}><Download size={14} /> Download</button>
        </div>
      </div>
      <dl className="receipt-facts">
        {marketplaceTrace && <div><dt>Hire ID</dt><dd>{marketplaceTrace.hire.hireId}</dd></div>}
        {marketplaceTrace && <div><dt>Evidence mode</dt><dd>{marketplaceTrace.hire.evidenceMode.replaceAll("_", " ")}</dd></div>}
        {marketplaceTrace && <div><dt>Request hash</dt><dd>{marketplaceTrace.hire.requestHash}</dd></div>}
        {marketplaceTrace?.hire.providerHash && <div><dt>Provider hash</dt><dd>{marketplaceTrace.hire.providerHash}</dd></div>}
        {marketplaceTrace?.hire.evidenceHash && <div><dt>Evidence hash</dt><dd>{marketplaceTrace.hire.evidenceHash}</dd></div>}
        {marketplaceTrace?.receipt && <div><dt>Receipt ID</dt><dd>{marketplaceTrace.receipt.receiptId}</dd></div>}
        {marketplaceTrace?.receipt && <div><dt>Result hash</dt><dd>{marketplaceTrace.receipt.responseHash}</dd></div>}
        {marketplaceTrace?.job.apiDurationMilliseconds != null && <div><dt>Provider API time</dt><dd>{marketplaceTrace.job.apiDurationMilliseconds} ms</dd></div>}
        {marketplaceTrace?.job.completedAt && <div><dt>Completed at</dt><dd>{formatTimestamp(marketplaceTrace.job.completedAt)} UTC</dd></div>}
        {shadowWindow && <div><dt>Shadow evidence</dt><dd>{shadowWindow.state.replaceAll("_", " ")}</dd></div>}
        {shadowWindow && <div><dt>Shadow window</dt><dd>{shadowWindow.windowId}</dd></div>}
        <div><dt>Job ID</dt><dd>{job.jobId}</dd></div>
        <div><dt>Provider</dt><dd>{job.providerId}</dd></div>
        <div><dt>Conformance scorer</dt><dd>{job.evaluatorId}</dd></div>
        <div><dt>Envelope</dt><dd>{job.envelopeHash}</dd></div>
        <div><dt>Deliverable</dt><dd>{job.deliverable.deliverableHash}</dd></div>
        <div><dt>Score receipt</dt><dd>{evaluation.evaluationHash}</dd></div>
      </dl>
      <ol className="vertical-timeline">
        {job.history.map((entry) => (
          <li key={`${entry.state}-${entry.reference}`}>
            <span><Check size={12} /></span>
            <div><strong>{entry.state}</strong><small>{formatTimestamp(entry.at)} UTC</small></div>
            <code>{shortHash(entry.reference)}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}

function WalletRiskProbe({
  telemetry,
  onUseRequest,
  onClearRequest,
}: {
  telemetry: SystemTelemetry | null;
  onUseRequest: (request: JobRequest, observation: CurrentMarketplaceObservation) => void;
  onClearRequest: () => void;
}) {
  const [account, setAccount] = useState("");
  const [probe, setProbe] = useState<VenusAccountProbe | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [safeExample, setSafeExample] = useState(false);
  const activeProbeController = useRef<AbortController | null>(null);
  const probeOperation = useRef(0);
  const validAccount = EVM_ACCOUNT_PATTERN.test(account.trim());

  useEffect(() => () => {
    probeOperation.current += 1;
    activeProbeController.current?.abort();
  }, []);

  async function inspect(address: string, mode: "ACCOUNT" | "SAFE_REFUSAL") {
    const requestedAccount = address.trim();
    if (!EVM_ACCOUNT_PATTERN.test(requestedAccount)) {
      setError("Enter a 0x-prefixed address with exactly 40 hexadecimal characters");
      return;
    }
    activeProbeController.current?.abort();
    const controller = new AbortController();
    const operation = ++probeOperation.current;
    activeProbeController.current = controller;
    onClearRequest();
    setLoading(true);
    setError(null);
    setProbe(null);
    setSafeExample(mode === "SAFE_REFUSAL");
    if (mode === "SAFE_REFUSAL") setAccount(SAFE_REFUSAL_ACCOUNT);
    try {
      const response = await fetchWithTimeout(`/api/wallets/${requestedAccount}/venus`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { details?: unknown } | null;
        throw new Error(Array.isArray(body?.details) ? String(body.details[0]) : `Wallet probe failed (${response.status})`);
      }
      const next = await response.json() as VenusAccountProbe;
      if (operation !== probeOperation.current || controller.signal.aborted) return;
      setProbe(next);
      if (next.rescueRequest) {
        const source = objectValue((next.rescueRequest.sources as unknown[] | undefined)?.[0]);
        const observedAt = String(source.observedAt ?? "");
        if (!observedAt) throw new Error("Venus probe returned incomplete block evidence");
        onUseRequest(next.rescueRequest, {
          blockNumber: next.source.blockNumber,
          observedAt,
          explorerUrl: next.source.explorerUrl,
        });
      }
    } catch (probeError) {
      if (controller.signal.aborted || operation !== probeOperation.current) return;
      setError(probeError instanceof Error ? probeError.message : "Wallet probe failed");
    } finally {
      if (operation === probeOperation.current) {
        setLoading(false);
        activeProbeController.current = null;
      }
    }
  }

  const tone = probe?.state === "LIQUID" ? "good" : probe?.state === "SHORTFALL" ? "warn" : "neutral";
  return (
    <section className="wallet-risk-probe" aria-labelledby="wallet-probe-title">
      <div className="wallet-probe-heading">
        <div><span className="section-kicker">Live BSC read</span><h3 id="wallet-probe-title">Venus account probe</h3></div>
        <span>{telemetry ? `Block ${Number(telemetry.mainnet.blockNumber).toLocaleString("en-US")}` : "RPC syncing"}</span>
      </div>
      <div className="wallet-probe-control">
        <label>
          <span className="sr-only">Venus account address</span>
          <WalletCards size={16} aria-hidden="true" />
          <input
            type="text"
            inputMode="text"
            spellCheck={false}
            autoComplete="off"
            disabled={loading}
            placeholder="0x account address"
            value={account}
            aria-invalid={Boolean(error) || (account.trim().length > 0 && !validAccount)}
            aria-describedby={error ? "wallet-probe-help wallet-probe-error" : "wallet-probe-help"}
            onChange={(event) => {
              setAccount(event.target.value);
              setProbe(null);
              setError(null);
              setSafeExample(false);
              onClearRequest();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && validAccount && !loading) void inspect(account, "ACCOUNT");
            }}
          />
        </label>
        <button type="button" onClick={() => void inspect(account, "ACCOUNT")} disabled={loading || !validAccount}>
          {loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
          {loading ? "Loading" : "Load position"}
        </button>
        <button
          className="safe-refusal-action"
          type="button"
          onClick={() => void inspect(SAFE_REFUSAL_ACCOUNT, "SAFE_REFUSAL")}
          disabled={loading}
        >
          <ShieldCheck size={15} aria-hidden="true" />
          See how safe refusal works
        </button>
      </div>
      <p className="wallet-probe-help" id="wallet-probe-help">Enter a 0x-prefixed, 40-hex-character address. No address ready? Use a fresh zero-address read to see how PositionCrew safely refuses when no lending position exists.</p>
      {loading && <p className="wallet-probe-help" role="status">Reading block-pinned Venus state. BSC provider failover can take up to 30 seconds.</p>}
      {error && <div className="wallet-probe-error" id="wallet-probe-error" role="alert"><AlertTriangle size={14} /> {error}</div>}
      {probe && (
        <div className="wallet-probe-result" aria-live="polite">
          <div className="wallet-probe-state">
            <span className={`state-label ${tone}`}>{probe.state.replaceAll("_", " ")}</span>
            <a href={probe.source.explorerUrl} target="_blank" rel="noreferrer">Block {Number(probe.source.blockNumber).toLocaleString("en-US")} <ExternalLink size={12} /></a>
          </div>
          <dl>
            <div><dt>Health factor</dt><dd>{probe.position.healthFactor ?? "No debt"}</dd></div>
            <div><dt>Collateral</dt><dd>${probe.position.collateralValueUsd}</dd></div>
            <div><dt>Debt</dt><dd>${probe.position.debtValueUsd}</dd></div>
            <div><dt>Markets</dt><dd>{probe.position.markets.length}</dd></div>
          </dl>
          <p>{probe.boundary}</p>
          {safeExample && (
            <div className="safe-refusal-status" role="status">
              <ShieldCheck size={14} aria-hidden="true" />
              <span><strong>Safe live refusal example</strong> Fresh zero-address read only. Hiring persists the expected no-position refusal; it does not rescue a position or send a transaction.</span>
            </div>
          )}
          {probe.rescueRequest
            ? <span className="wallet-probe-loaded" role="status"><CheckCircle2 size={14} aria-hidden="true" /> Current request loaded</span>
            : <p role="status">No current rescue request was returned. Reload the account before hiring.</p>}
        </div>
      )}
    </section>
  );
}

function LpPositionProbe({
  onUseRequest,
  onClearRequest,
}: {
  onUseRequest: (request: JobRequest, observation: CurrentMarketplaceObservation) => void;
  onClearRequest: () => void;
}) {
  const [tokenId, setTokenId] = useState(REFERENCE_PANCAKE_POSITION_ID);
  const [probe, setProbe] = useState<PancakePositionProbe | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validTokenId = /^[1-9][0-9]{0,77}$/.test(tokenId.trim());

  async function inspect() {
    if (!validTokenId) return;
    onClearRequest();
    setLoading(true);
    setError(null);
    setProbe(null);
    try {
      const response = await fetch(`/api/positions/pancake/${tokenId.trim()}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { details?: unknown } | null;
        throw new Error(Array.isArray(body?.details) ? String(body.details[0]) : `Position probe failed (${response.status})`);
      }
      setProbe(await response.json() as PancakePositionProbe);
    } catch (probeError) {
      setError(probeError instanceof Error ? probeError.message : "Position probe failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="wallet-risk-probe lp-position-probe" aria-labelledby="lp-position-probe-title">
      <div className="wallet-probe-heading">
        <div>
          <span className="section-kicker">Public read-only reference</span>
          <h3 id="lp-position-probe-title">PancakeSwap LP position</h3>
        </div>
        <span>V3 NFT</span>
      </div>
      <div className="wallet-probe-control">
        <label>
          <span className="sr-only">PancakeSwap position NFT ID</span>
          <ReceiptText size={16} aria-hidden="true" />
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            spellCheck={false}
            autoComplete="off"
            disabled={loading}
            value={tokenId}
            aria-invalid={Boolean(error) || !validTokenId}
            aria-describedby={error ? "lp-position-probe-error" : undefined}
            onChange={(event) => {
              setTokenId(event.target.value);
              setProbe(null);
              setError(null);
              onClearRequest();
            }}
          />
        </label>
        <button type="button" onClick={() => void inspect()} disabled={loading || !validTokenId}>
          {loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
          {loading ? "Reading" : "Inspect"}
        </button>
      </div>
      {error && <div className="wallet-probe-error" id="lp-position-probe-error" role="alert"><AlertTriangle size={14} /> {error}</div>}
      {probe && (
        <div className="wallet-probe-result" aria-live="polite">
          <div className="wallet-probe-state">
            <span className={`state-label ${probe.position.inRange ? "good" : "warn"}`}>
              {probe.position.inRange ? "IN RANGE" : "OUT OF RANGE"}
            </span>
            <a href={probe.source.positionExplorerUrl} target="_blank" rel="noreferrer">
              NFT {probe.position.tokenId} <ExternalLink size={12} />
            </a>
          </div>
          <dl>
            <div><dt>Position value</dt><dd>${Number(probe.position.positionValueUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })}</dd></div>
            <div><dt>Collectible fees</dt><dd>${Number(probe.position.uncollectedFeesUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })}</dd></div>
            <div><dt>Current tick</dt><dd>{probe.position.currentTick.toLocaleString("en-US")}</dd></div>
            <div><dt>Swap window</dt><dd>{probe.market.swapCount.toLocaleString("en-US")} / {probe.market.measurementWindowSeconds}s</dd></div>
          </dl>
          <p>{probe.boundary}</p>
          <button className="wallet-probe-use" type="button" onClick={() => onUseRequest(probe.lpRequest, {
            blockNumber: probe.source.blockNumber,
            observedAt: probe.source.blockTimestamp,
            explorerUrl: probe.source.explorerUrl,
          })}>
            Use live position <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

function GridMarketProbe({
  onUseRequest,
  onClearRequest,
}: {
  onUseRequest: (request: JobRequest, observation: CurrentMarketplaceObservation) => void;
  onClearRequest: () => void;
}) {
  const [probe, setProbe] = useState<PancakeGridProbe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function inspect(signal?: AbortSignal) {
    onClearRequest();
    setLoading(true);
    setError(null);
    setProbe(null);
    try {
      const response = await fetch("/api/markets/pancake/wbnb-usdt/grid", {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { details?: unknown } | null;
        throw new Error(Array.isArray(body?.details) ? String(body.details[0]) : `Market probe failed (${response.status})`);
      }
      const next = await response.json() as PancakeGridProbe;
      if (signal?.aborted) return;
      setProbe(next);
      onUseRequest(next.gridRequest, {
        blockNumber: next.source.blockNumber,
        observedAt: next.source.blockTimestamp,
        explorerUrl: next.source.explorerUrl,
      });
    } catch (probeError) {
      if (signal?.aborted) return;
      setError(probeError instanceof Error ? probeError.message : "Market probe failed");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void inspect(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="wallet-risk-probe grid-market-probe" aria-labelledby="grid-probe-title">
      <div className="wallet-probe-heading">
        <div><span className="section-kicker">Live BSC read</span><h3 id="grid-probe-title">PancakeSwap market probe</h3></div>
        <button type="button" onClick={() => void inspect()} disabled={loading} title="Refresh pinned market state">
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {loading ? "Reading" : "Refresh"}
        </button>
      </div>
      {error && <div className="wallet-probe-error" role="alert"><AlertTriangle size={14} /> {error}</div>}
      {probe && (
        <div className="wallet-probe-result" aria-live="polite">
          <div className="wallet-probe-state">
            <span className="state-label good">{probe.state}</span>
            <a href={probe.source.explorerUrl} target="_blank" rel="noreferrer">Block {Number(probe.source.blockNumber).toLocaleString("en-US")} <ExternalLink size={12} /></a>
          </div>
          <dl>
            <div><dt>WBNB spot</dt><dd>${Number(probe.market.spotPriceUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })}</dd></div>
            <div><dt>Active virtual liquidity</dt><dd>${Number(probe.market.activeLiquidityUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}</dd></div>
            <div><dt>Realized volatility</dt><dd>{probe.market.realizedVolatilityBps} bps</dd></div>
            <div><dt>Window</dt><dd>{(probe.market.volatilityWindowSeconds / 3_600).toFixed(1)}h</dd></div>
          </dl>
          <p>{probe.boundary}</p>
        </div>
      )}
    </section>
  );
}

function YieldMarketProbe({
  onUseRequest,
  onClearRequest,
}: {
  onUseRequest: (request: JobRequest, observation: CurrentMarketplaceObservation) => void;
  onClearRequest: () => void;
}) {
  const [probe, setProbe] = useState<VenusYieldProbe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function inspect(signal?: AbortSignal) {
    onClearRequest();
    setLoading(true);
    setError(null);
    setProbe(null);
    try {
      const response = await fetch("/api/markets/venus/stable-yields", {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { details?: unknown } | null;
        throw new Error(Array.isArray(body?.details) ? String(body.details[0]) : `Yield probe failed (${response.status})`);
      }
      const next = await response.json() as VenusYieldProbe;
      if (signal?.aborted) return;
      setProbe(next);
      onUseRequest(next.yieldRequest, {
        blockNumber: next.source.blockNumber,
        observedAt: next.source.blockTimestamp,
        explorerUrl: next.source.explorerUrl,
      });
    } catch (probeError) {
      if (signal?.aborted) return;
      setError(probeError instanceof Error ? probeError.message : "Yield probe failed");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void inspect(controller.signal);
    return () => controller.abort();
  }, []);

  const bestMarket = probe?.markets.length
    ? probe.markets.reduce((best, market) =>
        market.baseSupplyApyBps > best.baseSupplyApyBps ? market : best,
      )
    : null;

  return (
    <section className="wallet-risk-probe yield-market-probe" aria-labelledby="yield-probe-title">
      <div className="wallet-probe-heading">
        <div><span className="section-kicker">Live BSC read</span><h3 id="yield-probe-title">Venus stablecoin probe</h3></div>
        <button type="button" onClick={() => void inspect()} disabled={loading} title="Refresh pinned yield state">
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {loading ? "Reading" : "Refresh"}
        </button>
      </div>
      {error && <div className="wallet-probe-error" role="alert"><AlertTriangle size={14} /> {error}</div>}
      {probe && bestMarket && (
        <div className="wallet-probe-result" aria-live="polite">
          <div className="wallet-probe-state">
            <span className="state-label good">{probe.state}</span>
            <a href={probe.source.explorerUrl} target="_blank" rel="noreferrer">Block {Number(probe.source.blockNumber).toLocaleString("en-US")} <ExternalLink size={12} /></a>
          </div>
          <dl>
            <div><dt>Best base APY</dt><dd>{(bestMarket.baseSupplyApyBps / 100).toFixed(2)}%</dd></div>
            <div><dt>Leading market</dt><dd>{bestMarket.symbol}</dd></div>
            <div><dt>Available cash</dt><dd>${Number(bestMarket.availableLiquidityUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}</dd></div>
            <div><dt>Markets checked</dt><dd>{probe.markets.length}</dd></div>
          </dl>
          <p>{probe.boundary}</p>
        </div>
      )}
    </section>
  );
}

function MachineJson({ response }: { response: FixtureJobResponse }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const json = JSON.stringify(response.result.deliverable, null, 2);
  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json);
      setCopyError(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setCopyError("Clipboard access is unavailable. Select the JSON to copy it manually.");
    }
  }
  return (
    <div className="json-view">
      <div className="json-toolbar">
        <span><FileJson2 size={14} /> application/json</span>
        <button type="button" onClick={copyJson} title="Copy machine deliverable">
          <Clipboard size={14} aria-hidden="true" /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {copyError && <p className="json-copy-status" role="status">{copyError}</p>}
      <pre>{json}</pre>
    </div>
  );
}

export function JobWorkspace({
  provider,
  selectedService,
  fixture,
  activeJob,
  marketplaceTrace,
  loading,
  jobError,
  onRun,
  onSelectJob,
  onSelectService,
  telemetry,
  benchmarks,
  marketplaceProvenance,
  advantagePublication,
  founderAdvantagePublication,
  founderAdvantageAtAGlance,
  founderAdvantageAtAGlanceLoadState,
  advantagePublicationLoadState,
  founderAdvantagePublicationLoadState,
  forwardShadowLedger,
}: {
  provider: ProviderListing | undefined;
  selectedService: ServiceId;
  fixture: FixtureJobResponse | undefined;
  activeJob: SessionJob | null;
  marketplaceTrace: FreshMarketplaceChain | null;
  loading: boolean;
  jobError: string | null;
  onRun: (
    request: Record<string, unknown>,
    mode: JobRequestMode,
    observation?: CurrentMarketplaceObservation,
  ) => Promise<void>;
  onSelectJob: (job: SessionJob) => void;
  onSelectService: (service: ServiceId) => void;
  telemetry: SystemTelemetry | null;
  benchmarks: BenchmarkRepeatabilityResponse[];
  marketplaceProvenance: MarketplaceInvocationEvidence | null;
  advantagePublication: AgentAdvantagePublicationStatus | null;
  founderAdvantagePublication: FounderAgentAdvantagePublicationStatus | null;
  founderAdvantageAtAGlance: FounderAgentAdvantageAtAGlance | null;
  founderAdvantageAtAGlanceLoadState: FounderAgentAdvantageAtAGlanceLoadState;
  advantagePublicationLoadState: PublicationLoadState;
  founderAdvantagePublicationLoadState: PublicationLoadState;
  forwardShadowLedger: BoundedGridForwardShadowLedger | null;
}) {
  const service = selectedService;
  const task = TASKS.find((candidate) => candidate.id === service) ?? TASKS[0];
  const [draft, setDraft] = useState<JobDraft>(EMPTY_DRAFT);
  const [resultView, setResultView] = useState<ResultView>("summary");
  const [inputMode, setInputMode] = useState<WorkspaceInputMode>("interactive");
  const [liveRequest, setLiveRequest] = useState<JobRequest | null>(null);
  const [liveObservation, setLiveObservation] = useState<CurrentMarketplaceObservation | null>(null);
  const liveRequestRef = useRef<JobRequest | null>(null);
  const selectedServiceRef = useRef(service);
  const resultPanelRef = useRef<HTMLDivElement | null>(null);
  const focusedJobId = useRef<string | null>(null);
  selectedServiceRef.current = service;
  const shownResponse = activeJob?.response ?? null;
  const receiptTrace = activeJob?.marketplaceTrace ?? marketplaceTrace;
  const matchedForwardShadowWindow = service === "BOUNDED_GRID" &&
    receiptTrace?.hire.service === "BOUNDED_GRID" &&
    receiptTrace.hire.evidenceMode === "CURRENT_BLOCK_PINNED" &&
    receiptTrace.job.status === "COMPLETED"
    ? forwardShadowLedger?.recentWindows.find(
        (window) =>
          window.sourceHireId === receiptTrace.hire.hireId &&
          window.sourceRequestHash === receiptTrace.hire.requestHash,
      ) ?? null
    : null;
  const fixtureRequest = fixture?.result.request;
  const inputRequest = inputMode === "locked"
    ? fixtureRequest
    : liveRequest ?? undefined;
  const liveSourceId = String(
    objectValue((liveRequest?.sources as unknown[] | undefined)?.[0]).sourceId ?? "",
  );
  const liveBlockNumber = liveObservation?.blockNumber ?? liveSourceId.match(/-block-(\d+)/)?.[1] ?? "";
  const safeLiveRefusal = service === "LENDING_RESCUE" &&
    String(objectValue(liveRequest).account ?? "").toLowerCase() === SAFE_REFUSAL_ACCOUNT;
  const liveSourceLabel = liveSourceId.startsWith("pancake-position-mainnet-block-")
    ? "PancakeSwap position"
    : liveSourceId.startsWith("pancake-v3-mainnet-block-")
    ? "PancakeSwap market"
    : liveSourceId.startsWith("venus-yield-mainnet-block-")
      ? "Venus yield market"
      : "Venus position";
  const lpPositionContext = inputRequest?.service === "LP_REBALANCE"
    ? objectValue(inputRequest.position)
    : {};
  const lpPositionValue = Number(lpPositionContext.positionValueUsd ?? 0);

  useEffect(() => {
    setResultView("summary");
    setInputMode("interactive");
    liveRequestRef.current = null;
    setLiveRequest(null);
    setLiveObservation(null);
    setDraft(draftFromRequest(fixtureRequest));
  }, [service]);

  useEffect(() => {
    if (!liveRequestRef.current) setDraft(draftFromRequest(fixtureRequest));
  }, [fixtureRequest]);

  useEffect(() => {
    const nextJobId = activeJob?.response.result.job.jobId ?? null;
    if (!nextJobId || focusedJobId.current === nextJobId) return;
    focusedJobId.current = nextJobId;
    setResultView("summary");
    window.requestAnimationFrame(() => resultPanelRef.current?.focus());
  }, [activeJob]);

  const draftRequest = useMemo(
    () => inputRequest ? applyDraft(inputRequest, draft, Boolean(liveRequest)) : null,
    [inputRequest, draft, liveRequest],
  );
  const customRequest = useMemo(
    () => inputMode === "interactive" && Boolean(inputRequest && draftRequest && JSON.stringify(inputRequest) !== JSON.stringify(draftRequest)),
    [inputMode, inputRequest, draftRequest],
  );
  const currentHireReady = inputMode === "interactive" && Boolean(
    provider &&
    liveRequest &&
    liveObservation?.blockNumber.trim() &&
    liveObservation.observedAt.trim() &&
    liveObservation.explorerUrl.trim(),
  );
  const historicalHireReady = inputMode === "locked" && service !== "YIELD_OPTIMIZATION" && Boolean(fixture);
  const liveMarketPending = inputMode === "interactive" && !currentHireReady;
  const inputsDisabled = loading || inputMode === "locked" || !currentHireReady || service === "LENDING_RESCUE";
  const draftErrors = useMemo(() => draftValidationErrors(service, draft), [service, draft]);

  function updateDraft<K extends keyof JobDraft>(key: K, value: JobDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submitJob() {
    if (loading || draftErrors.length > 0) return;
    if (!inputRequest || !draftRequest) return;
    if (inputMode === "interactive" && (!liveRequest || !liveObservation)) return;
    if (inputMode === "locked" && !historicalHireReady) return;
    const next = inputMode === "locked"
      ? structuredClone(inputRequest)
      : service === "LENDING_RESCUE"
        ? structuredClone(liveRequest!)
        : structuredClone(draftRequest);
    const mode: JobRequestMode = inputMode === "locked"
      ? "FROZEN_FIXTURE"
      : "CALLER_SUPPLIED_OBSERVATIONS";
    await onRun(
      next as Record<string, unknown>,
      mode,
      inputMode === "interactive" ? liveObservation ?? undefined : undefined,
    );
  }

  function selectInputMode(mode: WorkspaceInputMode) {
    if (mode === "locked" && service === "YIELD_OPTIMIZATION") return;
    setInputMode(mode);
    const selectedRequest = mode === "locked"
      ? fixtureRequest
      : liveRequest ?? undefined;
    setDraft(draftFromRequest(selectedRequest));
    setResultView("summary");
  }

  function useLiveRequest(request: JobRequest, observation: CurrentMarketplaceObservation) {
    if (request.service !== selectedServiceRef.current) return;
    const next = structuredClone(request);
    liveRequestRef.current = next;
    setLiveRequest(next);
    setLiveObservation(observation);
    setInputMode("interactive");
    setDraft(draftFromRequest(request));
    setResultView("summary");
  }

  function clearLiveRequest() {
    liveRequestRef.current = null;
    setLiveRequest(null);
    setLiveObservation(null);
    if (inputMode === "interactive") setDraft(draftFromRequest(undefined));
    setResultView("summary");
  }

  function handleResultTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const tabs: ResultView[] = ["summary", "json", "receipt"];
    const currentIndex = tabs.indexOf(resultView);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[nextIndex];
    setResultView(next);
    window.requestAnimationFrame(() => document.getElementById(`result-tab-${next}`)?.focus());
  }

  return (
    <main className="page-shell jobs-page">
      <div className="page-title-row compact">
        <div>
          <span className="page-kicker">Current capital check</span>
          <h1>Get a bounded answer with evidence you can inspect.</h1>
          <p>{service === "LENDING_RESCUE"
            ? "Load one current Venus position, let PositionCrew check exact-contract eligibility, and receive a persisted rescue plan or explicit refusal."
            : "Choose a specialist, load current BSC evidence, and receive either a clear action or a provable refusal with a durable receipt. Historical examples remain separate."}</p>
        </div>
        <label className="provider-select">
          <span>Job</span>
          <select value={service} disabled={loading} onChange={(event) => onSelectService(event.target.value as ServiceId)}>
            {TASKS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.shortTitle}</option>)}
          </select>
        </label>
      </div>

      <div className="job-layout">
        <section className="job-composer" aria-labelledby="composer-title" aria-busy={loading}>
          <div className="section-bar">
            <div><span className="section-kicker">Request</span><h2 id="composer-title">{service === "LENDING_RESCUE" ? "Lending provider eligibility" : provider?.name ?? task.title}</h2></div>
            <div className="composer-mode-actions">
              {service === "LENDING_RESCUE" ? (
                <a className="historical-evidence-link" href="#evidence">Past benchmark receipts · not a current check <ArrowRight size={12} aria-hidden="true" /></a>
              ) : (
                <div className="input-mode-switch" role="group" aria-label="Request evidence mode">
                  <button type="button" aria-pressed={inputMode === "interactive"} onClick={() => selectInputMode("interactive")} disabled={loading}>Current BSC</button>
                  {service !== "YIELD_OPTIMIZATION" && (
                    <button type="button" aria-pressed={inputMode === "locked"} onClick={() => selectInputMode("locked")} disabled={loading}>Historical example</button>
                  )}
                </div>
              )}
              {customRequest && (
                <button type="button" onClick={() => setDraft(draftFromRequest(inputRequest))} disabled={loading} title="Reset interactive bounds">
                  <RefreshCw size={13} aria-hidden="true" /> Reset
                </button>
              )}
            </div>
          </div>
          <p className="composer-summary">{service === "LENDING_RESCUE"
            ? "PositionCrew admits only a provider with an exact Lending request adapter and output validator, then persists that provider's bounded result."
            : provider?.summary ?? task.description}</p>
          {service === "LENDING_RESCUE" ? (
            <>
              <WalletRiskProbe telemetry={telemetry} onUseRequest={useLiveRequest} onClearRequest={clearLiveRequest} />
              {liveRequest && !safeLiveRefusal && (
                <>
                  <LendingPositionBar request={draftRequest} />
                  <div className="form-grid">
                    <NumberField label="Target health factor" value={draft.targetHealth} onChange={(value) => updateDraft("targetHealth", value)} disabled={inputsDisabled} min="1.01" max="3" step="0.01" />
                    <NumberField label="Maximum action (USD)" value={draft.maxAction} onChange={(value) => updateDraft("maxAction", value)} disabled={inputsDisabled} min="1" max="10000" step="1" />
                    <NumberField label="Stress price drop (bps)" value={draft.stressDrop} onChange={(value) => updateDraft("stressDrop", value)} disabled={inputsDisabled} min="0" max="5000" step="100" />
                    <NumberField label="Maximum slippage (bps)" value={draft.maxSlippage} onChange={(value) => updateDraft("maxSlippage", value)} disabled={inputsDisabled} min="0" max="2000" step="1" />
                  </div>
                  <fieldset className="action-options">
                    <legend>Allowed actions</legend>
                    <label><input disabled={inputsDisabled} type="checkbox" checked={draft.allowRepay} onChange={(event) => updateDraft("allowRepay", event.target.checked)} /> Repay debt</label>
                    <label><input disabled={inputsDisabled} type="checkbox" checked={draft.allowCollateral} onChange={(event) => updateDraft("allowCollateral", event.target.checked)} /> Add collateral</label>
                  </fieldset>
                </>
              )}
            </>
          ) : service === "LP_REBALANCE" ? (
            <>
              <LpPositionProbe onUseRequest={useLiveRequest} onClearRequest={clearLiveRequest} />
              <div className="request-context">
                <span>PancakeSwap V3</span>
                <strong>Range {String(lpPositionContext.lowerTick ?? "-")} to {String(lpPositionContext.upperTick ?? "-")}</strong>
                <small>{Number.isFinite(lpPositionValue) && lpPositionValue > 0
                  ? `$${lpPositionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })} position`
                  : "Position value unavailable"}</small>
              </div>
              <div className="form-grid">
                <NumberField label="Current tick" value={draft.lpCurrentTick} onChange={(value) => updateDraft("lpCurrentTick", value)} disabled={inputsDisabled || Boolean(liveRequest)} min="-887272" max="887272" step="1" />
                <NumberField label="Minimum net benefit (USD)" value={draft.lpMinimumBenefit} onChange={(value) => updateDraft("lpMinimumBenefit", value)} disabled={inputsDisabled} min="0" max="100000" step="0.01" />
                <NumberField label="Estimated gas (USD)" value={draft.lpGas} onChange={(value) => updateDraft("lpGas", value)} disabled={inputsDisabled} min="0" max="10000" step="0.01" />
                <NumberField label="Estimated swap cost (USD)" value={draft.lpSwapCost} onChange={(value) => updateDraft("lpSwapCost", value)} disabled={inputsDisabled} min="0" max="10000" step="0.01" />
                <NumberField label="Evaluation horizon (hours)" value={draft.lpHorizon} onChange={(value) => updateDraft("lpHorizon", value)} disabled={inputsDisabled} min="1" max="720" step="1" />
                <NumberField label="Maximum gas (USD)" value={draft.lpMaximumGas} onChange={(value) => updateDraft("lpMaximumGas", value)} disabled={inputsDisabled} min="0" max="10000" step="0.01" />
              </div>
            </>
          ) : service === "YIELD_OPTIMIZATION" ? (
            <>
              <YieldMarketProbe onUseRequest={useLiveRequest} onClearRequest={clearLiveRequest} />
              <div className="request-context"><span>Venus stablecoin markets</span><strong>Base rates only</strong><small>No incentive assumptions</small></div>
              <div className="form-grid">
                <NumberField label="Capital (USD)" value={draft.yieldCapital} onChange={(value) => updateDraft("yieldCapital", value)} disabled={inputsDisabled} min="1" max="10000000" step="1" />
                <NumberField label="Leading base APY (bps)" value={draft.yieldCandidateApy} onChange={(value) => updateDraft("yieldCandidateApy", value)} disabled={inputsDisabled || Boolean(liveRequest)} min="0" max="1000000" step="1" />
                <NumberField label="Minimum liquidity (USD)" value={draft.yieldMinimumLiquidity} onChange={(value) => updateDraft("yieldMinimumLiquidity", value)} disabled={inputsDisabled} min="0" max="10000000000" step="1" />
                <NumberField label="Minimum net benefit (USD)" value={draft.yieldMinimumBenefit} onChange={(value) => updateDraft("yieldMinimumBenefit", value)} disabled={inputsDisabled} min="0" max="1000000" step="0.01" />
                <NumberField label="Evaluation horizon (days)" value={draft.yieldHorizon} onChange={(value) => updateDraft("yieldHorizon", value)} disabled={inputsDisabled} min="1" max="365" step="1" />
                <label><span>Maximum risk tier</span><select disabled={inputsDisabled} value={draft.yieldRisk} onChange={(event) => updateDraft("yieldRisk", event.target.value as JobDraft["yieldRisk"])}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
              </div>
            </>
          ) : (
            <>
              <GridMarketProbe onUseRequest={useLiveRequest} onClearRequest={clearLiveRequest} />
              <div className="request-context"><span>WBNB / USDT</span><strong>PancakeSwap execution policy</strong><small>Both sides required</small></div>
              <div className="form-grid dense">
                <NumberField label="Mid price" value={draft.gridMidPrice} onChange={(value) => updateDraft("gridMidPrice", value)} disabled={inputsDisabled || Boolean(liveRequest)} min="0.000001" max="10000000" step="0.01" />
                <NumberField label="Lower price" value={draft.gridLowerPrice} onChange={(value) => updateDraft("gridLowerPrice", value)} disabled={inputsDisabled} min="0.000001" max="10000000" step="0.01" />
                <NumberField label="Upper price" value={draft.gridUpperPrice} onChange={(value) => updateDraft("gridUpperPrice", value)} disabled={inputsDisabled} min="0.000001" max="10000000" step="0.01" />
                <NumberField label="Capital (USD)" value={draft.gridCapital} onChange={(value) => updateDraft("gridCapital", value)} disabled={inputsDisabled} min="1" max="10000000" step="1" />
                <NumberField label="Grid levels" value={draft.gridLevels} onChange={(value) => updateDraft("gridLevels", value)} disabled={inputsDisabled} min="2" max="100" step="1" />
                <NumberField label="Maximum inventory (USD)" value={draft.gridMaximumInventory} onChange={(value) => updateDraft("gridMaximumInventory", value)} disabled={inputsDisabled} min="1" max="10000000" step="1" />
                <NumberField label="Maximum loss (USD)" value={draft.gridMaximumLoss} onChange={(value) => updateDraft("gridMaximumLoss", value)} disabled={inputsDisabled} min="0.01" max="10000000" step="0.01" />
                <NumberField label="Minimum expected profit (USD)" value={draft.gridMinimumProfit} onChange={(value) => updateDraft("gridMinimumProfit", value)} disabled={inputsDisabled} min="0" max="10000000" step="0.01" />
                <NumberField label="Maximum volatility (bps)" value={draft.gridMaximumVolatility} onChange={(value) => updateDraft("gridMaximumVolatility", value)} disabled={inputsDisabled} min="1" max="100000" step="1" />
                <NumberField label="Expected completed cycles" value={draft.gridExpectedCycles} onChange={(value) => updateDraft("gridExpectedCycles", value)} disabled={inputsDisabled} min="1" max="1000" step="1" />
              </div>
            </>
          )}
          <div className="request-boundary" id="request-boundary">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{inputMode === "locked"
              ? "Historical August 12 fixture. The public receipt is reproducible, but the instruction is no longer executable."
              : liveRequest
                ? safeLiveRefusal
                  ? `Safe live refusal example from BSC block ${liveBlockNumber || "unknown"}. The zero address has no reconstructable Venus lending position; the exact current request and observation are persisted so the provider can return a refusal. No rescue or transaction is executed.`
                  : `Block-pinned ${liveSourceLabel} from BSC block ${liveBlockNumber || "unknown"}. The exact submitted request and pinned observation are persisted; the result is an unsigned plan or refusal, not a wallet transaction.`
              : liveMarketPending
                ? service === "LENDING_RESCUE"
                  ? "Enter a Venus account and load its current block-pinned position. Hire remains disabled until the exact request and block evidence are ready."
                  : service === "LP_REBALANCE"
                  ? "Inspect a PancakeSwap V3 position and load its current block-pinned request. Hire remains disabled until the exact request and block evidence are ready."
                  : service === "YIELD_OPTIMIZATION"
                  ? "Waiting for a block-pinned Venus market read. Current hiring stays disabled if rates, cash, oracle, token, or gas evidence is unavailable."
                  : "Waiting for a block-pinned PancakeSwap market read. Current hiring stays disabled if live price, reserve, volatility, or gas evidence is unavailable."
              : customRequest
                ? "Current-clock scenario with custom bounds. Inputs and timestamps are caller-controlled; this is not benchmark evidence or live wallet execution."
                : "Current-clock simulation seeded from the August 12 fixture. Observation timestamps are rebased for the scenario; values are not fetched live."}</span>
          </div>
          {jobError && (
            <div className="job-run-error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span><strong>This hire did not finish.</strong><small>{jobError}</small></span>
              <button type="button" onClick={() => void submitJob()} disabled={loading || draftErrors.length > 0 || (inputMode === "interactive" ? !currentHireReady : !historicalHireReady) || (service === "LENDING_RESCUE" && !draft.allowRepay && !draft.allowCollateral)}><RefreshCw size={14} aria-hidden="true" /> Retry current hire</button>
            </div>
          )}
          <LendingProviderAuditionPanel trace={marketplaceTrace} />
          {marketplaceTrace && (
            <div className="request-boundary" role="status" aria-live="polite">
              {marketplaceTrace.job.status === "COMPLETED"
                ? <CheckCircle2 size={15} aria-hidden="true" />
                : marketplaceTrace.job.status === "FAILED"
                  ? <AlertTriangle size={15} aria-hidden="true" />
                  : <LoaderCircle className="spin" size={15} aria-hidden="true" />}
              <span>
                <strong>{marketplaceTrace.job.status.replaceAll("_", " ")}</strong>
                {" · Hire "}{shortHash(marketplaceTrace.hire.hireId, 14)}
                {marketplaceTrace.receipt && <>{" · "}<a href={marketplaceTrace.receipt.publicUrl} target="_blank" rel="noreferrer">Public receipt <ExternalLink size={11} /></a></>}
              </span>
            </div>
          )}
          {matchedForwardShadowWindow && (
            <div className="shadow-evidence-link" role="status">
              <ShieldCheck size={15} aria-hidden="true" />
              <span>
                <strong>Separate forward shadow evidence</strong>
                {" · "}{matchedForwardShadowWindow.state.replaceAll("_", " ")}
                {" · "}This zero-fund sampled outcome references the same persisted hire and request hash; it is not part of the provider receipt or a transaction.
              </span>
              <a href={matchedForwardShadowWindow.receiptUrl} target="_blank" rel="noreferrer">
                Open window <ExternalLink size={11} />
              </a>
            </div>
          )}
          <div className="composer-footer">
            <span>
              <strong>$0.00</strong>
              <small>{inputMode === "interactive"
                ? safeLiveRefusal
                  ? "No wallet · no value moved · zero-position refusal persists"
                  : "No wallet · no payment · current request and result persist"
                : "No wallet · no payment · historical evidence replay"}</small>
            </span>
            <button
              className="primary-action"
              type="button"
              onClick={submitJob}
              aria-describedby="request-boundary"
              disabled={loading || draftErrors.length > 0 || (inputMode === "interactive" ? !currentHireReady : !historicalHireReady) || (service === "LENDING_RESCUE" && !draft.allowRepay && !draft.allowCollateral)}
            >
              {loading ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
              {loading
                ? (marketplaceTrace?.job.status.replaceAll("_", " ") ?? (service === "LENDING_RESCUE" ? "Checking provider eligibility" : "Recording hire"))
                : inputMode === "interactive"
                  ? service === "LENDING_RESCUE"
                    ? safeLiveRefusal
                      ? "Check eligibility and persist refusal"
                      : "Check eligibility and hire"
                    : "Hire and run current request"
                  : "Replay historical receipt"}
              {!loading && <ArrowRight size={15} />}
            </button>
          </div>
        </section>

        <section className="job-result" aria-label="Provider result">
          <span className="sr-only" role="status" aria-live="polite">{loading ? "Provider job in progress." : shownResponse ? `${serviceLabel(shownResponse.result.deliverable.service)} result ready.` : "Ready for a provider request."}</span>
          <div className="result-nav">
            <div role="tablist" aria-label="Provider result views" onKeyDown={handleResultTabKeyDown}>
              <button id="result-tab-summary" role="tab" aria-selected={resultView === "summary"} aria-controls="result-panel" tabIndex={resultView === "summary" ? 0 : -1} className={resultView === "summary" ? "active" : ""} type="button" onClick={() => setResultView("summary")}><ShieldCheck size={14} aria-hidden="true" /> Result</button>
              <button id="result-tab-json" role="tab" aria-selected={resultView === "json"} aria-controls="result-panel" tabIndex={resultView === "json" ? 0 : -1} className={resultView === "json" ? "active" : ""} type="button" onClick={() => setResultView("json")}><Code2 size={14} aria-hidden="true" /> JSON</button>
              <button id="result-tab-receipt" role="tab" aria-selected={resultView === "receipt"} aria-controls="result-panel" tabIndex={resultView === "receipt" ? 0 : -1} className={resultView === "receipt" ? "active" : ""} type="button" onClick={() => setResultView("receipt")}><ReceiptText size={14} aria-hidden="true" /> Receipt</button>
            </div>
            {activeJob && <span>{activeJob.responseTimeMs} ms API</span>}
          </div>
          <div id="result-panel" className="result-panel" role="tabpanel" aria-labelledby={`result-tab-${resultView}`} tabIndex={-1} ref={resultPanelRef}>
          {shownResponse ? (
            resultView === "summary" ? (
              <SummaryResult
                response={shownResponse}
                benchmarks={benchmarks}
          marketplaceProvenance={marketplaceProvenance}
          advantagePublication={advantagePublication}
                founderAdvantagePublication={founderAdvantagePublication}
                founderAdvantageAtAGlance={founderAdvantageAtAGlance}
                founderAdvantageAtAGlanceLoadState={founderAdvantageAtAGlanceLoadState}
          advantagePublicationLoadState={advantagePublicationLoadState}
          founderAdvantagePublicationLoadState={founderAdvantagePublicationLoadState}
              />
            ) :
              resultView === "json" ? <MachineJson response={shownResponse} /> :
                <ReceiptView response={shownResponse} marketplaceTrace={receiptTrace} shadowWindow={matchedForwardShadowWindow} />
          ) : (
            <div className="empty-result-state">
              <span className="empty-result-icon"><ShieldCheck size={28} strokeWidth={1.6} /></span>
              <span className="empty-result-kicker">READY FOR REQUEST</span>
              <h2>Your bounded action will appear here.</h2>
              <p>Load current block-pinned evidence, then one no-wallet hire produces a persisted plan or refusal and durable receipt.</p>
              <div className="empty-result-flow" aria-hidden="true">
                <span><b>01</b> Request</span><ArrowRight size={14} /><span><b>02</b> Evaluate</span><ArrowRight size={14} /><span><b>03</b> Receipt</span>
              </div>
            </div>
          )}
          </div>
        </section>
      </div>
      <RecentJobsPanel onOpenJob={onSelectJob} />
    </main>
  );
}
