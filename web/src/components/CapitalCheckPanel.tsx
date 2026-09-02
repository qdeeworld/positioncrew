import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Layers3,
  LoaderCircle,
  Radar,
  RefreshCw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { clearCapitalCheckSeed, saveCapitalCheckSeed } from "../capital-check";
import { TASKS } from "../task-config";
import type { ServiceId } from "../types";

const EVM_ACCOUNT_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ID_PATTERN = /^[1-9][0-9]{0,77}$/;

type ScanTone = "urgent" | "watch" | "ready" | "clear" | "input" | "unavailable";

interface ScanCard {
  service: ServiceId;
  tone: ScanTone;
  state: string;
  title: string;
  detail: string;
  metric: string;
  metricLabel: string;
  blockNumber?: string;
  explorerUrl?: string;
}

interface ProviderRoute {
  providers: string;
  status: string;
  detail: string;
  action: string;
  outcome: string;
}

const PROVIDER_ROUTES: Record<ServiceId, ProviderRoute> = {
  LENDING_RESCUE: {
    providers: "PositionCrew Rescue + AiKi Venus Guardian",
    status: "1 rescue provider · 1 monitoring cross-check",
    detail: "Both inspect the same account. Only PositionCrew currently returns the bounded rescue contract; AiKi independently checks the risk diagnosis.",
    action: "Check providers and hire",
    outcome: "Check whether this position needs a rescue and preserve the decision.",
  },
  LP_REBALANCE: {
    providers: "PositionCrew LP + V3 Pools powered by HeyAnon",
    status: "Two-provider exact-job audition",
    detail: "Both providers receive the same current LP position. PositionCrew normalizes the external range and applies your unchanged limits before selection.",
    action: "Compare providers for this job",
    outcome: "Compare two range plans and admit only one that stays inside your limits.",
  },
  YIELD_OPTIMIZATION: {
    providers: "PositionCrew Yield + AiKi Venus Yield",
    status: "Two-provider exact-job audition",
    detail: "Both providers inspect the same current Venus markets. Rate evidence, liquidity, costs, risk limits, and horizon decide eligibility.",
    action: "Compare providers for this job",
    outcome: "Compare current yield plans after costs, liquidity, and concentration limits.",
  },
  BOUNDED_GRID: {
    providers: "PositionCrew Grid + Brain on BNB Grid Planner",
    status: "Two-provider exact-job audition",
    detail: "Both providers evaluate the same live pool. The external range is admitted only when it passes the buyer's economics and loss limits.",
    action: "Compare providers for this job",
    outcome: "Compare grid plans and reject any range that breaks your loss or cost caps.",
  },
};

interface VenusScan {
  state: string;
  source: { blockNumber: string; explorerUrl: string };
  position: {
    healthFactor: string | null;
    collateralValueUsd: string;
    debtValueUsd: string;
    markets: unknown[];
  };
  rescueRequest?: unknown;
}

interface YieldScan {
  source: { blockNumber: string; explorerUrl: string };
  markets: Array<{ symbol: string; baseSupplyApyBps: number; availableLiquidityUsd: string }>;
}

interface GridScan {
  state: string;
  source: { blockNumber: string; explorerUrl: string };
  market: { spotPriceUsd: string; realizedVolatilityBps: number };
}

interface LpScan {
  source: { blockNumber: string; explorerUrl: string; positionExplorerUrl: string };
  position: { tokenId: string; inRange: boolean; positionValueUsd: string; uncollectedFeesUsd: string };
}

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort();
  const timeout = window.setTimeout(abortRequest, 12_000);
  signal.addEventListener("abort", abortRequest, { once: true });
  try {
    const response = await fetch(path, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: requestController.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { details?: unknown } | null;
      const detail = Array.isArray(body?.details) ? String(body.details[0]) : `HTTP ${response.status}`;
      throw new Error(detail);
    }
    return response.json() as Promise<T>;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abortRequest);
  }
}

function failedCard(service: ServiceId): ScanCard {
  return {
    service,
    tone: "unavailable",
    state: "UNAVAILABLE",
    title: "Current read unavailable",
    detail: "PositionCrew did not infer a result. Retry this capital check before opening a current job.",
    metric: "-",
    metricLabel: "No current evidence",
  };
}

export function CapitalCheckPanel({ onOpenJob }: { onOpenJob: (service: ServiceId) => void }) {
  const [account, setAccount] = useState("");
  const [positionId, setPositionId] = useState("");
  const [scanning, setScanning] = useState(false);
  const [cards, setCards] = useState<ScanCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const validAccount = EVM_ACCOUNT_PATTERN.test(account.trim());
  const validPositionId = positionId.trim() === "" || TOKEN_ID_PATTERN.test(positionId.trim());

  useEffect(() => () => controllerRef.current?.abort(), []);

  function cancelScan() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    clearCapitalCheckSeed();
    setScanning(false);
  }

  async function scanCapital() {
    if (!validAccount || !validPositionId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setScanning(true);
    setError(null);
    setCards(null);
    const wallet = account.trim();
    const nft = positionId.trim();
    try {
      const [venusResult, yieldResult, gridResult, lpResult] = await Promise.allSettled([
        fetchJson<VenusScan>(`/api/wallets/${encodeURIComponent(wallet)}/venus`, controller.signal),
        fetchJson<YieldScan>("/api/markets/venus/stable-yields", controller.signal),
        fetchJson<GridScan>("/api/markets/pancake/wbnb-usdt/grid", controller.signal),
        nft
          ? fetchJson<LpScan>(`/api/positions/pancake/${encodeURIComponent(nft)}`, controller.signal)
          : Promise.resolve(null),
      ]);
      if (controller.signal.aborted) return;

      const nextCards: ScanCard[] = [];
      if (venusResult.status === "fulfilled") {
        const probe = venusResult.value;
        const debt = Number(probe.position.debtValueUsd);
        const collateral = Number(probe.position.collateralValueUsd);
        const urgent = probe.state === "SHORTFALL";
        const hasPosition = debt > 0 && collateral > 0;
        nextCards.push({
          service: "LENDING_RESCUE",
          tone: urgent ? "urgent" : hasPosition ? "watch" : "clear",
          state: urgent ? "NEEDS ATTENTION" : hasPosition ? "POSITION FOUND" : "NO LOAN FOUND",
          title: urgent ? "Review a bounded rescue" : hasPosition ? "Check whether intervention is justified" : "No Venus rescue position detected",
          detail: urgent
            ? "The current Venus snapshot reports shortfall. Open the job to calculate the smallest permitted response."
            : hasPosition
              ? `PositionCrew found $${collateral.toLocaleString("en-US", { maximumFractionDigits: 0 })} collateral and $${debt.toLocaleString("en-US", { maximumFractionDigits: 0 })} debt.`
              : "You can still open the job to preserve an explicit no-position refusal.",
          metric: probe.position.healthFactor ?? "No debt",
          metricLabel: "Health factor",
          blockNumber: probe.source.blockNumber,
          explorerUrl: probe.source.explorerUrl,
        });
      } else nextCards.push(failedCard("LENDING_RESCUE"));

      if (lpResult.status === "fulfilled" && lpResult.value) {
        const probe = lpResult.value;
        nextCards.push({
          service: "LP_REBALANCE",
          tone: probe.position.inRange ? "clear" : "urgent",
          state: probe.position.inRange ? "IN RANGE" : "OUT OF RANGE",
          title: probe.position.inRange ? "Position is inside its current range" : "Rebalance review available",
          detail: `NFT ${probe.position.tokenId} currently represents $${Number(probe.position.positionValueUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}. PositionCrew will preserve a bounded action or no-action decision.`,
          metric: `$${Number(probe.position.uncollectedFeesUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
          metricLabel: "Collectible fees",
          blockNumber: probe.source.blockNumber,
          explorerUrl: probe.source.positionExplorerUrl,
        });
      } else if (!nft) {
        nextCards.push({
          service: "LP_REBALANCE",
          tone: "input",
          state: "NFT ID NEEDED",
          title: "Add a PancakeSwap V3 position ID",
          detail: "A wallet address alone cannot prove which V3 NFT to evaluate. Add the position ID and scan again.",
          metric: "Optional",
          metricLabel: "Additional input",
        });
      } else nextCards.push(failedCard("LP_REBALANCE"));

      if (yieldResult.status === "fulfilled" && yieldResult.value.markets.length) {
        const probe = yieldResult.value;
        const best = probe.markets.reduce((current, market) => market.baseSupplyApyBps > current.baseSupplyApyBps ? market : current);
        nextCards.push({
          service: "YIELD_OPTIMIZATION",
          tone: "ready",
          state: "MARKET CHECK READY",
          title: `${best.symbol} leads the current measured base rate`,
          detail: "This is a market opportunity scan, not a claim that the entered wallet owns these assets. Open the job to apply capital and concentration limits.",
          metric: `${(best.baseSupplyApyBps / 100).toFixed(2)}%`,
          metricLabel: "Best base APY",
          blockNumber: probe.source.blockNumber,
          explorerUrl: probe.source.explorerUrl,
        });
      } else nextCards.push(failedCard("YIELD_OPTIMIZATION"));

      if (gridResult.status === "fulfilled") {
        const probe = gridResult.value;
        nextCards.push({
          service: "BOUNDED_GRID",
          tone: "ready",
          state: "MARKET CHECK READY",
          title: "Current WBNB/USDT grid conditions loaded",
          detail: "This is market eligibility, not an open wallet position or an order. Open the job to test bounded inventory, loss, and execution constraints.",
          metric: `${probe.market.realizedVolatilityBps} bps`,
          metricLabel: "Realized volatility",
          blockNumber: probe.source.blockNumber,
          explorerUrl: probe.source.explorerUrl,
        });
      } else nextCards.push(failedCard("BOUNDED_GRID"));

      saveCapitalCheckSeed({
        account: wallet,
        checkedAt: new Date().toISOString(),
        ...(nft ? { pancakePositionId: nft } : {}),
      });
      setCards(nextCards);
    } catch (scanError) {
      if (controller.signal.aborted) return;
      setError(scanError instanceof Error ? scanError.message : "Capital check failed");
    } finally {
      if (!controller.signal.aborted) {
        setScanning(false);
        controllerRef.current = null;
      }
    }
  }

  const readyCount = cards?.filter((card) => card.tone !== "unavailable" && card.tone !== "input").length ?? 0;

  return (
    <section className="capital-check" id="capital-check" aria-labelledby="capital-check-title">
      <div className="capital-check-intro">
        <span className="page-kicker">Position first · provider second</span>
        <h2 id="capital-check-title">Find the job. Then prove who can handle it.</h2>
        <p>Enter a public address once. PositionCrew finds what needs attention, checks which agents can handle the exact job, and preserves the result. Nothing is signed or moved.</p>
        <div className="capital-check-trust"><ShieldCheck size={15} aria-hidden="true" /> Public reads only · no wallet connection · no transaction</div>
      </div>

      <form className="capital-check-form" onSubmit={(event) => { event.preventDefault(); void scanCapital(); }}>
        <label>
          <span>BSC wallet address</span>
          <div><WalletCards size={17} aria-hidden="true" /><input value={account} onChange={(event) => { cancelScan(); setAccount(event.target.value); setCards(null); setError(null); }} placeholder="0x..." spellCheck={false} autoComplete="off" aria-invalid={account.length > 0 && !validAccount} /></div>
          <small>Used for the block-pinned Venus account read.</small>
        </label>
        <label>
          <span>PancakeSwap V3 NFT ID <em>optional</em></span>
          <div><Layers3 size={17} aria-hidden="true" /><input value={positionId} onChange={(event) => { cancelScan(); setPositionId(event.target.value); setCards(null); setError(null); }} placeholder="Position token ID" inputMode="numeric" pattern="[0-9]*" aria-invalid={!validPositionId} /></div>
          <small>Required only to inspect a specific LP position.</small>
        </label>
        <button type="submit" disabled={scanning || !validAccount || !validPositionId}>
          {scanning ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : cards ? <RefreshCw size={17} aria-hidden="true" /> : <Radar size={17} aria-hidden="true" />}
          {scanning ? "Checking current BSC state" : cards ? "Refresh capital check" : "Check my BSC capital"}
        </button>
        <button type="button" onClick={() => onOpenJob("LENDING_RESCUE")}>
          Open Lending Rescue directly <ArrowRight size={17} aria-hidden="true" />
        </button>
      </form>

      {error && <div className="capital-check-error" role="alert"><AlertTriangle size={15} aria-hidden="true" /> {error}</div>}
      {scanning && <div className="capital-check-progress" role="status"><span /><p><strong>Reading current BSC state</strong>Venus account, stable-yield markets, PancakeSwap market{positionId.trim() ? ", and the supplied LP NFT" : ""}.</p></div>}
      {cards && (
        <div className="capital-check-results" aria-live="polite">
          <div className="capital-check-results-head"><div>{readyCount > 0 ? <CheckCircle2 size={17} aria-hidden="true" /> : <AlertTriangle size={17} aria-hidden="true" />}<span><strong>{readyCount > 0 ? "Your capital desk is ready." : "No current jobs could be determined."}</strong><small>{readyCount > 0 ? "Review the available position or market evidence, then open a routable job to check providers." : "Every current read failed or returned no routable input. Retry before choosing a provider."}</small></span></div><span>{readyCount}/4 ready</span></div>
          {readyCount > 0 && (
            <ol className="capital-check-journey" aria-label="What happens after this capital scan">
              <li data-state="complete"><span>1</span><strong>Current state loaded</strong><small>Position or market evidence</small></li>
              <li data-state="upcoming"><span>2</span><strong>Check providers next</strong><small>After you open a job</small></li>
              <li data-state="upcoming"><span>3</span><strong>Preserve the result</strong><small>After a provider runs</small></li>
            </ol>
          )}
          <div className="capital-check-grid">
            {cards.map((card) => {
              const task = TASKS.find((candidate) => candidate.id === card.service);
              const Icon = task?.icon;
              const canOpen = card.tone !== "unavailable" && card.tone !== "input";
              const route = PROVIDER_ROUTES[card.service];
              return (
                <article className={`capital-check-card tone-${card.tone}`} key={card.service}>
                  <div className="capital-check-card-head"><span>{Icon && <Icon size={18} aria-hidden="true" />}</span><div><small>{task?.shortTitle}</small><strong>{card.state}</strong></div></div>
                  <h3>{card.title}</h3>
                  <p>{card.detail}</p>
                  <div className="capital-check-metric"><span>{card.metricLabel}</span><strong>{card.metric}</strong></div>
                  {canOpen ? (
                    <>
                      <div className="capital-check-next-step">
                        <span>What happens next</span>
                        <strong>{route.outcome}</strong>
                      </div>
                      <details className="capital-check-provider-proof">
                        <summary><ShieldCheck size={13} aria-hidden="true" /> How providers are checked</summary>
                        <div>
                          <strong>{route.status}</strong>
                          <b>{route.providers}</b>
                          <small>{route.detail}</small>
                        </div>
                      </details>
                    </>
                  ) : (
                    <div className="capital-check-next-step prerequisite">
                      <span>Required before provider check</span>
                      <strong>{card.tone === "input" ? "Add the PancakeSwap V3 NFT ID, then scan again." : "Retry this capital check before choosing a provider."}</strong>
                    </div>
                  )}
                  <div className="capital-check-card-foot">
                    {card.blockNumber && card.explorerUrl ? <a href={card.explorerUrl} target="_blank" rel="noreferrer">Block {Number(card.blockNumber).toLocaleString("en-US")} <ExternalLink size={11} aria-hidden="true" /></a> : <span>Current evidence required</span>}
                    {canOpen ? <button type="button" onClick={() => onOpenJob(card.service)}>{route.action} <ArrowRight size={13} aria-hidden="true" /></button> : card.tone === "input" ? <button type="button" onClick={() => document.querySelector<HTMLInputElement>(".capital-check-form input[inputmode='numeric']")?.focus()}>Add NFT ID</button> : <button type="button" onClick={() => void scanCapital()}>Retry</button>}
                  </div>
                </article>
              );
            })}
          </div>
          <p className="capital-check-boundary">Provider names describe implemented audition routes, not guaranteed availability or superiority. The hire performs current liveness and exact-contract checks, preserves every rejection, and may return no action or refusal. No wallet ownership, balance entitlement, trade, yield, or performance is inferred.</p>
        </div>
      )}
    </section>
  );
}
