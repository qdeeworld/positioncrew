import {
  rememberRecentJobOnDevice,
  sessionJobFromFreshChain,
  validatedFreshMarketplaceChain,
} from "./job-history";
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

type ResourceLoadState = "LOADING" | "AVAILABLE" | "UNAVAILABLE";

const CONTEXT_REQUEST_TIMEOUT_MS = 12_000;
const JOB_REQUEST_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = CONTEXT_REQUEST_TIMEOUT_MS,
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
    if (timedOut) throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1_000)} seconds`);
    throw requestError;
  } finally {
    window.clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

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
  if (value === "evidence") return "evidence";
  return value === "jobs" || value.startsWith("jobs/receipt/") ? "jobs" : "marketplace";
}

function receiptIdFromHash(): string | null {
  return window.location.hash.match(/^#jobs\/receipt\/([0-9a-f-]{36})$/i)?.[1] ?? null;
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
  const [catalogLoadState, setCatalogLoadState] = useState<ResourceLoadState>("LOADING");
  const [matrixLoadState, setMatrixLoadState] = useState<ResourceLoadState>("LOADING");
  const [telemetryLoadState, setTelemetryLoadState] = useState<ResourceLoadState>("LOADING");
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
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const registryLoadController = useRef<AbortController | null>(null);
  const jobRunController = useRef<AbortController | null>(null);
  const receiptLoadController = useRef<AbortController | null>(null);
  const jobRunId = useRef(0);
  const previousView = useRef(view);
  const unresolvedFreshHire = useRef<{
    benchmarkSlug: FreshMarketplaceBenchmarkSlug;
    providerSlug: string;
    idempotencyKey: string;
    requestKey: string;
    chain?: FreshMarketplaceChain;
  } | null>(null);
  const loadedFounderAdvantageCommitment = useRef<{
    reportHash: string;
    evidenceManifestHash: string;
  } | null>(null);
  const provider = providers.find((candidate) => candidate.service === selectedService);
  const fixture = matrix.get(selectedService);

  async function loadRegistry() {
    registryLoadController.current?.abort();
    const controller = new AbortController();
    registryLoadController.current = controller;
    const registryFetch = (input: RequestInfo | URL, init: RequestInit = {}) =>
      fetchWithTimeout(input, { ...init, signal: controller.signal });

    setRegistryError(null);
    setCatalogOnline(false);
    setCatalogLoadState("LOADING");
    setMatrixLoadState("LOADING");
    setTelemetryLoadState("LOADING");
    setMatrix(new Map());
    setTelemetry(null);

    const contextualLoads = [
      registryFetch("/api/evidence/external-comparisons/2026-08-24", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<ExternalComparisonSnapshot>(response))
        .then(setExternalComparisons),
      registryFetch("/api/matrix", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<MatrixResponse>(response))
        .then((payload) => {
          setMatrix(new Map(payload.results.map((item) => [item.result.request.service, item])));
          setMatrixLoadState("AVAILABLE");
        })
        .catch((loadError) => {
          if (!controller.signal.aborted) setMatrixLoadState("UNAVAILABLE");
          throw loadError;
        }),
      registryFetch("/api/status", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<SystemTelemetry>(response))
        .then((payload) => {
          setTelemetry(payload);
          setTelemetryLoadState("AVAILABLE");
        })
        .catch((loadError) => {
          if (!controller.signal.aborted) setTelemetryLoadState("UNAVAILABLE");
          throw loadError;
        }),
      registryFetch("/api/benchmarks/repeatability", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<BenchmarkRepeatabilityMatrixResponse>(response))
        .then((payload) => setBenchmarks(payload.records)),
      registryFetch("/api/benchmarks/captures", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<AgentCaptureManifestResponse>(response))
        .then(setCaptureManifest),
      registryFetch("/api/benchmarks/marketplace-provenance", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<MarketplaceInvocationEvidence>(response))
        .then(setMarketplaceProvenance),
      registryFetch("/api/commerce/erc8183", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<Erc8183TestnetLedger>(response))
        .then(setCommerceLedger),
      registryFetch("/api/commerce/aacp", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<AacpProductionReadiness>(response))
        .then((payload) => setAacpReadiness(payload.state === "SOURCE_UNAVAILABLE" ? null : payload)),
      registryFetch("/api/benchmarks/status", {
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
      registryFetch("/api/benchmarks/founder-comparison/status", {
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
      registryFetch("/api/operations/production", { headers: { Accept: "application/json" } })
        .then((response) => jsonResponse<ProductionTrackRecord>(response))
        .then(setProductionTrackRecord),
      registryFetch("/api/evidence/bounded-grid-forward-shadow", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then((response) => jsonResponse<BoundedGridForwardShadowLedger>(response))
        .then(setForwardShadowLedger),
    ];
    void Promise.allSettled(contextualLoads);

    try {
      const catalog = await registryFetch("/api/providers", {
        headers: { Accept: "application/json" },
      }).then((response) => jsonResponse<ProviderCatalogResponse>(response));
      if (controller.signal.aborted) return;
      setProviders(catalog.providers);
      setCatalogOnline(catalog.providers.length === 4);
      setCatalogLoadState("AVAILABLE");
    } catch (loadError) {
      if (controller.signal.aborted) return;
      setCatalogLoadState("UNAVAILABLE");
      setRegistryError(loadError instanceof Error ? loadError.message : "Provider registry unavailable");
    }
  }

  useEffect(() => {
    void loadRegistry();
    void loadPublicReceiptFromHash();
    function onHashChange() {
      const nextView = viewFromHash();
      if (nextView !== "jobs") {
        cancelJobRun();
        cancelPublicReceiptLoad();
      }
      setView(nextView);
      void loadPublicReceiptFromHash();
    }
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      registryLoadController.current?.abort();
      jobRunController.current?.abort();
      receiptLoadController.current?.abort();
      jobRunId.current += 1;
    };
  }, []);

  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    window.requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  }, [view]);

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
      loadedFounderAdvantageCommitment.current = null;
      setFounderAdvantageAtAGlance(null);
      setFounderAdvantageAtAGlanceLoadState(
        founderPublicationClaimsPublished ||
          founderAdvantagePublicationLoadState === "UNAVAILABLE"
          ? "UNAVAILABLE"
          : "IDLE",
      );
      return;
    }
    if (
      loadedFounderAdvantageCommitment.current?.reportHash === founderAdvantagePublication.reportHash &&
      loadedFounderAdvantageCommitment.current.evidenceManifestHash === founderAdvantagePublication.evidenceManifestHash
    ) {
      setFounderAdvantageAtAGlanceLoadState("AVAILABLE");
      return;
    }

    const controller = new AbortController();
    let active = true;
    setFounderAdvantageAtAGlance(null);
    setFounderAdvantageAtAGlanceLoadState("LOADING");
    void fetchWithTimeout(
      `${founderAdvantagePublication.reportUrl}founder-agent-advantage-report.json`,
      { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal },
      CONTEXT_REQUEST_TIMEOUT_MS,
    )
      .then((response) => jsonResponse<unknown>(response))
      .then(async (report) => {
        const projection = await projectFounderAgentAdvantageAtAGlance(
          report,
          founderAdvantagePublication,
        );
        if (!active) return;
        if (!projection) throw new Error("Founder Agent Advantage report failed projection");
        loadedFounderAdvantageCommitment.current = {
          reportHash: founderAdvantagePublication.reportHash,
          evidenceManifestHash: founderAdvantagePublication.evidenceManifestHash,
        };
        setFounderAdvantageAtAGlance(projection);
        setFounderAdvantageAtAGlanceLoadState("AVAILABLE");
      })
      .catch((loadError: unknown) => {
        if (!active || (loadError instanceof DOMException && loadError.name === "AbortError")) return;
        loadedFounderAdvantageCommitment.current = null;
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

  function cancelJobRun() {
    if (!jobRunController.current) return;
    jobRunId.current += 1;
    jobRunController.current.abort();
    jobRunController.current = null;
    setLoading(false);
  }

  function cancelPublicReceiptLoad() {
    receiptLoadController.current?.abort();
    receiptLoadController.current = null;
    setReceiptLoading(false);
    setReceiptError(null);
  }

  async function loadPublicReceiptFromHash() {
    const receiptId = receiptIdFromHash();
    if (!receiptId) {
      cancelPublicReceiptLoad();
      return;
    }

    cancelJobRun();
    receiptLoadController.current?.abort();
    const controller = new AbortController();
    receiptLoadController.current = controller;
    setReceiptLoading(true);
    setReceiptError(null);
    setJobError(null);
    try {
      const response = await fetchWithTimeout(
        `/api/benchmark-receipts/${encodeURIComponent(receiptId)}`,
        { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal },
        JOB_REQUEST_TIMEOUT_MS,
      );
      const chain = await validatedFreshMarketplaceChain(await jsonResponse<unknown>(response));
      if (!chain || chain.receipt?.receiptId !== receiptId) {
        throw new Error("Receipt failed PositionCrew chain validation");
      }
      const sessionJob = sessionJobFromFreshChain(chain);
      if (!sessionJob) throw new Error("Receipt does not contain a completed provider result");
      if (controller.signal.aborted) return;
      setSelectedService(sessionJob.response.result.request.service);
      setActiveJob(sessionJob);
      setMarketplaceTrace(chain);
      setSessionJobs((jobs) => [
        sessionJob,
        ...jobs.filter((job) => job.marketplaceTrace?.receipt?.receiptId !== receiptId),
      ].slice(0, 20));
    } catch (receiptError) {
      if (controller.signal.aborted) return;
      setActiveJob(null);
      setMarketplaceTrace(null);
      setReceiptError(receiptError instanceof Error ? receiptError.message : "Receipt unavailable");
    } finally {
      if (receiptLoadController.current === controller) {
        receiptLoadController.current = null;
        setReceiptLoading(false);
      }
    }
  }

  function navigate(next: AppView) {
    if (next !== "jobs") {
      cancelJobRun();
      cancelPublicReceiptLoad();
    }
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
    if (receiptIdFromHash()) navigate("jobs");
    jobRunController.current?.abort();
    const controller = new AbortController();
    const runId = ++jobRunId.current;
    jobRunController.current = controller;
    const isCurrentRun = () => jobRunId.current === runId && !controller.signal.aborted;
    const assertCurrentRun = () => {
      if (!isCurrentRun()) throw new DOMException("Stale job operation", "AbortError");
    };
    setLoading(true);
    setJobError(null);
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
      const serverOwnedLendingAudition = currentPinnedHire && service === "LENDING_RESCUE";
      const providerSelectionKey = serverOwnedLendingAudition
        ? "server-owned:lending-provider-audition"
        : selectedProvider?.slug ?? "";
      const historicalFixture = mode === "FROZEN_FIXTURE";
      if (currentPinnedHire && (!benchmarkSlug || (!serverOwnedLendingAudition && !selectedProvider))) {
        throw new Error("Current persisted hiring is unavailable for this provider");
      }
      if (historicalFixture && (!benchmarkSlug || !selectedProvider)) {
        throw new Error("Historical persisted replay is unavailable for this provider");
      }
      if (
        (currentPinnedHire || historicalFixture) &&
        benchmarkSlug &&
        (serverOwnedLendingAudition || selectedProvider)
      ) {
        const requestKey = currentPinnedHire
          ? JSON.stringify({ request, observation })
          : `historical-fixture:${benchmarkSlug}`;
        const pendingHire = unresolvedFreshHire.current?.benchmarkSlug === benchmarkSlug &&
            unresolvedFreshHire.current.providerSlug === providerSelectionKey &&
            unresolvedFreshHire.current.requestKey === requestKey
          ? unresolvedFreshHire.current
          : null;
        const logicalHire = pendingHire ?? {
          benchmarkSlug,
          providerSlug: providerSelectionKey,
          idempotencyKey: crypto.randomUUID(),
          requestKey,
        };
        unresolvedFreshHire.current = logicalHire;
        let trace = logicalHire.chain;
        if (!trace) {
          const createResponse = await fetchWithTimeout(
            serverOwnedLendingAudition
              ? "/api/provider-auditions/lending/hires"
              : "/api/benchmark-hires",
            {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify(serverOwnedLendingAudition
              ? {
                  schemaVersion: "positioncrew.lending-provider-audition-hire-request.v1",
                  idempotencyKey: logicalHire.idempotencyKey,
                  evidenceMode: "CURRENT_BLOCK_PINNED",
                  request,
                  observation,
                }
              : currentPinnedHire
              ? {
                  schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
                  idempotencyKey: logicalHire.idempotencyKey,
                  benchmarkSlug,
                  providerSlug: selectedProvider!.slug,
                  evidenceMode: "CURRENT_BLOCK_PINNED",
                  request,
                  observation,
                }
              : {
                  schemaVersion: "positioncrew.fresh-marketplace-hire-request.v1",
                  idempotencyKey: logicalHire.idempotencyKey,
                  benchmarkSlug,
                  providerSlug: selectedProvider!.slug,
                }),
            },
            JOB_REQUEST_TIMEOUT_MS,
          );
          assertCurrentRun();
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
        assertCurrentRun();
        setMarketplaceTrace(activeTrace);
        rememberRecentJobOnDevice({
          hireId: activeTrace.hire.hireId,
          service: activeTrace.hire.service,
          rememberedAt: activeTrace.hire.createdAt,
        });
        if (activeTrace.job.state === "CREATED") {
          const runResponse = await fetchWithTimeout("/api/benchmark-hires/" + encodeURIComponent(activeTrace.hire.hireId) + "/jobs", {
            method: "POST",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          }, JOB_REQUEST_TIMEOUT_MS);
          activeTrace = await jsonResponse<FreshMarketplaceChain>(runResponse);
          assertCurrentRun();
          unresolvedFreshHire.current = { ...logicalHire, chain: activeTrace };
          setMarketplaceTrace(activeTrace);
        }
        const pollingDeadline = Date.now() + 20_000;
        for (let attempt = 0; activeTrace.job.state === "RUNNING" && attempt < 80 && Date.now() < pollingDeadline; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          assertCurrentRun();
          const remainingMs = Math.max(250, pollingDeadline - Date.now());
          activeTrace = await fetchWithTimeout("/api/benchmark-hires/" + encodeURIComponent(activeTrace.hire.hireId), {
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          }, Math.min(4_000, remainingMs)).then((response) => jsonResponse<FreshMarketplaceChain>(response));
          assertCurrentRun();
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
        assertCurrentRun();
        setActiveJob(sessionJob);
        setSessionJobs((jobs) => [sessionJob, ...jobs].slice(0, 20));
        unresolvedFreshHire.current = null;
        return;
      }
      const endpoint = providers.find((candidate) => candidate.service === request.service)?.endpoint ?? "/api/jobs";
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ mode, request }),
        signal: controller.signal,
      }, JOB_REQUEST_TIMEOUT_MS);
      const payload = await jsonResponse<FixtureJobResponse>(response);
      const sessionJob: SessionJob = {
        response: payload,
        responseTimeMs: Math.max(1, Math.round(performance.now() - startedAt)),
        ranAt: new Date().toISOString(),
      };
      assertCurrentRun();
      setActiveJob(sessionJob);
      setSessionJobs((jobs) => [sessionJob, ...jobs].slice(0, 20));
    } catch (jobError) {
      if (!isCurrentRun()) return;
      setJobError(jobError instanceof Error ? jobError.message : "Provider job failed");
    } finally {
      if (isCurrentRun()) {
        setLoading(false);
        jobRunController.current = null;
      }
    }
  }

  function selectSessionJob(job: SessionJob) {
    cancelJobRun();
    setJobError(null);
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
          loading={loading || receiptLoading}
          jobError={jobError}
          onRun={runJob}
          onSelectJob={selectSessionJob}
          onSelectService={(service) => {
            if (loading || receiptLoading) return;
            if (receiptIdFromHash()) navigate("jobs");
            setSelectedService(service);
            setActiveJob(null);
            setMarketplaceTrace(null);
            setJobError(null);
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
        telemetryLoadState={telemetryLoadState}
        matrixLoadState={matrixLoadState}
        catalogLoadState={catalogLoadState}
        onRetryStatus={() => void loadRegistry()}
      />
    );
  }, [view, provider, fixture, activeJob, marketplaceTrace, sessionJobs, loading, receiptLoading, jobError, providers, matrix, selectedService, telemetry, telemetryLoadState, matrixLoadState, catalogLoadState, externalComparisons, benchmarks, captureManifest, marketplaceProvenance, commerceLedger, aacpReadiness, advantagePublication, founderAdvantagePublication, founderAdvantageAtAGlance, founderAdvantageAtAGlanceLoadState, advantagePublicationLoadState, founderAdvantagePublicationLoadState, productionTrackRecord, forwardShadowLedger]);

  const apiState = catalogLoadState === "UNAVAILABLE" || matrixLoadState === "UNAVAILABLE"
    ? "unavailable"
    : catalogOnline && matrix.size === 4
      ? "online"
      : "loading";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <ShellHeader
        view={view}
        onNavigate={navigate}
        apiState={apiState}
        jobCount={sessionJobs.length}
      />
      {registryError && (
        <div className="global-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{registryError}</span>
          <button type="button" onClick={loadRegistry}><RefreshCw size={14} aria-hidden="true" /> Retry registry</button>
        </div>
      )}
      {receiptError && receiptIdFromHash() && (
        <div className="global-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Readable receipt unavailable: {receiptError}</span>
          <button type="button" onClick={() => void loadPublicReceiptFromHash()}>
            <RefreshCw size={14} aria-hidden="true" /> Retry receipt
          </button>
        </div>
      )}
      <div id="main-content" tabIndex={-1}>{content}</div>
    </div>
  );
}
