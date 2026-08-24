import { ZodError } from "zod";
import agentCaptureManifest from "../benchmarks/agent-capture-commitments-2026-08-12.json" with { type: "json" };
import erc8183Job489Deliverable from "../evidence/erc8183-job-489.deliverable.json" with { type: "json" };
import erc8183TestnetLedger from "../evidence/erc8183-jobs.testnet.json" with { type: "json" };
import marketplaceInvocationEvidence from "../evidence/marketplace-invocations.production.json" with { type: "json" };
import productionMonitorEpoch from "../evidence/production-monitor-epoch.json" with { type: "json" };
import agentAdvantagePublicationStatus from "../web/public/evidence/agent-advantage-status.json" with { type: "json" };
import founderAgentAdvantagePublicationStatus from "../web/public/evidence/founder-agent-advantage-status.json" with { type: "json" };
import {
  runBenchmarkRepeatability,
  runCurrentBlockPinnedLendingRequest,
  runFixtureRequest,
  runFrozenFixture,
  runFrozenMatrix,
  runSuppliedLendingRequest,
  runSuppliedProviderRequest,
  runTermixBenchmarkRepeatability,
} from "../src/api/fixture-jobs.js";
import type { TermixBenchmarkService } from "../src/benchmark/lock.js";
import {
  getAacpProductionReadiness,
  unavailableAacpProductionReadiness,
  type AacpProductionReadiness,
} from "../src/commerce/aacp-production.js";
import { buildErc8183TestnetDeliverable } from "../src/commerce/erc8183-evidence.js";
import {
  FreshMarketplaceStore,
  isFreshMarketplaceCapacityExceeded,
  isFreshMarketplaceIdempotencyConflict,
  type D1Database,
} from "../src/commerce/d1-marketplace-store.js";
import {
  CurrentBlockPinnedEvidenceSchema,
  FRESH_MARKETPLACE_TASKS,
  FreshMarketplaceHireRequestSchema,
  HistoricalFixtureEvidenceSchema,
  canonicalJson,
  sha256Commitment,
  type FreshMarketplaceChain,
} from "../src/commerce/fresh-hire-schema.js";
import { PositionCrewRequestSchema } from "../src/contracts/index.js";
import { canonicalHash } from "../src/core/canonical.js";
import { PROVIDER_CATALOG } from "../src/marketplace/catalog.js";
import {
  buildMarketplaceManifest,
  buildOpenApiDocument,
  buildProviderManifest,
  getProviderBySlug,
  getSchemaDocument,
} from "../src/marketplace/discovery.js";
import {
  parseProductionTrackRecordSnapshot,
  unavailableProductionTrackRecord,
  type ProductionMonitorEpoch,
  type ProductionTrackRecord,
} from "../src/operations/production-track-record.js";
import {
  getSystemTelemetry,
  inspectPancakeGridMarket,
  inspectPancakePosition,
  inspectVenusAccount,
  inspectVenusStableYields,
} from "../src/telemetry/bsc.js";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const SERVICES = new Set([
  "LENDING_RESCUE",
  "LP_REBALANCE",
  "YIELD_OPTIMIZATION",
  "BOUNDED_GRID",
]);

type ServiceId = "LENDING_RESCUE" | "LP_REBALANCE" | "YIELD_OPTIMIZATION" | "BOUNDED_GRID";

const PROVIDER_SLUGS = new Map<string, ServiceId>(
  PROVIDER_CATALOG.map((provider) => [provider.slug, provider.service]),
);

const BENCHMARK_SLUGS = new Map<string, TermixBenchmarkService>([
  ["lending-rescue", "LENDING_RESCUE"],
  ["lp-rebalance", "LP_REBALANCE"],
  ["bounded-grid", "BOUNDED_GRID"],
]);

const MONITOR_EPOCH = productionMonitorEpoch as ProductionMonitorEpoch;
let productionRecordCache: { expiresAt: number; record: ProductionTrackRecord } | null = null;
let productionRecordRequest: Promise<ProductionTrackRecord> | null = null;
let aacpReadinessCache: { expiresAt: number; record: AacpProductionReadiness } | null = null;
let aacpReadinessRequest: Promise<AacpProductionReadiness> | null = null;
const AACP_READINESS_RESPONSE_BUDGET_MS = 8_000;

const API_HEADERS = {
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

const CANONICAL_PRODUCT_ORIGIN = "https://positioncrew.dolepee.com";
const MAX_FRESH_MARKETPLACE_REQUEST_BYTES = 32_768;

function isAllowedMutationOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null) return true;
  if (origin === new URL(request.url).origin || origin === CANONICAL_PRODUCT_ORIGIN) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  } catch {
    return false;
  }
}

function withApiCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("Origin");
  if (request.method === "GET" || request.method === "HEAD") {
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (origin !== null && isAllowedMutationOrigin(request)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(body: unknown, status = 200, cacheControl = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...API_HEADERS, "Cache-Control": cacheControl },
  });
}

function apiError(status: number, error: string, details: unknown): Response {
  return json({ schemaVersion: "positioncrew.api-error.v1", error, details }, status);
}

class FreshMarketplaceRequestError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: "INVALID_JSON" | "REQUEST_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "FreshMarketplaceRequestError";
  }
}

async function boundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FRESH_MARKETPLACE_REQUEST_BYTES) {
    throw new FreshMarketplaceRequestError(
      413,
      "REQUEST_TOO_LARGE",
      `Fresh marketplace request exceeds ${MAX_FRESH_MARKETPLACE_REQUEST_BYTES} bytes`,
    );
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_FRESH_MARKETPLACE_REQUEST_BYTES) {
    throw new FreshMarketplaceRequestError(
      413,
      "REQUEST_TOO_LARGE",
      `Fresh marketplace request exceeds ${MAX_FRESH_MARKETPLACE_REQUEST_BYTES} bytes`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FreshMarketplaceRequestError(
      400,
      "INVALID_JSON",
      "Fresh marketplace request body must be valid JSON",
    );
  }
}

function freshStore(env: Env): FreshMarketplaceStore {
  if (!env.DB) throw new Error("Fresh marketplace persistence is unavailable");
  return new FreshMarketplaceStore(env.DB);
}

async function freshMarketplaceRateLimitKey(request: Request): Promise<string> {
  const connectingIp = request.headers.get("CF-Connecting-IP")?.trim();
  return sha256Commitment({
    schemaVersion: "positioncrew.fresh-marketplace-rate-limit-key.v1",
    client: connectingIp && connectingIp.length > 0
      ? `cf-ip:${connectingIp}`
      : `direct-host:${new URL(request.url).hostname}`,
  });
}

async function createFreshMarketplaceHire(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", ["Use POST."]);
  const parsed = FreshMarketplaceHireRequestSchema.parse(await boundedJson(request));
  const task = FRESH_MARKETPLACE_TASKS[parsed.benchmarkSlug];
  const provider = getProviderBySlug(parsed.providerSlug);
  if (!provider || provider.service !== task.service || provider.requestSchema !== task.requestSchema) {
    return apiError(409, "FROZEN_PROVIDER_BINDING_MISMATCH", [
      "The selected provider is not bound to this frozen benchmark task.",
    ]);
  }
  const createdAt = new Date().toISOString();
  const currentBlockPinned = parsed.schemaVersion === "positioncrew.fresh-marketplace-hire-request.v2";
  const persistedRequest = currentBlockPinned
    ? parsed.request
    : {
        schemaVersion: "positioncrew.fresh-marketplace-provider-request.v1",
        benchmarkSlug: parsed.benchmarkSlug,
        providerSlug: parsed.providerSlug,
        providerId: provider.providerId,
        requestSchema: task.requestSchema,
        evidenceMode: "HISTORICAL_FIXTURE",
        directCostUsd: "0.00",
        walletRequired: false,
      };
  const evidenceMode = currentBlockPinned ? "CURRENT_BLOCK_PINNED" : "HISTORICAL_FIXTURE";
  const evidence = currentBlockPinned
    ? CurrentBlockPinnedEvidenceSchema.parse({
        schemaVersion: "positioncrew.current-block-pinned-evidence.v1",
        evidenceClass: "CURRENT_BLOCK_PINNED",
        chainId: 56,
        source: parsed.observation,
        freshnessAtCreation: Date.parse(parsed.observation.observedAt) > Date.parse(createdAt)
          ? "FUTURE_DATED"
          : Date.parse(createdAt) - Date.parse(parsed.observation.observedAt) >
              parsed.request.maxDataAgeSeconds * 1_000
            ? "STALE"
            : "FRESH",
        evaluatedAt: createdAt,
        maxDataAgeSeconds: parsed.request.maxDataAgeSeconds,
      })
    : HistoricalFixtureEvidenceSchema.parse({
        schemaVersion: "positioncrew.historical-fixture-evidence.v1",
        evidenceClass: "HISTORICAL_FIXTURE",
        benchmarkSlug: parsed.benchmarkSlug,
        requestSchema: task.requestSchema,
      });
  const providerBinding = {
    providerSlug: parsed.providerSlug,
    providerId: provider.providerId,
    service: task.service,
    requestSchema: task.requestSchema,
  };
  const requestJson = canonicalJson(persistedRequest);
  const result = await freshStore(env).createHire({
    request: parsed,
    providerId: provider.providerId,
    hireId: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    createdAt,
    requestJson,
    requestHash: currentBlockPinned
      ? canonicalHash(persistedRequest)
      : await sha256Commitment(persistedRequest),
    providerHash: await sha256Commitment(providerBinding),
    evidenceMode,
    evidenceJson: canonicalJson(evidence),
    evidenceHash: await sha256Commitment(evidence),
    service: task.service,
    rateLimitKey: await freshMarketplaceRateLimitKey(request),
  });
  return json(result.chain, result.replayed ? 200 : 201);
}

async function finishFreshMarketplaceJob(
  env: Env,
  hireId: string,
  jobId: string,
  claimToken: string,
  hire: FreshMarketplaceChain["hire"],
  executionStartedAt: string,
  startedAtPerformance: number,
): Promise<void> {
  const store = freshStore(env);
  try {
    const task = FRESH_MARKETPLACE_TASKS[hire.benchmarkSlug];
    const response = hire.evidenceMode === "CURRENT_BLOCK_PINNED"
      ? await runCurrentBlockPinnedLendingRequest(hire.request, new Date(executionStartedAt))
      : await runFrozenFixture(task.service);
    if (
      response.result.request.service !== task.service ||
      response.result.job.state !== "COMPLETED" ||
      response.result.job.deliverable === null
    ) {
      throw new Error("Frozen provider response was not a completed result for the persisted service");
    }
    if (
      hire.evidenceMode === "CURRENT_BLOCK_PINNED" &&
      (response.evidenceMode !== "CURRENT_BLOCK_PINNED" ||
        canonicalHash(response.result.request) !== hire.requestHash)
    ) {
      throw new Error("Current provider response did not match the persisted request commitment");
    }
    const deliverable = response.result.job.deliverable;
    const responseJson = canonicalJson(response);
    await store.completeJob({
      hireId,
      jobId,
      claimToken,
      receiptId: crypto.randomUUID(),
      responseJson,
      responseHash: await sha256Commitment(response),
      deliverableHash: deliverable.deliverableHash,
      evaluationHash: response.result.evaluation.evaluationHash,
      completedAt: new Date().toISOString(),
      apiDurationMilliseconds: Math.max(1, Math.round(performance.now() - startedAtPerformance)),
    });
  } catch (error) {
    await store.failJob(
      hireId,
      jobId,
      claimToken,
      new Date().toISOString(),
      Math.max(1, Math.round(performance.now() - startedAtPerformance)),
      "PROVIDER_EXECUTION_FAILED",
      error instanceof Error ? error.message.slice(0, 500) : "Unknown provider failure",
    );
  }
}

async function runFreshMarketplaceHire(
  request: Request,
  env: Env,
  context: WorkerExecutionContext,
  hireId: string,
): Promise<Response> {
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", ["Use POST."]);
  const startedAtPerformance = performance.now();
  const store = freshStore(env);
  const claimed = await store.claimJob(hireId, new Date().toISOString());
  if (!claimed.chain) return apiError(404, "HIRE_NOT_FOUND", ["Unknown persisted hire ID."]);
  if (!claimed.claimed) return json(claimed.chain, claimed.chain.job.state === "RUNNING" ? 202 : 200);
  if (!claimed.claimToken) throw new Error("Claimed fresh marketplace job did not return a claim token");
  if (!claimed.chain.job.startedAt || claimed.chain.job.startedAt !== claimed.claimToken) {
    throw new Error("Claimed fresh marketplace job did not persist its execution timestamp");
  }
  context.waitUntil(finishFreshMarketplaceJob(
    env,
    hireId,
    claimed.chain.job.jobId,
    claimed.claimToken,
    claimed.chain.hire,
    claimed.chain.job.startedAt,
    startedAtPerformance,
  ));
  return json(claimed.chain, 202);
}

async function getFreshMarketplaceHire(request: Request, env: Env, hireId: string): Promise<Response> {
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
  const chain = await freshStore(env).getHire(hireId);
  return chain ? json(chain) : apiError(404, "HIRE_NOT_FOUND", ["Unknown persisted hire ID."]);
}

async function getFreshMarketplaceReceipt(
  request: Request,
  env: Env,
  receiptId: string,
): Promise<Response> {
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
  const chain = await freshStore(env).getReceipt(receiptId);
  return chain
    ? json(chain, 200, "public, max-age=3600, s-maxage=86400, immutable")
    : apiError(404, "RECEIPT_NOT_FOUND", ["Unknown persisted receipt ID."]);
}

async function jobs(request: Request, url: URL): Promise<Response> {
  if (request.method === "GET") {
    const service = url.searchParams.get("service");
    if (!service || !SERVICES.has(service)) {
      return apiError(400, "INVALID_SERVICE", [
        "service must name one of the four PositionCrew providers",
      ]);
    }
    return json(
      await runFrozenFixture(
        service as "LENDING_RESCUE" | "LP_REBALANCE" | "YIELD_OPTIMIZATION" | "BOUNDED_GRID",
      ),
    );
  }

  if (request.method === "POST") {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || !("request" in body)) {
      return apiError(422, "INVALID_JOB_REQUEST", ["body.request is required"]);
    }
    const parsed = PositionCrewRequestSchema.parse(body.request);
    if ("mode" in body && body.mode === "FROZEN_FIXTURE") {
      return json(await runFixtureRequest(parsed));
    }
    if (!("mode" in body) || body.mode === "CALLER_SUPPLIED_OBSERVATIONS") {
      return json(await runSuppliedProviderRequest(parsed));
    }
    return apiError(422, "INVALID_EVIDENCE_MODE", [
      "mode must be FROZEN_FIXTURE or CALLER_SUPPLIED_OBSERVATIONS",
    ]);
  }

  return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET or POST."]);
}

async function providerJobs(request: Request, service: ServiceId): Promise<Response> {
  if (request.method === "GET") return json(await runFrozenFixture(service));
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET or POST."]);

  const body: unknown = await request.json();
  if (typeof body !== "object" || body === null || !("request" in body)) {
    return apiError(422, "INVALID_JOB_REQUEST", ["body.request is required"]);
  }
  const parsed = PositionCrewRequestSchema.parse(body.request);
  if (parsed.service !== service) {
    return apiError(409, "PROVIDER_SERVICE_MISMATCH", [
      `This provider accepts ${service} requests, not ${parsed.service}.`,
    ]);
  }
  if ("mode" in body && body.mode === "FROZEN_FIXTURE") {
    return json(await runFixtureRequest(parsed));
  }
  if (!("mode" in body) || body.mode === "CALLER_SUPPLIED_OBSERVATIONS") {
    return json(await runSuppliedProviderRequest(parsed));
  }
  return apiError(422, "INVALID_EVIDENCE_MODE", [
    "mode must be FROZEN_FIXTURE or CALLER_SUPPLIED_OBSERVATIONS",
  ]);
}

async function providerHealth(service: ServiceId): Promise<Response> {
  const startedAt = performance.now();
  const response = await runFrozenFixture(service);
  const provider = PROVIDER_CATALOG.find((candidate) => candidate.service === service);
  return json(
    {
      schemaVersion: "positioncrew.provider-health.v1",
      checkedAt: new Date().toISOString(),
      status: response.result.evaluation.passed ? "OPERATIONAL" : "DEGRADED",
      service,
      providerId: provider?.providerId,
      endpoint: provider?.endpoint,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      conformance: {
        score: response.result.evaluation.score,
        evaluationHash: response.result.evaluation.evaluationHash,
        receiptPath: response.receipt.path,
      },
    },
    200,
    "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
  );
}

async function publicReceipt(hash: string): Promise<Response> {
  const matrix = await runFrozenMatrix();
  const response = matrix.find(
    (candidate) => candidate.result.evaluation.evaluationHash.toLowerCase() === hash.toLowerCase(),
  );
  if (!response) return apiError(404, "RECEIPT_NOT_FOUND", ["No public fixture receipt matches this hash."]);
  return json(
    {
      schemaVersion: "positioncrew.public-receipt.v1",
      publishedAt: response.generatedAt,
      receiptHash: response.result.evaluation.evaluationHash,
      claimBoundary: response.claimBoundary,
      request: response.result.request,
      deliverable: response.result.deliverable,
      job: response.result.job,
      evaluation: response.result.evaluation,
    },
    200,
    "public, max-age=3600, s-maxage=86400, immutable",
  );
}

async function loadProductionTrackRecord(): Promise<ProductionTrackRecord> {
  if (productionRecordCache && productionRecordCache.expiresAt > Date.now()) {
    return productionRecordCache.record;
  }
  if (productionRecordRequest) return productionRecordRequest;
  productionRecordRequest = (async () => {
    let record: ProductionTrackRecord;
    let ttlMs: number;
    try {
      const snapshotUrl = new URL(MONITOR_EPOCH.workflow.snapshotUrl);
      snapshotUrl.searchParams.set("epoch_window", String(Math.floor(Date.now() / 300_000)));
      const response = await fetch(snapshotUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "PositionCrew-Production-Record/1.0",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Production record snapshot returned HTTP ${response.status}`);
      record = parseProductionTrackRecordSnapshot(await response.json(), MONITOR_EPOCH);
      ttlMs = 5 * 60_000;
    } catch {
      record = unavailableProductionTrackRecord(MONITOR_EPOCH);
      ttlMs = 60_000;
    }
    productionRecordCache = { expiresAt: Date.now() + ttlMs, record };
    return record;
  })();
  try {
    return await productionRecordRequest;
  } finally {
    productionRecordRequest = null;
  }
}

async function productionTrackRecord(): Promise<Response> {
  const record = await loadProductionTrackRecord();
  if (record.status !== "SOURCE_UNAVAILABLE") {
    return json(record, 200, "public, max-age=0, s-maxage=300, stale-while-revalidate=900");
  }
  return json(record, 200, "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
}

async function loadAacpReadiness(): Promise<AacpProductionReadiness> {
  if (aacpReadinessCache && aacpReadinessCache.expiresAt > Date.now()) {
    return aacpReadinessCache.record;
  }
  if (aacpReadinessRequest) return aacpReadinessRequest;
  aacpReadinessRequest = (async () => {
    let record: AacpProductionReadiness;
    let ttlMs: number;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      record = await Promise.race([
        getAacpProductionReadiness(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("AACP readiness exceeded its response budget")),
            AACP_READINESS_RESPONSE_BUDGET_MS,
          );
        }),
      ]);
      ttlMs = record.state.includes("DEGRADED") ? 60_000 : 5 * 60_000;
    } catch {
      record = unavailableAacpProductionReadiness();
      ttlMs = 60_000;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    aacpReadinessCache = { expiresAt: Date.now() + ttlMs, record };
    return record;
  })();
  try {
    return await aacpReadinessRequest;
  } finally {
    aacpReadinessRequest = null;
  }
}

async function aacpReadiness(): Promise<Response> {
  const record = await loadAacpReadiness();
  const cacheControl = record.state === "SOURCE_UNAVAILABLE" || record.state.includes("DEGRADED")
    ? "public, max-age=0, s-maxage=60, stale-while-revalidate=300"
    : "public, max-age=0, s-maxage=300, stale-while-revalidate=900";
  return json(record, 200, cacheControl);
}

async function rescue(request: Request): Promise<Response> {
  if (request.method === "GET") return json(await runFrozenFixture("LENDING_RESCUE"));

  if (request.method === "POST") {
    const body: unknown = await request.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "mode" in body &&
      body.mode === "FROZEN_FIXTURE" &&
      "request" in body
    ) {
      return json(await runFixtureRequest(body.request));
    }
    if (
      typeof body === "object" &&
      body !== null &&
      "mode" in body &&
      body.mode === "CALLER_SUPPLIED_OBSERVATIONS" &&
      "request" in body
    ) {
      return json(await runSuppliedProviderRequest(body.request));
    }
    return json(await runSuppliedLendingRequest(body));
  }

  return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET or POST."]);
}

async function api(
  request: Request,
  url: URL,
  env: Env,
  context: WorkerExecutionContext,
): Promise<Response> {
  const mutationOrPreflight = request.method === "OPTIONS" ||
    request.method === "POST" || request.method === "PUT" ||
    request.method === "PATCH" || request.method === "DELETE";
  if (mutationOrPreflight && !isAllowedMutationOrigin(request)) {
    return apiError(403, "ORIGIN_NOT_ALLOWED", ["Mutation origin is not permitted."]);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: API_HEADERS });

  try {
    if (url.pathname === "/.well-known/positioncrew.json") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        buildMarketplaceManifest(url.origin),
        200,
        "public, max-age=0, s-maxage=300",
      );
    }

    if (url.pathname === "/openapi.json") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(buildOpenApiDocument(url.origin), 200, "public, max-age=0, s-maxage=300");
    }

    if (url.pathname === "/api/providers") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        {
          schemaVersion: "positioncrew.provider-catalog-response.v1",
          generatedAt: new Date().toISOString(),
          commerceAdapter: "AACP_PRODUCTION_RUNTIME_PENDING",
          providers: PROVIDER_CATALOG,
        },
        200,
        "public, max-age=0, s-maxage=300",
      );
    }

    if (url.pathname === "/api/benchmark-hires") {
      return await createFreshMarketplaceHire(request, env);
    }

    const freshHireJobRoute = url.pathname.match(
      /^\/api\/benchmark-hires\/([0-9a-f-]{36})\/jobs$/,
    );
    if (freshHireJobRoute) {
      return runFreshMarketplaceHire(request, env, context, freshHireJobRoute[1]!);
    }

    const freshHireRoute = url.pathname.match(/^\/api\/benchmark-hires\/([0-9a-f-]{36})$/);
    if (freshHireRoute) return getFreshMarketplaceHire(request, env, freshHireRoute[1]!);

    const freshReceiptRoute = url.pathname.match(
      /^\/api\/benchmark-receipts\/([0-9a-f-]{36})$/,
    );
    if (freshReceiptRoute) {
      return getFreshMarketplaceReceipt(request, env, freshReceiptRoute[1]!);
    }

    if (url.pathname === "/api/status") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        await getSystemTelemetry(),
        200,
        "public, max-age=0, s-maxage=15, stale-while-revalidate=30",
      );
    }

    if (url.pathname === "/api/operations/production") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return productionTrackRecord();
    }

    if (url.pathname === "/api/benchmarks/status") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        agentAdvantagePublicationStatus,
        200,
        "public, max-age=0, s-maxage=300",
      );
    }

    if (url.pathname === "/api/benchmarks/founder-comparison/status") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        founderAgentAdvantagePublicationStatus,
        200,
        "public, max-age=0, s-maxage=300",
      );
    }

    if (url.pathname === "/api/benchmarks/repeatability") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(await runTermixBenchmarkRepeatability());
    }

    if (url.pathname === "/api/benchmarks/captures") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(agentCaptureManifest, 200, "public, max-age=0, s-maxage=300");
    }

    if (url.pathname === "/api/benchmarks/marketplace-provenance") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        marketplaceInvocationEvidence,
        200,
        "public, max-age=3600, s-maxage=86400, immutable",
      );
    }

    if (url.pathname === "/api/commerce/erc8183/jobs/489/deliverable") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        erc8183Job489Deliverable,
        200,
        "public, max-age=3600, s-maxage=86400, immutable",
      );
    }

    if (url.pathname === "/api/commerce/erc8183") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        erc8183TestnetLedger,
        200,
        "public, max-age=3600, s-maxage=86400, immutable",
      );
    }

    if (url.pathname === "/api/commerce/aacp") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return aacpReadiness();
    }

    const erc8183DeliverableRoute = url.pathname.match(
      /^\/api\/commerce\/erc8183\/jobs\/(\d+)\/deliverable$/,
    );
    if (erc8183DeliverableRoute) {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      const deliverable = await buildErc8183TestnetDeliverable(
        Number.parseInt(erc8183DeliverableRoute[1]!, 10),
      );
      if (!deliverable) {
        return apiError(404, "ERC8183_DELIVERABLE_NOT_FOUND", ["Unknown testnet job ID."]);
      }
      return json(deliverable, 200, "public, max-age=3600, s-maxage=86400, immutable");
    }

    const benchmarkRoute = url.pathname.match(
      /^\/api\/benchmarks\/([^/]+)\/repeatability$/,
    );
    if (benchmarkRoute) {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      const service = BENCHMARK_SLUGS.get(benchmarkRoute[1]!);
      if (!service) return apiError(404, "BENCHMARK_NOT_FOUND", ["Unknown benchmark slug."]);
      return json(await runBenchmarkRepeatability(service));
    }

    const providerRoute = url.pathname.match(
      /^\/api\/providers\/([^/]+)\/(health|jobs)$/,
    );
    if (providerRoute) {
      const service = PROVIDER_SLUGS.get(providerRoute[1]!);
      if (!service) return apiError(404, "PROVIDER_NOT_FOUND", ["Unknown provider slug."]);
      if (providerRoute[2] === "health") {
        if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
        return providerHealth(service);
      }
      return providerJobs(request, service);
    }

    const providerManifestRoute = url.pathname.match(/^\/api\/providers\/([^/]+)\/manifest$/);
    if (providerManifestRoute) {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      const provider = getProviderBySlug(providerManifestRoute[1]!);
      if (!provider) return apiError(404, "PROVIDER_NOT_FOUND", ["Unknown provider slug."]);
      return json(
        buildProviderManifest(provider, url.origin),
        200,
        "public, max-age=0, s-maxage=300",
      );
    }

    const schemaRoute = url.pathname.match(/^\/api\/schemas\/([^/]+)$/);
    if (schemaRoute) {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      const schema = getSchemaDocument(decodeURIComponent(schemaRoute[1]!));
      if (!schema) return apiError(404, "SCHEMA_NOT_FOUND", ["Unknown schema identifier."]);
      return json(schema, 200, "public, max-age=3600, s-maxage=86400, immutable");
    }

    const receiptRoute = url.pathname.match(/^\/api\/receipts\/(sha256:[0-9a-fA-F]{64})$/);
    if (receiptRoute) {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return publicReceipt(receiptRoute[1]!);
    }

    const venusAccountRoute = url.pathname.match(/^\/api\/wallets\/(0x[0-9a-fA-F]{40})\/venus$/);
    if (venusAccountRoute) {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        await inspectVenusAccount(venusAccountRoute[1]!),
        200,
        "public, max-age=0, s-maxage=10, stale-while-revalidate=20",
      );
    }

    const pancakePositionRoute = url.pathname.match(/^\/api\/positions\/pancake\/(\d+)$/);
    if (pancakePositionRoute) {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        await inspectPancakePosition(pancakePositionRoute[1]!),
        200,
        "public, max-age=0, s-maxage=10, stale-while-revalidate=20",
      );
    }

    if (url.pathname === "/api/markets/pancake/wbnb-usdt/grid") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        await inspectPancakeGridMarket(),
        200,
        "public, max-age=0, s-maxage=10, stale-while-revalidate=20",
      );
    }

    if (url.pathname === "/api/markets/venus/stable-yields") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        await inspectVenusStableYields(),
        200,
        "public, max-age=0, s-maxage=10, stale-while-revalidate=20",
      );
    }

    if (url.pathname === "/api/matrix") {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(
        {
          schemaVersion: "positioncrew.provider-matrix-response.v1",
          results: await runFrozenMatrix(),
        },
        200,
        "public, max-age=0, s-maxage=300",
      );
    }

    if (url.pathname === "/api/jobs") return jobs(request, url);
    if (url.pathname === "/api/rescue") return rescue(request);
    return apiError(404, "NOT_FOUND", ["Unknown PositionCrew API route."]);
  } catch (error) {
    if (isFreshMarketplaceCapacityExceeded(error)) {
      return apiError(429, "HIRE_CAPACITY_EXCEEDED", [error.message]);
    }
    if (error instanceof FreshMarketplaceRequestError) {
      return apiError(error.status, error.code, [error.message]);
    }
    if (isFreshMarketplaceIdempotencyConflict(error)) {
      return apiError(409, "IDEMPOTENCY_CONFLICT", [error.message]);
    }
    if (error instanceof ZodError) {
      return apiError(
        422,
        "INVALID_JOB_REQUEST",
        error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      );
    }
    return apiError(500, "REQUEST_FAILED", [
      error instanceof Error ? error.message : "Unknown error",
    ]);
  }
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, context: WorkerExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname === "/openapi.json" ||
      url.pathname === "/.well-known/positioncrew.json"
    ) {
      return withApiCors(await api(request, url, env, context), request);
    }

    const appView = new Map([
      ["/marketplace", "marketplace"],
      ["/jobs", "jobs"],
      ["/evidence", "evidence"],
    ]).get(url.pathname.replace(/\/$/, ""));
    if (appView && (request.method === "GET" || request.method === "HEAD")) {
      const destination = new URL("/", url);
      destination.search = url.search;
      destination.hash = appView;
      return Response.redirect(destination, 308);
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
