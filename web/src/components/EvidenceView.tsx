import {
  AlertTriangle,
  BadgeCheck,
  Check,
  Clock3,
  Coins,
  ExternalLink,
  FileCheck2,
  LockKeyhole,
  Radio,
  ShieldCheck,
} from "lucide-react";
import termixIdentityEvidence from "../../../evidence/termix-identities.mainnet.json" with { type: "json" };
import termixListingEvidence from "../../../evidence/termix-listings.mainnet.json" with { type: "json" };
import { shortHash } from "../presentation";
import type {
  AacpProductionReadiness,
  AgentCaptureManifestResponse,
  AgentAdvantagePublicationStatus,
  FounderAgentAdvantagePublicationStatus,
  PublicationLoadState,
  BenchmarkRepeatabilityResponse,
  BoundedGridForwardShadowLedger,
  BoundedGridForwardShadowState,
  FixtureJobResponse,
  Erc8183TestnetLedger,
  MarketplaceInvocationEvidence,
  ProviderListing,
  ProductionTrackRecord,
  ServiceId,
  SystemTelemetry,
  TermixBenchmarkService,
} from "../types";
import { isVerifiedFounderAgentAdvantagePublication } from "../types";

function shadowStateLabel(state: BoundedGridForwardShadowState): string {
  return {
    PRECOMMITTED: "Precommitted",
    REFUSED: "Refused",
    CLOSED: "Closed",
    VOID_SOURCE_GAP: "Void · source gap",
    RISK_EXIT: "Risk exit",
  }[state];
}

function shadowStateTone(state: BoundedGridForwardShadowState): string {
  return state === "CLOSED"
    ? "good"
    : state === "REFUSED" || state === "PRECOMMITTED"
      ? "neutral"
      : "warn";
}

function simulatedUsd(value: string | null): string {
  if (value === null) return "-";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  return `${amount >= 0 ? "+" : "-"}$${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function EvidenceView({
  providers,
  matrix,
  telemetry,
  benchmarks,
  captureManifest,
  marketplaceProvenance,
  commerceLedger,
  aacpReadiness,
  advantagePublication,
  founderAdvantagePublication,
  advantagePublicationLoadState,
  founderAdvantagePublicationLoadState,
  productionTrackRecord,
  forwardShadowLedger,
}: {
  providers: ProviderListing[];
  matrix: Map<ServiceId, FixtureJobResponse>;
  telemetry: SystemTelemetry | null;
  benchmarks: BenchmarkRepeatabilityResponse[];
  captureManifest: AgentCaptureManifestResponse | null;
  marketplaceProvenance: MarketplaceInvocationEvidence | null;
  commerceLedger: Erc8183TestnetLedger | null;
  aacpReadiness: AacpProductionReadiness | null;
  advantagePublication: AgentAdvantagePublicationStatus | null;
  founderAdvantagePublication: FounderAgentAdvantagePublicationStatus | null;
  advantagePublicationLoadState: PublicationLoadState;
  founderAdvantagePublicationLoadState: PublicationLoadState;
  productionTrackRecord: ProductionTrackRecord | null;
  forwardShadowLedger: BoundedGridForwardShadowLedger | null;
}) {
  const publishedAdvantage = advantagePublication?.status === "PUBLISHED"
    ? advantagePublication
    : null;
  const publishedFounderAdvantage = isVerifiedFounderAgentAdvantagePublication(
    founderAdvantagePublication,
  )
    ? founderAdvantagePublication
    : null;
  const strictPublicationLabel = advantagePublicationLoadState === "LOADING"
    ? "Loading"
    : advantagePublicationLoadState === "UNAVAILABLE"
      ? "Unavailable"
      : publishedAdvantage
        ? "Published"
        : "In progress";
  const deliveryByService = new Map(
    (marketplaceProvenance?.summaries ?? []).map((summary) => [summary.service, summary]),
  );
  const definitions: Array<{ service: TermixBenchmarkService; task: string; category: string }> = [
    { service: "LENDING_RESCUE", task: "Lending position rescue", category: "Security / DeFi" },
    { service: "LP_REBALANCE", task: "LP range rebalancing", category: "Liquidity" },
    { service: "BOUNDED_GRID", task: "Bounded grid construction", category: "Trading" },
  ];
  const benchmarkRows = definitions.map((definition) => {
    const record = benchmarks.find((candidate) => candidate.service === definition.service);
    const delivery = deliveryByService.get(definition.service);
    const lock = matrix.get(definition.service)?.benchmarkLock;
    return {
      ...definition,
      record,
      delivery,
      lock,
      status: delivery?.successCount === 2 ? "OBSERVED" : record ? "REPEATABLE" : lock ? "LOCKED" : "PENDING",
      tone: delivery?.successCount === 2 || record ? "captured" : lock ? "locked" : "planned",
      detail: publishedFounderAdvantage
        ? `${publishedFounderAdvantage.exactOutputParityCount}/3 exact canonical output pairs across the founder report`
        : delivery?.successCount === 2
        ? `2/2 controlled Provider endpoint observations · ${delivery.medianElapsedMilliseconds} ms median`
        : record
          ? `${record.runs.length} reproducible provider runs; founder comparison not published`
        : lock
          ? "Fixture, rubric, and blind protocol committed"
          : "Benchmark lock pending",
    };
  });
  const lockedCount = benchmarkRows.filter((row) => row.lock).length;
  const repeatCount = benchmarks.reduce((total, record) => total + record.runs.length, 0);
  const committedCandidateCount = captureManifest?.benchmarks.reduce(
    (total, benchmark) => total + benchmark.candidates.length,
    0,
  ) ?? 0;
  const flagshipCommerceJobs = commerceLedger?.jobs.filter(
    (job) => job.runType === "FUNDED_CATEGORY_RECEIPT",
  ) ?? [];
  const productionStatusLabel = productionTrackRecord?.status === "OPERATIONAL"
    ? "All observed passed"
    : productionTrackRecord?.status === "DEGRADED"
      ? `${productionTrackRecord.summary.unsuccessfulRuns} unsuccessful`
      : productionTrackRecord?.status === "COLLECTING"
        ? "Collecting"
        : productionTrackRecord?.status === "SOURCE_UNAVAILABLE"
          ? "Source unavailable"
          : "Loading";
  const productionStatusTone = productionTrackRecord?.status === "OPERATIONAL"
    ? "good"
    : productionTrackRecord?.status === "DEGRADED" || productionTrackRecord?.status === "SOURCE_UNAVAILABLE"
      ? "warn"
      : "neutral";
  const forwardShadowStatusLabel = forwardShadowLedger?.status === "MATURE"
    ? "Mature"
    : forwardShadowLedger?.status === "DEGRADED"
      ? "Degraded"
      : forwardShadowLedger?.status === "SOURCE_UNAVAILABLE"
        ? "Source unavailable"
        : forwardShadowLedger?.status === "COLLECTING"
          ? "Collecting"
          : "Loading";
  const forwardShadowStatusTone = forwardShadowLedger?.status === "MATURE"
    ? "good"
    : forwardShadowLedger?.status === "DEGRADED" ||
        forwardShadowLedger?.status === "SOURCE_UNAVAILABLE"
      ? "warn"
      : "neutral";
  const matureShadowAggregate = forwardShadowLedger?.status === "MATURE"
    ? forwardShadowLedger.summary.simulatedNetOutcomeUsd
    : null;
  const aacpStatus = aacpReadiness?.state === "PROVIDERS_ONLINE"
    ? { label: "Providers online", tone: "good" }
    : aacpReadiness?.state === "LISTINGS_PUBLISHED_RUNTIME_PENDING"
      ? { label: "Original runtimes pending", tone: "warn" }
      : aacpReadiness?.state === "IDENTITIES_MINTED_LISTINGS_PENDING"
        ? { label: "Listings pending", tone: "good" }
      : aacpReadiness?.state === "ONBOARDING_PENDING"
        ? { label: "Onboarding", tone: "neutral" }
        : aacpReadiness?.state === "MARKETPLACE_DISCOVERY_DEGRADED"
          ? { label: "Discovery degraded", tone: "warn" }
        : aacpReadiness?.state === "PROTOCOL_DEGRADED"
          ? { label: "Protocol degraded", tone: "warn" }
          : aacpReadiness?.state === "SOURCE_UNAVAILABLE"
            ? { label: "Source unavailable", tone: "warn" }
            : { label: "Loading", tone: "neutral" };
  const aacpProviderStatus = (status: AacpProductionReadiness["marketplace"]["providers"][number]["status"]) => ({
    HANDLE_AVAILABLE: "Ready to mint",
    HANDLE_UNRESOLVED: "Name reserved",
    IDENTITY_ONCHAIN: "Identity minted",
    IDENTITY_ONCHAIN_DISCOVERY_DEGRADED: "Minted · index delayed",
    AGENT_INDEXED: "Agent indexed",
    LISTED_OFFLINE: "Listing published",
    ONLINE_AND_LISTED: "Online",
    DISCOVERY_UNAVAILABLE: "Discovery unavailable",
    LISTING_DISCOVERY_UNAVAILABLE: "Listing check unavailable",
    UPSTREAM_UNAVAILABLE: "Unavailable",
  })[status];
  const committedIdentityCount = termixIdentityEvidence.providers.length;
  const committedListingCount = termixListingEvidence.listings.length;
  return (
    <main className="page-shell evidence-page">
      <div className="page-title-row">
        <div>
          <span className="page-kicker">Verification</span>
          <h1>Evidence register</h1>
          <p>Conformance receipts and Agent Advantage evidence are reported as separate claims.</p>
        </div>
        <div className="evidence-summary">
          <span><Radio size={16} /><strong>{telemetry ? `#${Number(telemetry.mainnet.blockNumber).toLocaleString("en-US")}` : "-"}</strong> live BSC block</span>
          <span><BadgeCheck size={16} /><strong>{providers.length}/4</strong> BSC identities</span>
          <span><BadgeCheck size={16} /><strong>{matrix.size}/4</strong> public receipts</span>
          <span><Coins size={16} /><strong>{commerceLedger?.summary.fundedCompletedJobs ?? "-"}</strong> funded test jobs</span>
          <span><Radio size={16} /><strong>{aacpReadiness?.marketplace.publishedListingCount ?? committedListingCount}/4</strong> AACP listings</span>
          <span><LockKeyhole size={16} /><strong>{lockedCount}/3</strong> benchmarks locked</span>
          <span><FileCheck2 size={16} /><strong>{marketplaceProvenance?.aggregate.successCount ?? "-"}/6</strong> retained endpoint observations</span>
          <span><BadgeCheck size={16} /><strong>1</strong> merged upstream fix</span>
        </div>
      </div>

      <section className="evidence-section infrastructure-section" aria-labelledby="infrastructure-title">
        <div className="section-bar">
          <div><span className="section-kicker">Live sources</span><h2 id="infrastructure-title">Onchain infrastructure register</h2></div>
          <span className={`state-label ${telemetry ? "good" : "neutral"}`}><Radio size={13} /> {telemetry ? "Block pinned" : "Synchronising"}</span>
        </div>
        {telemetry ? (
          <div className="infrastructure-grid">
            <a href={telemetry.mainnet.explorerUrl} target="_blank" rel="noreferrer">
              <span>BNB Smart Chain</span><strong>#{Number(telemetry.mainnet.blockNumber).toLocaleString("en-US")}</strong><small>{telemetry.mainnet.gasPriceGwei} Gwei · {telemetry.mainnet.rpcLatencyMs} ms</small><ExternalLink size={14} />
            </a>
            <a href={telemetry.market.explorerUrl} target="_blank" rel="noreferrer">
              <span>PancakeSwap V3</span><strong>${telemetry.market.spotPriceUsd}</strong><small>{telemetry.market.pair} · tick {telemetry.market.tick}</small><ExternalLink size={14} />
            </a>
            <a href={telemetry.venus.explorerUrl} target="_blank" rel="noreferrer">
              <span>Venus vUSDT</span><strong>{telemetry.venus.supplyAprPct}% APR</strong><small>${Number(telemetry.venus.availableLiquidityUsd).toLocaleString("en-US")} available</small><ExternalLink size={14} />
            </a>
            <a href={providers[0]?.identity.explorerUrl ?? telemetry.testnet.explorerUrl} target="_blank" rel="noreferrer">
              <span>ERC-8004 / BSC Testnet</span><strong>{providers.length}/4</strong><small>provider identities · endpoints bound</small><ExternalLink size={14} />
            </a>
          </div>
        ) : <div className="infrastructure-loading">Live BSC telemetry is temporarily unavailable. Deterministic receipts remain reproducible.</div>}
      </section>

      <section className="evidence-section" aria-labelledby="upstream-title">
        <div className="section-bar">
          <div><span className="section-kicker">Ecosystem contribution</span><h2 id="upstream-title">BNB Agent SDK correction</h2></div>
          <span className="state-label good"><BadgeCheck size={13} /> Merged upstream</span>
        </div>
        <div className="operations-boundary">
          <ShieldCheck size={16} aria-hidden="true" />
          <span><strong>Integration failure fixed at the source.</strong>PositionCrew exposed a stale BSC Testnet APEX policy that made <code>registerJob()</code> revert with <code>PolicyNotWhitelisted</code>. BNB Chain merged our synchronized Python, TypeScript, documentation, and regression-test correction after 776 Python and 1,107 TypeScript tests passed.</span>
          <a href="https://github.com/bnb-chain/bnbagent-sdk/pull/73" target="_blank" rel="noreferrer">Inspect merged PR <ExternalLink size={12} /></a>
        </div>
        <div className="claim-warning">
          <AlertTriangle size={16} aria-hidden="true" />
          <span><strong>Claim boundary.</strong>This proves a merged contribution to sponsor-maintained infrastructure. It does not prove PositionCrew adoption, revenue, or BNB Chain endorsement.</span>
        </div>
      </section>

      <section className="evidence-section" aria-labelledby="venus-native-supply-title">
        <div className="section-bar">
          <div><span className="section-kicker">Optional execution evidence</span><h2 id="venus-native-supply-title">Bounded Venus testnet supply receipt</h2></div>
          <span className="state-label warn"><Coins size={13} /> BSC Testnet · 0.0001 tBNB</span>
        </div>
        <div className="operations-boundary">
          <ShieldCheck size={16} aria-hidden="true" />
          <span><strong>One disclosed-operator integration action.</strong> The immutable receipt binds the exact vBNB mint, block, events, before/after balance, Venus source commit, and transaction cost. Its frozen preflight records zero BSC mainnet native balance and pending nonce.</span>
          <span className="delivery-links"><a href="/api/evidence/venus-testnet-native-supply/2026-08-24" target="_blank" rel="noreferrer">Receipt JSON <ExternalLink size={12} /></a><a href="https://testnet.bscscan.com/tx/0xf2b4a8790ff7f81fc832a365d89eb84f0554d2242c45faa886ba6819acb1773b" target="_blank" rel="noreferrer">Explorer <ExternalLink size={12} /></a><a href="https://github.com/VenusProtocol/venus-protocol/blob/2ef5ebeff8062bbc8b6cfcda67c2c176299373c0/contracts/Tokens/VTokens/VBNB.sol" target="_blank" rel="noreferrer">Pinned Venus source <ExternalLink size={12} /></a></span>
        </div>
        <div className="claim-warning">
          <AlertTriangle size={16} aria-hidden="true" />
          <span><strong>Claim boundary.</strong> Optional sponsor and execution evidence only. The preflight observed zero BSC-mainnet native BNB balance and pending nonce at one timestamp but did not inventory tokens or NFTs. It proves no external buyer, revenue, autonomous custody, strategy return, repeated track record, marketplace demand, or financial performance.</span>
        </div>
      </section>

      <section className="evidence-section aacp-section" aria-labelledby="aacp-title">
        <div className="section-bar">
          <div><span className="section-kicker">TermiX production rail</span><h2 id="aacp-title">AACP deployment and provider onboarding</h2></div>
          <span className={`state-label ${aacpStatus.tone}`}><Radio size={13} /> {aacpStatus.label}</span>
        </div>
        <div className="aacp-facts">
          <div><strong>{aacpReadiness?.protocol.contractCount ? `${aacpReadiness.protocol.deployedCount}/${aacpReadiness.protocol.contractCount}` : "-"}</strong><span>production contracts</span><small>{aacpReadiness ? "Bytecode checked independently on chain 56" : "Live protocol check pending"}</small></div>
          <div><strong>{aacpReadiness?.protocol.currencies.map((currency) => currency.symbol).join(" + ") || "-"}</strong><span>settlement currencies</span><small>{aacpReadiness?.protocol.protocolFeeBps == null ? "Live fee check pending" : `${aacpReadiness.protocol.protocolFeeBps / 100}% protocol fee`}</small></div>
          <div><strong>{aacpReadiness?.marketplace.registeredIdentityCount ?? committedIdentityCount}/4</strong><span>mainnet identities</span><small>Committed ERC-8004 mint receipts remain available during live-source delays</small></div>
          <div><strong>{aacpReadiness?.marketplace.publishedListingCount ?? committedListingCount}/4</strong><span>public listings</span><small>Committed Agent.family listing records remain directly inspectable</small></div>
          <div><strong>{aacpReadiness ? (aacpReadiness.marketplace.dedicatedFlagship.status === "ONLINE_AND_LISTED" ? "ONLINE" : aacpReadiness.marketplace.dedicatedFlagship.status === "LISTED_OFFLINE" ? "OFFLINE" : "UNAVAILABLE") : "-"}</strong><span>dedicated flagship</span><small>{aacpReadiness ? `Original fleet ${aacpReadiness.marketplace.onlineProviderCount}/${aacpReadiness.marketplace.requiredProviderCount}; reported separately` : "Expiring A2A presence; reported separately from core health"}</small></div>
        </div>
        {aacpReadiness ? (
          <>
            <div className="aacp-provider-grid" aria-label="TermiX production provider onboarding state">
              <div key="dedicated-flagship">
                <span>Dedicated Lending Rescue runtime</span>
                <strong>{aacpReadiness.marketplace.dedicatedFlagship.handle}</strong>
                <small>{`ERC-8004 #${aacpReadiness.marketplace.dedicatedFlagship.agentTokenId} · separate owner wallet`}</small>
                <a className="aacp-identity-link" href={aacpReadiness.marketplace.dedicatedFlagship.explorerUrl} target="_blank" rel="noreferrer">Mint receipt <ExternalLink size={11} /></a>
                <a className="aacp-identity-link" href={aacpReadiness.marketplace.dedicatedFlagship.listingUrl} target="_blank" rel="noreferrer">Public listing <ExternalLink size={11} /></a>
                <span className={`state-label ${aacpReadiness.marketplace.dedicatedFlagship.status === "ONLINE_AND_LISTED" ? "good" : aacpReadiness.marketplace.dedicatedFlagship.status.includes("UNAVAILABLE") ? "warn" : "neutral"}`}>{aacpProviderStatus(aacpReadiness.marketplace.dedicatedFlagship.status)}</span>
              </div>
              {aacpReadiness.marketplace.providers.map((provider) => (
                <div key={provider.service}>
                  <span>{providers.find((candidate) => candidate.service === provider.service)?.category ?? provider.service}</span>
                  <strong>{provider.handle}</strong>
                  <small>{provider.agentTokenId ? `ERC-8004 #${provider.agentTokenId}` : provider.status === "HANDLE_AVAILABLE" ? "Handle unclaimed" : "Identity not yet resolved"}</small>
                  {provider.identity ? <a className="aacp-identity-link" href={provider.identity.explorerUrl} target="_blank" rel="noreferrer">Mint receipt <ExternalLink size={11} /></a> : null}
                  {provider.listingUrl ? <a className="aacp-identity-link" href={provider.listingUrl} target="_blank" rel="noreferrer">Public listing <ExternalLink size={11} /></a> : null}
                  <span className={`state-label ${provider.status === "ONLINE_AND_LISTED" || provider.status === "IDENTITY_ONCHAIN" ? "good" : provider.status.includes("UNAVAILABLE") || provider.status.includes("DEGRADED") ? "warn" : "neutral"}`}>{aacpProviderStatus(provider.status)}</span>
                </div>
              ))}
            </div>
            <div className="aacp-runtime-band">
              <div><strong>Poller signer-free</strong><span>Root-only renewer signs; the A2A poller receives only its scoped token</span></div>
              <div><strong>{aacpReadiness.integration.orderGuard.guardedActions.length} actions guarded</strong><span>ABI calldata and mined transaction must match</span></div>
              <div><strong>{aacpReadiness.integration.runtime.rotationEvidence.verifiedRotationCount} verified rotations</strong><span>Dedicated automatic renewals; discrete host observations, not continuous uptime</span></div>
              <div><strong>{aacpReadiness.integration.runtime.automaticConversationKinds.length} + {aacpReadiness.integration.runtime.operatorRequiredConversationKinds.length} surfaces</strong><span>Pre-sale automated; orders and disputes gated</span></div>
            </div>
            <div className="operations-boundary">
              <ShieldCheck size={16} aria-hidden="true" />
              <span><strong>Rotation boundary.</strong>{aacpReadiness.integration.runtime.rotationEvidence.boundaries[1]}</span>
            </div>
            <div className="operations-boundary">
              <ShieldCheck size={16} aria-hidden="true" />
              <span><strong>Production protocol, honest onboarding state.</strong>{aacpReadiness.boundaries[0]} {aacpReadiness.boundaries[1]}</span>
              <span className="delivery-links"><a href="/api/commerce/aacp" target="_blank" rel="noreferrer">Readiness record <ExternalLink size={12} /></a><a href={aacpReadiness.source.docsUrl} target="_blank" rel="noreferrer">TermiX guide <ExternalLink size={12} /></a></span>
            </div>
          </>
        ) : (
          <div className="operations-boundary">
            <Clock3 size={16} aria-hidden="true" />
            <span><strong>Live TermiX status is loading.</strong> Durable identity and listing counts above come from committed public receipts; no runtime availability is inferred.</span>
            <span className="delivery-links"><a href="/api/commerce/aacp" target="_blank" rel="noreferrer">Live readiness <ExternalLink size={12} /></a>{termixListingEvidence.listings.slice(0, 1).map((listing) => <a key={listing.listingId} href={listing.listingUrl} target="_blank" rel="noreferrer">Inspect listing <ExternalLink size={12} /></a>)}</span>
          </div>
        )}
      </section>

      <section className="evidence-section delivery-evidence-section" aria-labelledby="delivery-title">
        <div className="section-bar">
          <div><span className="section-kicker">Controlled delivery proof</span><h2 id="delivery-title">Delivered through public Provider endpoints</h2></div>
          <span className="state-label warn"><FileCheck2 size={13} /> {marketplaceProvenance ? `PARTIAL E2 · ${marketplaceProvenance.aggregate.successCount}/6 retained` : "Loading"}</span>
        </div>
        {marketplaceProvenance ? (
          <>
            <div className="delivery-facts">
              <div><strong>{marketplaceProvenance.aggregate.successCount}/6</strong><span>controlled endpoint observations</span><small>Two sequential calls per frozen task; not hires</small></div>
              <div><strong>0</strong><span>retries or replacements</span><small>Every planned attempt remains in sequence</small></div>
              <div><strong>3/3</strong><span>exact output pairs</span><small>Matched precommitted output and evaluation hashes</small></div>
              <div><strong>$0</strong><span>judge-trial cost</span><small>No wallet · in-memory conformance rail</small></div>
            </div>
            <div className="delivery-task-list" aria-label="Marketplace delivery records by task">
              {definitions.map((definition) => {
                const summary = deliveryByService.get(definition.service);
                const records = marketplaceProvenance.records.filter((record) => record.service === definition.service);
                const receiptUrl = records[0]?.observation?.receiptUrl;
                const outputHash = records[0]?.observation?.outputHash;
                return (
                  <div key={definition.service}>
                    <span><strong>{definition.task}</strong><small>{definition.category}</small></span>
                    <span><strong>{summary?.successCount ?? 0}/2</strong><small>retained observations</small></span>
                    <span><strong>{summary?.medianElapsedMilliseconds ?? "-"} ms</strong><small>end-to-end median</small></span>
                    <span><code>{shortHash(outputHash, 16)}</code><small>output commitment</small></span>
                    {receiptUrl ? <a href={receiptUrl} target="_blank" rel="noreferrer">Receipt <ExternalLink size={12} /></a> : <span>-</span>}
                  </div>
                );
              })}
            </div>
            <div className="operations-boundary">
              <ShieldCheck size={16} aria-hidden="true" />
              <span><strong>Precommitted controlled-delivery overlay.</strong>The protocol was public before these six calls. It proves the exact frozen agent outputs were returned through PositionCrew&apos;s public Provider endpoints; it does not prove a marketplace hire, payment, external buyer, demand, settlement, or investment performance.</span>
              <span className="delivery-links"><a href="/api/benchmarks/marketplace-provenance" target="_blank" rel="noreferrer">Raw record <ExternalLink size={12} /></a><a href={marketplaceProvenance.source.protocolUrl} target="_blank" rel="noreferrer">Protocol <ExternalLink size={12} /></a></span>
            </div>
            <div className="claim-warning">
              <AlertTriangle size={16} aria-hidden="true" />
              <span><strong>PARTIAL E2 observation only.</strong>Lending and LP are locked historical fixture replays. The grid request surface showed Interactive mode with a fresh block, while its returned result remained labelled historical and matched the old frozen output hash. That unresolved mode contradiction prevents a fresh-execution or marketplace-hire claim.</span>
            </div>
          </>
        ) : <div className="infrastructure-loading">The immutable marketplace delivery record is loading.</div>}
      </section>

      <section className="evidence-section forward-shadow-section" aria-labelledby="forward-shadow-title">
        <div className="section-bar">
          <div>
            <span className="section-kicker">Forward-only high-stakes evidence</span>
            <h2 id="forward-shadow-title">Bounded Grid shadow outcome ledger</h2>
          </div>
          <span className={`state-label ${forwardShadowStatusTone}`}>
            <Radio size={13} /> {forwardShadowStatusLabel}
          </span>
        </div>
        {forwardShadowLedger ? (
          <>
            <div className="forward-shadow-facts">
              <div>
                <strong>{forwardShadowLedger.summary.precommittedWindowCount}</strong>
                <span>precommitted windows</span>
                <small>One hourly WBNB/USDT window</small>
              </div>
              <div>
                <strong>{forwardShadowLedger.summary.terminalWindowCount}</strong>
                <span>terminal windows</span>
                <small>{forwardShadowLedger.summary.refusedWindowCount} refused · {forwardShadowLedger.summary.voidWindowCount} void</small>
              </div>
              <div>
                <strong>{forwardShadowLedger.maturity.nonVoidRatePct === null ? "-" : `${forwardShadowLedger.maturity.nonVoidRatePct}%`}</strong>
                <span>non-void rate</span>
                <small>Minimum {forwardShadowLedger.maturity.minimumNonVoidRatePct}% at maturity</small>
              </div>
              <div>
                <strong>{forwardShadowLedger.status === "MATURE" ? simulatedUsd(matureShadowAggregate) : "WITHHELD"}</strong>
                <span>aggregate simulated outcome</span>
                <small>
                  {forwardShadowLedger.status === "MATURE"
                    ? `${forwardShadowLedger.summary.positiveWindowCount} positive · ${forwardShadowLedger.summary.negativeWindowCount} negative`
                    : `${forwardShadowLedger.maturity.observedDays}/${forwardShadowLedger.maturity.minimumObservedDays} days · ${forwardShadowLedger.maturity.terminalWindowCount}/${forwardShadowLedger.maturity.minimumTerminalWindows} terminal`}
                </small>
              </div>
            </div>
            <div className="forward-shadow-model">
              <span><strong>Strategy</strong><code>{forwardShadowLedger.model.strategyVersion}</code></span>
              <span><strong>Fill model</strong><code>{forwardShadowLedger.model.name}</code></span>
              <span><strong>Sampling</strong>{forwardShadowLedger.model.sampleCadenceMinutes} min samples · {forwardShadowLedger.model.horizonMinutes} min horizon</span>
              <span><strong>Integrity</strong>{forwardShadowLedger.maturity.hashChainValid ? "Hash chain valid" : "Hash chain invalid"}</span>
            </div>
            {forwardShadowLedger.recentWindows.length > 0 ? (
              <div className="forward-shadow-windows" aria-label="Recent bounded grid forward shadow windows">
                {forwardShadowLedger.recentWindows.map((window) => {
                  const hasSourcePrecommit =
                    window.sourceReceiptUrl !== null && window.sourceBlockNumber !== null;
                  return (
                    <article key={window.windowId} className={`forward-shadow-window ${window.state.toLowerCase()}`}>
                      <div>
                        <span className={`state-label ${shadowStateTone(window.state)}`}>{shadowStateLabel(window.state)}</span>
                        <time dateTime={window.startedAt}>
                          {new Date(window.startedAt).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      <strong>
                        {window.state === "CLOSED" || window.state === "RISK_EXIT"
                          ? simulatedUsd(window.simulatedNetOutcomeUsd)
                          : shadowStateLabel(window.state)}
                      </strong>
                      {hasSourcePrecommit ? (
                        <>
                          <small>
                            {window.sampledCrossings} sampled crossings · BSC block {window.sourceBlockNumber}
                          </small>
                          <code>Hire {shortHash(window.sourceHireId, 14)}</code>
                        </>
                      ) : (
                        <>
                          <small>Initialization failed before a source receipt or precommit was recorded.</small>
                          <code>Source receipt not committed</code>
                        </>
                      )}
                      <a href={window.receiptUrl} target="_blank" rel="noreferrer">
                        Window evidence <ExternalLink size={12} />
                      </a>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="infrastructure-loading">
                The first forward-only window is waiting for its protected scheduled tick.
              </div>
            )}
            <div className="operations-boundary">
              <ShieldCheck size={16} aria-hidden="true" />
              <span>
                <strong>Zero-fund simulation boundary.</strong>
                {forwardShadowLedger.claimBoundary.join(" ")}
              </span>
              <a href={forwardShadowLedger.publicUrl} target="_blank" rel="noreferrer">
                Public ledger <ExternalLink size={12} />
              </a>
            </div>
          </>
        ) : (
          <div className="infrastructure-loading">The public forward shadow ledger is loading.</div>
        )}
      </section>

      <section className="evidence-section operations-section" aria-labelledby="operations-title">
        <div className="section-bar">
          <div><span className="section-kicker">Observed reliability</span><h2 id="operations-title">Production verification record</h2></div>
          <span className={`state-label ${productionStatusTone}`}><Radio size={13} /> {productionStatusLabel}</span>
        </div>
        {productionTrackRecord ? (
          <>
            <div className="operations-facts">
              <div><strong>{productionTrackRecord.summary.successfulRuns}/{productionTrackRecord.summary.completedRuns}</strong><span>successful scheduled runs</span><small>{productionTrackRecord.summary.pendingRuns} pending · failures remain visible</small></div>
              <div><strong>{productionTrackRecord.summary.rollingPassRatePct === null ? "-" : `${productionTrackRecord.summary.rollingPassRatePct}%`}</strong><span>observed pass rate</span><small>Latest 100 scheduled runs after the fixed epoch</small></div>
              <div><strong>{productionTrackRecord.epoch.workflow.cadenceMinutes} min</strong><span>verification cadence</span><small>Push and manually triggered runs excluded</small></div>
              <div><strong>{productionTrackRecord.epoch.verification.expectedCheckCountAtEpoch}</strong><span>checks per run at epoch</span><small>Providers, receipts, BSC state, and claim boundaries</small></div>
            </div>
            {productionTrackRecord.runs.length > 0 ? (
              <div className="operations-runs" aria-label="Recent scheduled verification runs">
                {productionTrackRecord.runs.slice(0, 3).map((run) => {
                  const successful = run.status === "completed" && run.conclusion === "success";
                  return (
                    <a key={run.runId} href={run.url} target="_blank" rel="noreferrer">
                      <span className={`operations-run-state ${successful ? "passed" : run.status === "completed" ? "failed" : "pending"}`}><i />{run.status === "completed" ? run.conclusion ?? "unknown" : run.status}</span>
                      <strong>Run #{run.runId}</strong>
                      <code>{run.headSha.slice(0, 7)}</code>
                      <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  );
                })}
              </div>
            ) : (
              <div className="infrastructure-loading">
                {productionTrackRecord.status === "SOURCE_UNAVAILABLE"
                  ? "The public workflow source is temporarily unavailable; no pass rate is inferred."
                  : `The fixed monitoring epoch began ${new Date(productionTrackRecord.epoch.startedAt).toLocaleString()}; the first scheduled sample is pending.`}
              </div>
            )}
            <div className="operations-boundary">
              <ShieldCheck size={16} aria-hidden="true" />
              <span><strong>Non-cherry-picked operating evidence.</strong>Every observed scheduled run after the fixed epoch is counted. This measures production verification, not demand, financial performance, mainnet execution, or Agent Advantage.</span>
              <a href={productionTrackRecord.source.workflowUrl} target="_blank" rel="noreferrer">All workflow runs <ExternalLink size={12} /></a>
            </div>
          </>
        ) : <div className="infrastructure-loading">The public scheduled verification record is loading.</div>}
      </section>

      <section className="evidence-section commerce-evidence-section" aria-labelledby="commerce-title">
        <div className="section-bar">
          <div><span className="section-kicker">Onchain commerce</span><h2 id="commerce-title">Funded provider receipts</h2></div>
          <span className={`state-label ${commerceLedger ? "good" : "neutral"}`}><Coins size={13} /> {commerceLedger ? "6/6 completed" : "Loading"}</span>
        </div>
        {commerceLedger ? (
          <>
            <div className="commerce-facts">
              <div><strong>{commerceLedger.summary.totalEscrowDisplay}</strong><span>testnet escrow released</span><small>Six funded jobs · platform fee {commerceLedger.protocol.platformFeeBps} bps</small></div>
              <div><strong>{commerceLedger.summary.mandatoryCategoriesCovered}/4</strong><span>mandatory categories</span><small>One flagship receipt per provider</small></div>
              <div><strong>{commerceLedger.summary.completedLifecycles}</strong><span>completed lifecycles</span><small>Six funded · one zero-price path probe</small></div>
              <div><strong>{commerceLedger.protocol.disputeWindowSeconds / 60} min</strong><span>optimistic challenge</span><small>Policy quorum {commerceLedger.protocol.voteQuorum} · all approved</small></div>
            </div>
            <div className="history-table-wrap">
              <table className="history-table commerce-ledger-table">
                <thead><tr><th scope="col">Service</th><th scope="col">Job</th><th scope="col">Agent</th><th scope="col">Escrow</th><th scope="col">State</th><th scope="col">Manifest</th><th scope="col">Settlement</th></tr></thead>
                <tbody>
                  {flagshipCommerceJobs.map((job) => (
                    <tr key={job.jobId}>
                      <td><strong>{providers.find((provider) => provider.service === job.service)?.name ?? job.service}</strong><small>{job.service}</small></td>
                      <td><code>#{job.jobId}</code></td>
                      <td><a className="receipt-table-link" href={`https://testnet.bscscan.com/token/0x8004A818BFB912233c491871b3d84c89A494BD9e?a=${job.providerAgentId}`} target="_blank" rel="noreferrer">#{job.providerAgentId}<ExternalLink size={12} /></a></td>
                      <td>0.1 U</td>
                      <td><span className="state-label good"><Check size={12} /> {job.status}</span></td>
                      <td><a className="receipt-table-link" href={job.manifestUrl} target="_blank" rel="noreferrer"><code>{shortHash(job.manifestHash)}</code><ExternalLink size={12} /></a></td>
                      <td><a className="receipt-table-link" href={`${commerceLedger.network.explorer}/tx/${job.transactions.settle}`} target="_blank" rel="noreferrer"><code>{shortHash(job.transactions.settle)}</code><ExternalLink size={12} /></a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="commerce-boundary">
              <ShieldCheck size={16} aria-hidden="true" />
              <span><strong>Verified integration, disclosed operator.</strong> Separate client and provider wallets completed real BSC testnet escrow. These jobs are not external purchases, revenue, or the pending blind Agent Advantage result.</span>
              <a href="/api/commerce/erc8183" target="_blank" rel="noreferrer">Full ledger <ExternalLink size={12} /></a>
            </div>
          </>
        ) : <div className="infrastructure-loading">Commerce evidence is temporarily unavailable. Provider conformance remains independently reproducible.</div>}
      </section>

      <section className="evidence-section" aria-labelledby="coverage-title">
        <div className="section-bar">
          <div><span className="section-kicker">Main-track coverage</span><h2 id="coverage-title">Provider conformance matrix</h2></div>
          <span className="state-label good"><Check size={13} /> Equal category depth</span>
        </div>
        <div className="history-table-wrap">
          <table className="history-table evidence-table">
            <thead><tr><th scope="col">Provider</th><th scope="col">Category</th><th scope="col">State</th><th scope="col">Score</th><th scope="col">Request commitment</th><th scope="col">Conformance receipt</th></tr></thead>
            <tbody>
              {providers.map((provider) => {
                const result = matrix.get(provider.service);
                return (
                  <tr key={provider.providerId}>
                    <td><strong>{provider.name}</strong><small>{provider.providerId}</small><a className="receipt-table-link" href={provider.identity.explorerUrl} target="_blank" rel="noreferrer">ERC-8004 #{provider.identity.agentId}<ExternalLink size={12} /></a></td>
                    <td>{provider.category}</td>
                    <td><span className={`state-label ${result ? "good" : "neutral"}`}>{result?.result.job.state ?? "CHECKING"}</span></td>
                    <td>{result?.result.evaluation.score ?? "-"}/100</td>
                    <td><code>{shortHash(result?.result.job.envelopeHash)}</code></td>
                    <td>{result?.receipt.path ? <a className="receipt-table-link" href={result.receipt.path} target="_blank" rel="noreferrer"><code>{shortHash(result.result.evaluation.evaluationHash)}</code><ExternalLink size={12} /></a> : <code>-</code>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="evidence-columns">
        <section className="evidence-section benchmark-section" aria-labelledby="advantage-title">
          <div className="section-bar">
            <div><span className="section-kicker">TermiX evidence</span><h2 id="advantage-title">Independent/blind Agent Advantage programme</h2></div>
            <span className={`state-label ${publishedAdvantage ? "good" : advantagePublicationLoadState === "LOADING" ? "neutral" : "warn"}`}>{publishedAdvantage ? <Check size={13} /> : <Clock3 size={13} />} {strictPublicationLabel}</span>
          </div>
          <div className="benchmark-table">
            {benchmarkRows.map((row) => (
              <div key={row.task}>
                <span className={`benchmark-status ${row.tone}`}>{row.status === "LOCKED" || row.status === "REPEATABLE" ? <LockKeyhole size={13} /> : <Clock3 size={13} />}{row.status}</span>
                <span><strong>{row.task}</strong><small>{row.category}</small></span>
                <span>{row.detail}</span>
              </div>
            ))}
          </div>
          <div className="method-grid">
            <div><strong>{committedCandidateCount || repeatCount}</strong><span>source-committed agent runs</span><small>{captureManifest ? `3 matching pairs · source ${captureManifest.source.commitSha.slice(0, 7)}` : "capture manifest loading"}</small></div>
            <div><strong>{lockedCount}</strong><span>frozen task rubrics</span><small>300 total quality points · safety-critical gates</small></div>
            <div><strong>{publishedAdvantage ? 3 : 0}</strong><span>blind scorecards</span><small>{publishedAdvantage ? `${publishedAdvantage.agentBlindQualityScore}/300 agent quality · independently scored` : "manual baseline and evaluator pending"}</small></div>
          </div>
          <a className="benchmark-data-link" href="/api/benchmarks/captures" target="_blank" rel="noreferrer">Open source-bound capture manifest <ExternalLink size={13} /></a>
          <a className="benchmark-data-link" href="/api/benchmarks/marketplace-provenance" target="_blank" rel="noreferrer">Open controlled endpoint observation record <ExternalLink size={13} /></a>
          {publishedAdvantage && <a className="benchmark-data-link" href={publishedAdvantage.reportUrl} target="_blank" rel="noreferrer">Open independently scored report <ExternalLink size={13} /></a>}
          {publishedFounderAdvantage ? (
            <div className="claim-warning published">
              <BadgeCheck size={16} aria-hidden="true" />
                  <span><strong>Founder-operated comparison published.</strong>{publishedFounderAdvantage.exactOutputParityCount}/3 tasks record exact canonical output parity and {publishedFounderAdvantage.recordedSpeedAdvantageCount}/3 record lower agent time. The selected arms are qualified <code>E3_SERVER_PERSISTED</code> fresh PositionCrew server-persisted $0.00, no-wallet historical-fixture hires with unique D1 records and public receipts. This does not establish paid commerce or an external buyer. Quality score: not assigned (<code>null</code>); the comparison is non-independent and non-blind. <a href={publishedFounderAdvantage.reportUrl} target="_blank" rel="noreferrer">Inspect the bounded report.</a></span>
            </div>
          ) : founderAdvantagePublicationLoadState === "LOADING" ? (
            <div className="claim-warning">
              <Clock3 size={16} aria-hidden="true" />
              <span><strong>Founder comparison status loading.</strong>No result or report link is inferred while the publication record is loading.</span>
            </div>
          ) : founderAdvantagePublicationLoadState === "UNAVAILABLE" ? (
            <div className="claim-warning">
              <AlertTriangle size={16} aria-hidden="true" />
              <span><strong>Founder comparison status unavailable.</strong>The tracked record could not be loaded, so no founder result or report link is enabled.</span>
            </div>
          ) : founderAdvantagePublication?.status === "PUBLISHED" ? (
            <div className="claim-warning">
              <AlertTriangle size={16} aria-hidden="true" />
              <span><strong>Founder publication record rejected.</strong>One or more report, commitment, method, parity, timing, or claim-boundary invariants failed. No result or link is enabled.</span>
            </div>
          ) : (
            <div className="claim-warning">
              <Clock3 size={16} aria-hidden="true" />
              <span><strong>Founder comparison not published.</strong>No founder-operated result is inferred from candidate or delivery records alone.</span>
            </div>
          )}
        </section>

        <section className="evidence-section lock-section" aria-labelledby="lock-title">
          <div className="section-bar">
            <div><span className="section-kicker">Pre-registration</span><h2 id="lock-title">Three benchmark locks</h2></div>
            <FileCheck2 size={18} aria-hidden="true" />
          </div>
          <dl className="lock-facts">
            {benchmarkRows.map((row) => (
              <div key={row.service}>
                <dt>{row.task}</dt>
                <dd>{row.lock ? `fixture ${shortHash(row.lock.fixtureHash, 13)} · rubric ${shortHash(row.lock.rubricHash, 13)} · protocol ${shortHash(row.lock.protocolHash, 13)}` : "Pending"}</dd>
              </div>
            ))}
            <div>
              <dt>Agent capture manifest</dt>
              <dd>{captureManifest ? `${shortHash(captureManifest.manifestHash, 18)} · source ${captureManifest.source.commitSha.slice(0, 7)}` : "Loading"}</dd>
            </div>
            <div>
              <dt>Marketplace delivery protocol</dt>
              <dd>{marketplaceProvenance ? `${shortHash(marketplaceProvenance.protocolHash, 18)} · source ${marketplaceProvenance.source.protocolCommitSha.slice(0, 7)}` : "Loading"}</dd>
            </div>
          </dl>
          {publishedAdvantage ? (
            <div className="claim-warning published">
              <BadgeCheck size={16} aria-hidden="true" />
              <span><strong>Independent result published.</strong>{publishedAdvantage.supportedAdvantageCount}/3 frozen tasks support the pre-registered advantage rule. <a href={publishedAdvantage.reportUrl} target="_blank" rel="noreferrer">Inspect report and evidence.</a></span>
            </div>
          ) : advantagePublicationLoadState === "UNAVAILABLE" ? (
            <div className="claim-warning">
              <AlertTriangle size={16} aria-hidden="true" />
              <span><strong>Independent/blind status unavailable.</strong>No independent result is inferred while its tracked publication record is unavailable.</span>
            </div>
          ) : advantagePublicationLoadState === "LOADING" ? (
            <div className="claim-warning">
              <Clock3 size={16} aria-hidden="true" />
              <span><strong>Independent/blind status loading.</strong>No independent result is inferred while its publication record loads.</span>
            </div>
          ) : (
            <div className="claim-warning">
              <AlertTriangle size={16} aria-hidden="true" />
              <span><strong>No independent/blind result is claimed.</strong>The separate founder-operated comparison does not satisfy this programme; independent scoring remains pending.</span>
            </div>
          )}
        </section>
      </div>

      <section className="claim-register" aria-label="Claim boundaries">
        <div><BadgeCheck size={17} /><span><strong>Provider identity</strong>Four separate ERC-8004 records bind the first-party providers to their production endpoints.</span></div>
        <div><ShieldCheck size={17} /><span><strong>Conformance</strong>Four receipts reproduce, and six precommitted no-retry endpoint observations returned frozen outputs. This is partial E2 evidence, not marketplace hiring or fresh execution.</span></div>
        <div><Coins size={17} /><span><strong>Settlement</strong>Six disclosed operator-controlled ERC-8183 testnet escrows completed. TermiX production contracts are independently verified; provider onboarding is visible and no paid AACP order is claimed.</span></div>
        <div>{publishedAdvantage || publishedFounderAdvantage ? <BadgeCheck size={17} /> : <Clock3 size={17} />}<span><strong>Track record</strong>{publishedAdvantage ? `${publishedAdvantage.supportedAdvantageCount}/3 frozen tasks support the independently scored advantage rule; scope remains limited to the published report.` : publishedFounderAdvantage ? `${publishedFounderAdvantage.exactOutputParityCount}/3 frozen tasks have founder-operated exact hash parity with no quality score. The comparison is non-independent and non-blind.` : "Three tasks are pre-registered; neither a founder comparison nor blind independent result has been published."}</span></div>
      </section>
    </main>
  );
}
