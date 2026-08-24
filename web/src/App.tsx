import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { PROVIDER_CATALOG } from "../../src/marketplace/catalog.js";
import { EvidenceView } from "./components/EvidenceView";
import { JobWorkspace } from "./components/JobWorkspace";
import { MarketplaceView } from "./components/MarketplaceView";
import { ShellHeader, type AppView } from "./components/ShellHeader";
import {
  isVerifiedFounderAgentAdvantagePublication,
  projectFounderAgentAdvantageAtAGlance,
} from "./types";
import type {
  AacpProductionReadiness,
  AgentCaptureManifestResponse,
  AgentAdvantagePublicationStatus,
  FounderAgentAdvantagePublicationStatus,
  FounderAgentAdvantageAtAGlance,
  FounderAgentAdvantageAtAGlanceLoadState,
  PublicationLoadState,
  BenchmarkRepeatabilityMatrixResponse,
  BenchmarkRepeatabilityResponse,
  BoundedGridForwardShadowLedger,
  CurrentMarketplaceObservation,
  Erc8183TestnetLedger,
  ExternalComparisonSnapshot,
  FixtureJobResponse,
  FreshMarketplaceBenchmarkSlug,
  FreshMarketplaceChain,
  JobRequestMode,
  MatrixResponse,
  MarketplaceInvocationEvidence,
  ProviderCatalogResponse,
  ProviderListing,
  ProductionTrackRecord,
  ServiceId,
  SessionJob,
  SystemTelemetry,
} from "./types";

const CURRENT_HIRE_SLUG_BY_SERVICE: Record<ServiceId, FreshMarketplaceBenchmarkSlug> = {
  LENDING_RESCUE: "lending-rescue",
  LP_REBALANCE: "lp-rebalance",
  YIELD_OPTIMIZATION: "yield-optimization",
  BOUNDED_GRID: "bounded-grid",
};

const HISTORICAL_HIRE_SLUG_BY_SERVICE: Partial<Record<ServiceId, FreshMarketplaceBenchmarkSlug>> = {
  LENDING_RESCUE: "lending-rescue",
  LP_REBALANCE: "lp-rebalance",
  BOUNDED_GRID: "bounded-grid",
};

function viewFromHash(): AppView {
  const value = window.location.hash.replace("#", "");
  return value === "jobs" || value === "evidence" ? value : "marketplace";
}

async function jsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 160)}` : ""}`);
  }
  return response.json() as Promise<T>;
}

export default function App() {
  const [view, setView] = useState<AppView>(viewFromHash);
  const [selectedService, setSelectedService] = useState<ServiceId>("LENDING_RESCUE");
  const [providers, setProviders] = useState<ProviderListing[]>(() => [...PROVIDER_CATALOG]);
  const [catalogOnline, setCatalogOnline] = useState(false);
  const [matrix, setMatrix] = useState<Map<ServiceId, FixtureJobResponse>>(new Map());
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [benchmarks, setBenchmarks] = useState<BenchmarkRepeatabilityResponse[]>([]);
  const [captureManifest, setCaptureManifest] = useState<AgentCaptureManifestResponse | null>(null);
  const [marketplaceProvenance, setMarketplaceProvenance] = useState<MarketplaceInvocationEvidence | null>(null);
  const [advantagePublication, setAdvantagePublication] = useState<AgentAdvantagePublicationStatus | null>(null);
  const [founderAdvantagePublication, setFounderAdvantagePublication] = useState<FounderAgentAdvantagePublicationStatus | null>(null);
  const [founderAdvantageAtAGlance, setFounderAdvantageAtAGlance] = useState<FounderAgentAdvantageAtAGlance | null>(null);
  const [founderAdvantageAtAGlanceLoadState, setFounderAdvantageAtAGlanceLoadState] = useState<FounderAgentAdvantageAtAGlanceLoadState>("IDLE");
  const [advantagePublicationLoadState, setAdvantagePublicationLoadState] = useState<PublicationLoadState>("LOADING");
  const [founderAdvantagePublicationLoadState, setFounderAdvantagePublicationLoadState] = useState<PublicationLoadState>("LOADING");
  const [commerceLedger, setCommerceLedger] = useState<Erc8183TestnetLedger | null>(null);
  const [aacpReadiness, setAacpReadiness] = useState<AacpProductionReadiness | null>(null);
  const [productionTrackRecord, setProductionTrackRecord] = useState<ProductionTrackRecord | null>(null);
  const [forwardShadowLedger, setForwardShadowLedger] = useState<BoundedGridForwardShadowLedger | null>(null);
  const [externalComparisons, setExternalComparisons] = useState<ExternalComparisonSnapshot | null>(null);
  const [sessionJobs, setSessionJobs] = useState<SessionJob[]>([]);
  const [activeJob, setActiveJob] = useState<SessionJob | null>(null);
  const [marketplaceTrace, setMarketplaceTrace] = useState<FreshMarketplaceChain | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unresolvedFreshHire = useRef<{
    benchmarkSlug: FreshMarketplaceBenchmarkSlug;
    providerSlug: string;
    idempotencyKey: string;
    requestKey: string;
    chain?: FreshMarketplaceChain;
  } | null>(null);
  const loadedFounderAdvantageReportHash = useRef<string | null>(null);
  const provider = providers.find((candidate) => candidate.service === selectedService);
  const fixture = matrix.get(selectedService);

  async function loadRegistry() {
    setError(null);
    setCatalogOnline(false);

    const contextualLoads = [
      fetch("/api/evidence/external-comparisons/2026-08-24", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<ExternalComparisonSnapshot>(response))
        .then(setExternalComparisons),
      fetch("/api/matrix", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<MatrixResponse>(response))
        .then((payload) => setMatrix(new Map(payload.results.map((item) => [item.result.request.service, item])))),
      fetch("/api/status", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<SystemTelemetry>(response))
        .then(setTelemetry),
      fetch("/api/benchmarks/repeatability", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<BenchmarkRepeatabilityMatrixResponse>(response))
        .then((payload) => setBenchmarks(payload.records)),
      fetch("/api/benchmarks/captures", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<AgentCaptureManifestResponse>(response))
        .then(setCaptureManifest),
      fetch("/api/benchmarks/marketplace-provenance", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<MarketplaceInvocationEvidence>(response))
        .then(setMarketplaceProvenance),
      fetch("/api/commerce/erc8183", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<Erc8183TestnetLedger>(response))
        .then(setCommerceLedger),
      fetch("/api/commerce/aacp", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<AacpProductionReadiness>(response))
        .then((payload) => setAacpReadiness(payload.state === "SOURCE_UNAVAILABLE" ? null : payload)),
      fetch("/api/benchmarks/status", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then((response) => jsonResponse<AgentAdvantagePublicationStatus>(response))
        .then((publication) => {
          setAdvantagePublication(publication);
          setAdvantagePublicationLoadState("AVAILABLE");
        })
        .catch(() => {
          setAdvantagePublication(null);
          setAdvantagePublicationLoadState("UNAVAILABLE");
        }),
      fetch("/api/benchmarks/founder-comparison/status", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then((response) => jsonResponse<FounderAgentAdvantagePublicationStatus>(response))
        .then((publication) => {
          setFounderAdvantagePublication(publication);
          setFounderAdvantagePublicationLoadState("AVAILABLE");
        })
        .catch(() => {
          setFounderAdvantagePublication(null);
          setFounderAdvantagePublicationLoadState("UNAVAILABLE");
        }),
      fetch("/api/operations/production", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<ProductionTrackRecord>(response))
        .then(setProductionTrackRecord),
      fetch("/api/evidence/bounded-grid-forward-shadow", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then((response) => jsonResponse<BoundedGridForwardShadowLedger>(response))
        .then(setForwardShadowLedger),
    ];
    void Promise.allSettled(contextualLoads);

    try {
      const catalog = await fetch("/api/providers", {
        headers: { Accept: "application/json" },
      }).then((response) => jsonResponse<ProviderCatalogResponse>(response));
      setProviders(catalog.providers);
      setCatalogOnline(catalog.providers.length === 4);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Provider registry unavailable");
    }
  }

  useEffect(() => {
    void loadRegistry();
    function onHashChange() { setView(viewFromHash()); }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const completedService = activeJob?.response.result.deliverable.service;
    const shouldLoad = view === "evidence" || Boolean(
      view === "jobs" && completedService && HISTORICAL_HIRE_SLUG_BY_SERVICE[completedService],
    );
    if (!shouldLoad) return;

    if (founderAdvantagePublicationLoadState === "LOADING") {
      setFounderAdvantageAtAGlanceLoadState("LOADING");
      return;
    }
    const founderPublicationClaimsPublished = founderAdvantagePublication?.status === "PUBLISHED";
    if (!isVerifiedFounderAgentAdvantagePublication(founderAdvantagePublication)) {
      loadedFounderAdvantageReportHash.current = null;
      setFounderAdvantageAtAGlance(null);
      setFounderAdvantageAtAGlanceLoadState(
        founderPublicationClaimsPublished ||
          founderAdvantagePublicationLoadState === "UNAVAILABLE"
          ? "UNAVAILABLE"
          : "IDLE",
      );
      return;
    }
    if (loadedFounderAdvantageReportHash.current === founderAdvantagePublication.reportHash) {
      setFounderAdvantageAtAGlanceLoadState("AVAILABLE");
      return;
    }

    const controller = new AbortController();
    let active = true;
    setFounderAdvantageAtAGlance(null);
    setFounderAdvantageAtAGlanceLoadState("LOADING");
    void fetch(
      `${founderAdvantagePublication.reportUrl}founder-agent-advantage-report.json`,
      { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal },
    )
      .then((response) => jsonResponse<unknown>(response))
      .then(async (report) => {
        const projection = await projectFounderAgentAdvantageAtAGlance(
          report,
          founderAdvantagePublication,
        );
        if (!active) return;
        if (!projection) throw new Error("Founder Agent Advantage report failed projection");
        loadedFounderAdvantageReportHash.current = founderAdvantagePublication.reportHash;
        setFounderAdvantageAtAGlance(projection);
        setFounderAdvantageAtAGlanceLoadState("AVAILABLE");
      })
      .catch((loadError: unknown) => {
        if (!active || (loadError instanceof DOMException && loadError.name === "AbortError")) return;
        loadedFounderAdvantageReportHash.current = null;
        setFounderAdvantageAtAGlance(null);
        setFounderAdvantageAtAGlanceLoadState("UNAVAILABLE");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    view,
    activeJob,
    founderAdvantagePublication,
    founderAdvantagePublicationLoadState,
  ]);

  function navigate(next: AppView) {
    if (window.location.hash !== `#${next}`) window.location.hash = next;
    setView(next);
  }

  function createJob(service: ServiceId) {
    setSelectedService(service);
    setActiveJob(null);
    setMarketplaceTrace(null);
    navigate("jobs");
  }

  async function runJob(
    request: Record<string, unknown>,
    mode: JobRequestMode,
    observation?: CurrentMarketplaceObservation,
  ) {
    setLoading(true);
    setError(null);
    const startedAt = performance.now();
    try {
      const service = request.service as ServiceId;
      const currentPinnedHire = mode === "CALLER_SUPPLIED_OBSERVATIONS";
      if (currentPinnedHire && !observation) {
        throw new Error("Current marketplace hire is missing its block-pinned observation");
      }
      const benchmarkSlug = currentPinnedHire
        ? CURRENT_HIRE_SLUG_BY_SERVICE[service]
        : HISTORICAL_HIRE_SLUG_BY_SERVICE[service];
      const selectedProvider = providers.find((candidate) => candidate.service === request.service);
      const historicalFixture = mode === "FROZEN_FIXTURE";
      if (currentPinnedHire && (!benchmarkSlug || !selectedProvider)) {
        throw new Error("Current persisted hiring is unavailable for this provider");
      }
      if (historicalFixture && (!benchmarkSlug || !selectedProvider)) {
        throw new Error("Historical persisted replay is unavailable for this provider");
      }
      if ((currentPinnedHire || historicalFixture) && benchmarkSlug && selectedProvider) {
        const requestKey = currentPinnedHire
          ? JSON.stringify({ request, observation })
          : `historical-fixture:${benchmarkSlug}`;
        const pendingHire = unresolvedFreshHire.current?.benchmarkSlug === benchmarkSlug &&
            unresolvedFreshHire.current.providerSlug === selectedProvider.slug &&
            unresolvedFreshHire.current.requestKey === requestKey
          ? unresolvedFreshHire.current
          : null;
        const logicalHire = pendingHire ?? {
          benchmarkSlug,
          providerSlug: selectedProvider.slug,
          idempotencyKey: crypto.randomUUID(),
          requestKey,
        };
        unresolvedFreshHire.current = logicalHire;
        let trace = logicalHire.chain;
        if (!trace) {
          const createResponse = await fetch("/api/benchmark-hires", {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(currentPinnedHire
              ? {
                  schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
                  idempotencyKey: logicalHire.idempotencyKey,
                  benchmarkSlug,
                  providerSlug: selectedProvider.slug,
                  evidenceMode: "CURRENT_BLOCK_PINNED",
                  request,
                  observation,
                }
              : {
                  schemaVersion: "positioncrew.fresh-marketplace-hire-request.v1",
                  idempotencyKey: logicalHire.idempotencyKey,
                  benchmarkSlug,
                  providerSlug: selectedProvider.slug,
                }),
          });
          try {
            trace = await jsonResponse<FreshMarketplaceChain>(createResponse);
          } catch (createError) {
            if (createResponse.status >= 400 && createResponse.status < 500 && createResponse.status !== 429) {
              unresolvedFreshHire.current = null;
            }
            throw createError;
          }
          unresolvedFreshHire.current = { ...logicalHire, chain: trace };
        }
        if (!trace) throw new Error("Persisted marketplace hire did not return a chain");
        let activeTrace: FreshMarketplaceChain = trace;
        setMarketplaceTrace(activeTrace);
        const runResponse = await fetch("/api/benchmark-hires/" + encodeURIComponent(activeTrace.hire.hireId) + "/jobs", {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        activeTrace = await jsonResponse<FreshMarketplaceChain>(runResponse);
        unresolvedFreshHire.current = { ...logicalHire, chain: activeTrace };
        setMarketplaceTrace(activeTrace);
        for (let attempt = 0; activeTrace.job.state === "RUNNING" && attempt < 80; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          activeTrace = await fetch("/api/benchmark-hires/" + encodeURIComponent(activeTrace.hire.hireId), {
            headers: { Accept: "application/json" },
            cache: "no-store",
          }).then((response) => jsonResponse<FreshMarketplaceChain>(response));
          unresolvedFreshHire.current = { ...logicalHire, chain: activeTrace };
          setMarketplaceTrace(activeTrace);
        }
        if (activeTrace.job.state === "FAILED") {
          unresolvedFreshHire.current = null;
          throw new Error(activeTrace.job.error?.message ?? "Persisted provider job failed");
        }
        if (activeTrace.job.state !== "COMPLETED" || !activeTrace.receipt) {
          throw new Error("Persisted provider job did not complete within 20 seconds");
        }
        const sessionJob: SessionJob = {
          response: activeTrace.receipt.response,
          responseTimeMs: activeTrace.job.apiDurationMilliseconds ?? Math.max(1, Math.round(performance.now() - startedAt)),
          ranAt: activeTrace.job.completedAt ?? new Date().toISOString(),
          marketplaceTrace: activeTrace,
        };
        setActiveJob(sessionJob);
        setSessionJobs((jobs) => [sessionJob, ...jobs].slice(0, 20));
        unresolvedFreshHire.current = null;
        return;
      }
      const endpoint = providers.find((candidate) => candidate.service === request.service)?.endpoint ?? "/api/jobs";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ mode, request }),
      });
      const payload = await jsonResponse<FixtureJobResponse>(response);
      const sessionJob: SessionJob = {
        response: payload,
        responseTimeMs: Math.max(1, Math.round(performance.now() - startedAt)),
        ranAt: new Date().toISOString(),
      };
      setActiveJob(sessionJob);
      setSessionJobs((jobs) => [sessionJob, ...jobs].slice(0, 20));
    } catch (jobError) {
      setError(jobError instanceof Error ? jobError.message : "Provider job failed");
    } finally {
      setLoading(false);
    }
  }

  function selectSessionJob(job: SessionJob) {
    setSelectedService(job.response.result.request.service);
    setActiveJob(job);
    setMarketplaceTrace(job.marketplaceTrace ?? null);
    navigate("jobs");
  }

  const content = useMemo(() => {
    if (view === "jobs") {
      return (
        <JobWorkspace
          provider={provider}
          selectedService={selectedService}
          fixture={fixture}
          activeJob={activeJob}
          marketplaceTrace={marketplaceTrace}
          sessionJobs={sessionJobs}
          loading={loading}
          onRun={runJob}
          onSelectJob={selectSessionJob}
          onSelectService={(service) => {
            setSelectedService(service);
            setActiveJob(null);
            setMarketplaceTrace(null);
          }}
          telemetry={telemetry}
          benchmarks={benchmarks}
          marketplaceProvenance={marketplaceProvenance}
          advantagePublication={advantagePublication}
          founderAdvantagePublication={founderAdvantagePublication}
          founderAdvantageAtAGlance={founderAdvantageAtAGlance}
          founderAdvantageAtAGlanceLoadState={founderAdvantageAtAGlanceLoadState}
          advantagePublicationLoadState={advantagePublicationLoadState}
          founderAdvantagePublicationLoadState={founderAdvantagePublicationLoadState}
          forwardShadowLedger={forwardShadowLedger}
          onClearJobs={() => {
            setSessionJobs([]);
            setActiveJob(null);
          }}
        />
      );
    }
    if (view === "evidence") return <EvidenceView providers={providers} matrix={matrix} telemetry={telemetry} benchmarks={benchmarks} captureManifest={captureManifest} marketplaceProvenance={marketplaceProvenance} commerceLedger={commerceLedger} aacpReadiness={aacpReadiness} advantagePublication={advantagePublication} founderAdvantagePublication={founderAdvantagePublication} founderAdvantageAtAGlance={founderAdvantageAtAGlance} founderAdvantageAtAGlanceLoadState={founderAdvantageAtAGlanceLoadState} advantagePublicationLoadState={advantagePublicationLoadState} founderAdvantagePublicationLoadState={founderAdvantagePublicationLoadState} productionTrackRecord={productionTrackRecord} forwardShadowLedger={forwardShadowLedger} />;
    return (
      <MarketplaceView
        providers={providers}
        matrix={matrix}
        selectedService={selectedService}
        onSelect={setSelectedService}
        onCreateJob={createJob}
        telemetry={telemetry}
        externalComparisons={externalComparisons}
      />
    );
  }, [view, provider, fixture, activeJob, marketplaceTrace, sessionJobs, loading, providers, matrix, selectedService, telemetry, externalComparisons, benchmarks, captureManifest, marketplaceProvenance, commerceLedger, aacpReadiness, advantagePublication, founderAdvantagePublication, founderAdvantageAtAGlance, founderAdvantageAtAGlanceLoadState, advantagePublicationLoadState, founderAdvantagePublicationLoadState, productionTrackRecord, forwardShadowLedger]);

  return (
    <div className="app-shell">
      <ShellHeader
        view={view}
        onNavigate={navigate}
        apiOnline={catalogOnline && matrix.size === 4}
        jobCount={sessionJobs.length}
      />
      {error && (
        <div className="global-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={loadRegistry}><RefreshCw size={14} aria-hidden="true" /> Retry</button>
        </div>
      )}
      {content}
    </div>
  );
}
