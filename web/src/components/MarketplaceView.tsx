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
import type {
  ExternalComparisonSnapshot,
  FixtureJobResponse,
  ProviderListing,
  ServiceId,
  SystemTelemetry,
} from "../types";

function exactUtc(value: string): string {
  return new Date(value).toISOString().replace("T", " ").replace(/\.000Z$/, " UTC").replace(/Z$/, " UTC");
}

function externalPrice(mode: ExternalComparisonSnapshot["candidates"][number]["pricing"]["mode"]): string {
  if (mode === "QUOTE_REQUIRED") return "Quote required";
  if (mode === "UNVERIFIED_MARKETPLACE_ASSERTION") return "Not verified";
  return "Not published";
}

export function MarketplaceView({
  providers,
  matrix,
  selectedService,
  onSelect,
  onCreateJob,
  telemetry,
  externalComparisons,
}: {
  providers: ProviderListing[];
  matrix: Map<ServiceId, FixtureJobResponse>;
  selectedService: ServiceId;
  onSelect: (service: ServiceId) => void;
  onCreateJob: (service: ServiceId) => void;
  telemetry: SystemTelemetry | null;
  externalComparisons: ExternalComparisonSnapshot | null;
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
              <span className="task-deck-foot"><span><b>$0 current hire</b><small>{task.currentSource} · no wallet</small></span><ArrowUpRight size={15} aria-hidden="true" /></span>
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
                  <strong>$0.00<small>current block-pinned hire · no wallet</small></strong>
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
                  {selectedTask?.currentAction ?? `Open current ${serviceLabel(selected.service).toLowerCase()} hire`}
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
                  <span>$0 · no wallet · current block-pinned read · persisted request/result receipt · unsigned plan or refusal · no transaction execution, payment, or external-demand claim</span>
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

        <section className="external-comparison" aria-labelledby="external-comparison-heading">
          <div className="external-comparison-heading">
            <div>
              <span className="page-kicker">Registry evidence, not endorsement</span>
              <h2 id="external-comparison-heading">External comparison candidates</h2>
              <p>One externally owned ERC-8004 listing per capital category. Compare public evidence here; hiring remains limited to the verified PositionCrew providers above.</p>
            </div>
            {externalComparisons ? (
              <span className="external-snapshot-pin">BSC #{Number(externalComparisons.chain.blockNumber).toLocaleString("en-US")}</span>
            ) : null}
          </div>
          {externalComparisons ? (
            <div className="external-candidate-grid">
              {externalComparisons.candidates.map((candidate) => {
                const selectedCategory = candidate.category.service === selectedService;
                return (
                  <article
                    className={`external-candidate-card ${selectedCategory ? "matched" : ""}`}
                    key={candidate.agentTokenId}
                  >
                    <div className="external-candidate-topline">
                      <span>{candidate.category.label}</span>
                      <span>External operator</span>
                    </div>
                    <h3>{candidate.name}</h3>
                    <code>ERC-8004 #{candidate.agentTokenId} · {shortHash(candidate.identity.owner, 12)}</code>
                    <div className="external-candidate-statuses">
                      <span>Registry: Listed</span>
                      <span className={candidate.serviceReachability.status === "REACHABLE" ? "reachable" : "listed"}>
                        Service: {candidate.serviceReachability.status === "REACHABLE" ? "Endpoint reachable" : "Listed only"}
                      </span>
                    </div>
                    <dl className="external-candidate-facts">
                      <div><dt>Price</dt><dd>{externalPrice(candidate.pricing.mode)}</dd></div>
                      <div><dt>Track record</dt><dd>Unverified</dd></div>
                    </dl>
                    <p className="external-candidate-reputation">
                      {candidate.feedback.recordCount} indexed feedback · {candidate.validation.recordCount} indexed validations
                    </p>
                    <time dateTime={candidate.serviceReachability.checkedAt}>
                      Checked {exactUtc(candidate.serviceReachability.checkedAt)}
                    </time>
                    <div className="external-candidate-links">
                      <a href={candidate.identity.sourceUrl} target="_blank" rel="noreferrer">Identity <ExternalLink size={11} aria-hidden="true" /></a>
                      <a href={candidate.category.sourceUrl} target="_blank" rel="noreferrer">Listing <ExternalLink size={11} aria-hidden="true" /></a>
                      <a href={candidate.serviceReachability.sourceUrl} target="_blank" rel="noreferrer">Endpoint evidence <ExternalLink size={11} aria-hidden="true" /></a>
                    </div>
                    <p className="external-candidate-boundary">Evidence candidate only · hiring unavailable · no PositionCrew endorsement.</p>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="external-candidate-loading" role="status">External comparison evidence is unavailable. First-party hiring remains available.</div>
          )}
        </section>
      </div>
    </main>
  );
}
