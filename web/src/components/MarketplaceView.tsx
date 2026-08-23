import { useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  CheckCircle2,
  Code2,
  Database,
  ExternalLink,
  Radio,
  Search,
  Server,
  ShieldCheck,
} from "lucide-react";
import { TASKS } from "../task-config";
import { serviceLabel, shortHash } from "../presentation";
import type { FixtureJobResponse, ProviderListing, ServiceId, SystemTelemetry } from "../types";

export function MarketplaceView({
  providers,
  matrix,
  selectedService,
  onSelect,
  onCreateJob,
  telemetry,
}: {
  providers: ProviderListing[];
  matrix: Map<ServiceId, FixtureJobResponse>;
  selectedService: ServiceId;
  onSelect: (service: ServiceId) => void;
  onCreateJob: (service: ServiceId) => void;
  telemetry: SystemTelemetry | null;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return providers;
    return providers.filter((provider) =>
      [provider.name, provider.category, provider.summary, provider.service]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [providers, query]);
  const selected = providers.find((provider) => provider.service === selectedService);
  const selectedResult = matrix.get(selectedService);
  const selectedTask = TASKS.find((task) => task.id === selectedService);
  const SelectedIcon = selectedTask?.icon;
  const catalogLoading = providers.length === 0;
  const selectedIsCurrentLending = selectedService === "LENDING_RESCUE";
  const selectedIsSimulation = selectedService === "YIELD_OPTIMIZATION";

  return (
    <main className="marketplace-page">
      <section className="market-intro-band">
        <div className="market-intro-inner">
          <div className="market-intro-copy">
            <span className="page-kicker">BSC capital operations</span>
            <h1>Hire a capital operator.</h1>
            <p>Load a current, block-pinned Venus position and hire a provider to return either a bounded unsigned rescue plan or a provable refusal with a durable receipt.</p>
            <button className="market-intro-action" type="button" onClick={() => onCreateJob("LENDING_RESCUE")}>
              Check a current Venus position <ArrowRight size={17} aria-hidden="true" />
            </button>
          </div>
          <div className="market-system-panel" aria-label="Marketplace system status">
            <span className={`system-live ${telemetry ? "online" : "loading"}`} role="status"><Radio size={14} aria-hidden="true" /> {telemetry ? "LIVE BSC DATA" : "SYNCING BSC"}</span>
            <div className="market-system-grid">
              <div><strong>{telemetry ? Number(telemetry.mainnet.blockNumber).toLocaleString("en-US") : "-"}</strong><span>BSC block</span></div>
              <div><strong>{telemetry ? `$${telemetry.market.spotPriceUsd}` : "-"}</strong><span>WBNB / USDT</span></div>
              <div><strong>{telemetry ? `${telemetry.venus.supplyAprPct}%` : "-"}</strong><span>Venus vUSDT APR</span></div>
              <div><strong>{providers.length ? `${providers.length}/4` : "-"}</strong><span>verified agents</span></div>
            </div>
            <p>{telemetry ? `Block-pinned RPC reads · ${telemetry.mainnet.rpcLatencyMs} ms · ${new Date(telemetry.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Provider decisions remain available while live chain telemetry synchronises."}</p>
          </div>
        </div>
      </section>

      <section className="task-deck" aria-label="Capital tasks">
        {TASKS.map((task) => {
          const Icon = task.icon;
          const active = task.id === selectedService;
          return (
            <button
              key={task.id}
              className={active ? "active" : ""}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(task.id)}
            >
              <span className="task-deck-top"><span>{task.index}</span><Icon size={19} aria-hidden="true" /></span>
              <strong>{task.title}</strong>
              <small>{task.description}</small>
              <span className="task-deck-foot"><span><b>{task.id === "LENDING_RESCUE" ? "$0 current hire" : task.id === "YIELD_OPTIMIZATION" ? "Simulation" : "$0 evidence replay"}</b><small>{task.id === "LENDING_RESCUE" ? "Block-pinned Venus · no wallet" : task.id === "YIELD_OPTIMIZATION" ? "No frozen comparison task" : "Historical fixture · no wallet"}</small></span><ArrowUpRight size={15} aria-hidden="true" /></span>
            </button>
          );
        })}
      </section>

      <div className="page-shell market-registry-shell">
        <div className="market-section-heading">
          <div>
            <span className="page-kicker">Verified operator registry</span>
            <h2>One provider. One bounded deliverable.</h2>
            <p>Compare price, conformance, and availability before opening the job workspace.</p>
          </div>
          <div className="registry-summary" aria-label="Registry status">
            <span><strong>{providers.length || "-"}</strong> providers</span>
            <span><strong>4/4</strong> categories</span>
            <span><strong>{matrix.size ? `${matrix.size}/4` : "-"}</strong> conformance</span>
          </div>
        </div>

        <div className="market-toolbar">
          <label className="search-control">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search providers</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search operator or capital task"
            />
          </label>
          <span className="scope-note"><ShieldCheck size={15} /> Deterministic conformance receipts</span>
        </div>

        <div className="market-layout">
          <section className="registry-panel" aria-label="Available providers">
            <div className="registry-table-wrap">
              <table className="registry-table" aria-busy={catalogLoading}>
                <thead>
                  <tr>
                    <th scope="col">Operator</th>
                    <th scope="col">Capital task</th>
                    <th scope="col">Price</th>
                    <th scope="col">Proof</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogLoading && Array.from({ length: 4 }, (_, index) => (
                    <tr className="provider-loading-row" key={`provider-loading-${index}`}>
                      <td><span className="skeleton-provider"><i /><b /></span></td>
                      <td><span className="skeleton-line medium" /></td>
                      <td><span className="skeleton-line short" /></td>
                      <td><span className="skeleton-line short" /></td>
                      <td><span className="skeleton-line medium" /></td>
                    </tr>
                  ))}
                  {!catalogLoading && filtered.map((provider) => {
                    const task = TASKS.find((candidate) => candidate.id === provider.service);
                    const Icon = task?.icon;
                    const result = matrix.get(provider.service);
                    return (
                      <tr
                        key={provider.providerId}
                        className={provider.service === selectedService ? "selected" : ""}
                      >
                        <td>
                          <button
                            className="provider-row-button"
                            type="button"
                            aria-pressed={provider.service === selectedService}
                            onClick={() => onSelect(provider.service)}
                          >
                            <span className="provider-icon">{Icon && <Icon size={17} aria-hidden="true" />}</span>
                            <span><strong>{provider.name}</strong><small>ERC-8004 #{provider.identity.agentId} · {shortHash(provider.providerId, 12)}</small></span>
                          </button>
                        </td>
                        <td><span className="category-label">{provider.category}</span></td>
                        <td><span className="trial-price"><strong>{provider.price.amount} {provider.price.token}</strong><small>Trial free</small></span></td>
                        <td><span className="verification-label"><BadgeCheck size={14} /> {result?.result.evaluation.score ?? "-"}/100</span></td>
                        <td><span className={`availability-label ${result ? "ready" : "pending"}`}><i /> {result ? "Reachable" : "Checking"}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!catalogLoading && filtered.length === 0 && <div className="empty-table">No provider matches “{query}”.</div>}
            </div>
          </section>

          <aside className="provider-detail" aria-label="Selected provider">
            {selected ? (
              <>
                <div className="provider-detail-eyebrow"><span>Selected operator</span><span><BadgeCheck size={13} /> Contract verified</span></div>
                <div className="provider-detail-title">
                  <span className="provider-icon large">{SelectedIcon && <SelectedIcon size={21} aria-hidden="true" />}</span>
                  <div><span>{selected.category}</span><h2>{selected.name}</h2></div>
                </div>
                <div className="provider-detail-meta">
                  <strong>{selectedIsCurrentLending ? "$0.00" : selectedIsSimulation ? "Free simulation" : "$0 replay"}<small>{selectedIsCurrentLending ? "current block-pinned hire · no wallet" : selectedIsSimulation ? "not marketplace evidence" : "historical evidence · no wallet"}</small></strong>
                  <span className={`availability-label ${selectedResult ? "ready" : "pending"}`}><i /> {selectedResult ? "Reachable" : "Checking"}</span>
                </div>
                <p className="provider-summary">{selected.summary}</p>
                <dl className="provider-facts">
                  <div><dt><Server size={14} /> Endpoint</dt><dd><code>{selected.method} {selected.endpoint}</code></dd></div>
                  <div><dt><Radio size={14} /> Health</dt><dd><code>GET {selected.healthEndpoint}</code></dd></div>
                  <div><dt><BadgeCheck size={14} /> BSC identity</dt><dd><a href={selected.identity.explorerUrl} target="_blank" rel="noreferrer">ERC-8004 #{selected.identity.agentId} <ExternalLink size={11} aria-hidden="true" /></a></dd></div>
                  <div><dt><Code2 size={14} /> Machine contract</dt><dd><a href={selected.manifestEndpoint} target="_blank" rel="noreferrer">Inspect provider manifest <ExternalLink size={11} aria-hidden="true" /></a></dd></div>
                  <div><dt><Database size={14} /> Request</dt><dd><code>{selected.requestSchema}</code></dd></div>
                  <div><dt><Code2 size={14} /> Deliverable</dt><dd><code>{selected.deliverableSchema}</code></dd></div>
                  <div><dt><BadgeCheck size={14} /> Conformance</dt><dd>{selectedResult?.result.evaluation.score ?? "-"}/100 · {selectedResult?.result.job.state ?? "Checking"}</dd></div>
                </dl>
                <button className="primary-action" type="button" onClick={() => onCreateJob(selected.service)}>
                  {selectedIsCurrentLending ? "Load current position and hire" : selectedIsSimulation ? `Open ${serviceLabel(selected.service).toLowerCase()} simulation` : `Open ${serviceLabel(selected.service).toLowerCase()} workspace`}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
                {selectedResult?.receipt.path ? (
                  <a className="provider-receipt-preview" href={selectedResult.receipt.path} target="_blank" rel="noreferrer">
                    <CheckCircle2 size={15} aria-hidden="true" />
                    <span><strong>Open historical evidence receipt</strong><small>{shortHash(selectedResult.result.evaluation.evaluationHash)}</small></span>
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                ) : null}
                <div className="provider-boundary">
                  <strong>Trial boundary</strong>
                  <span>{selectedIsCurrentLending
                    ? "$0 · no wallet · current block-pinned read · persisted request/result receipt · unsigned plan or refusal · no transaction execution or payment"
                    : selectedIsSimulation
                      ? "Interactive simulation only · no persisted marketplace-hire claim"
                      : "$0 · no wallet · historical evidence replay · no current-action, payment, or external-demand claim"}</span>
                </div>
              </>
            ) : (
              <div className="provider-detail-loading" aria-label="Loading provider details">
                <span className="skeleton-detail-heading"><i /><b /></span>
                <span className="skeleton-line full" />
                <span className="skeleton-line full" />
                <span className="skeleton-line medium" />
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
