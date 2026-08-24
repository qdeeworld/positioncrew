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
  runCurrentBlockPinnedProviderRequest,
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
  FreshMarketplaceChainSchema,
  FreshMarketplaceHireRequestSchema,
  HistoricalFixtureEvidenceSchema,
  canonicalJson,
  sha256Commitment,
  type FreshMarketplaceChain,
} from "../src/commerce/fresh-hire-schema.js";
import {
  VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE,
  VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE_ROUTE,
} from "../src/commerce/venus-testnet-native-supply-publication.js";
import { PositionCrewRequestSchema } from "../src/contracts/index.js";
import {
  BoundedGridDeliverableSchema,
  BoundedGridRequestSchema,
} from "../src/contracts/bounded-grid.js";
import { canonicalHash } from "../src/core/canonical.js";
import { PROVIDER_CATALOG } from "../src/marketplace/catalog.js";
import {
  EXTERNAL_COMPARISON_SNAPSHOT,
  EXTERNAL_COMPARISON_SNAPSHOT_ROUTE,
} from "../src/marketplace/external-comparisons.js";
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
  SHADOW_GRID_HORIZON_MINUTES,
  SHADOW_GRID_PUBLIC_CLAIM_BOUNDARY,
  bindingFromShadowGridRun,
  calculateShadowGridTerminal,
  createShadowGridEvent,
  deriveShadowGridFills,
  parseShadowGridEvent,
  precommitFromShadowGridRun,
  publicShadowGridWindow,
  shadowGridRunIsTerminal,
  shadowGridRunState,
  summarizeShadowGridRuns,
  verifyShadowGridRun,
  type ShadowGridPriceSample,
  type ShadowGridRunBinding,
  type ShadowGridScheduleEvidence,
} from "../src/operations/bounded-grid-forward-shadow.js";
import {
  ShadowGridLedgerStore,
  ensureShadowGridAppendOnlyGuards,
  type ShadowGridEvent,
} from "../src/operations/shadow-grid-store.js";
import {
  getSystemTelemetry,
  inspectPancakeGridMarket,
  inspectPancakeGridPriceSample,
  inspectPancakePosition,
  inspectVenusAccount,
  inspectVenusStableYields,
  verifyPancakeGridPriceSample,
} from "../src/telemetry/bsc.js";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
  SHADOW_GRID_TICK_TOKEN?: string;
  SHADOW_GRID_TEST_NOW?: string;
  SHADOW_GRID_TEST_CHECKPOINT_NOW?: string;
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
const SHADOW_GRID_WORKFLOW_PATH = ".github/workflows/production-smoke.yml";
// Temporary rollout allowlist: remove this legacy path/ref after queued pre-cutover runs expire.
const SHADOW_GRID_LEGACY_WORKFLOW_PATH = ".github/workflows/bounded-grid-shadow-ledger.yml";
const SHADOW_GRID_EXPECTED_RUN_HEADER = "X-PositionCrew-Shadow-Run-Id";
const SHADOW_GRID_RUN_ID_PATTERN = /^bg-\d{8}-\d{2}$/;
const SHADOW_GRID_ABANDONED_CLEANUP_LIMIT = 50;
const SHADOW_GRID_SAMPLE_GRACE_MILLISECONDS = 3 * 60_000;
const SHADOW_GRID_SAMPLE_EARLY_TOLERANCE_MILLISECONDS = 90_000;
const SHADOW_GRID_OPENING_CUTOFF_MINUTE = 44;
const SHADOW_GRID_SOURCE_RETRY_DELAYS_MILLISECONDS = [0, 3_000, 9_000] as const;

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

function shadowGridStore(env: Env): ShadowGridLedgerStore {
  if (!env.DB) throw new Error("Shadow-grid persistence is unavailable");
  return new ShadowGridLedgerStore(env.DB);
}

function shadowGridRunId(date: Date): string {
  const iso = date.toISOString();
  return `bg-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 13)}`;
}

async function deterministicUuid(seed: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  ).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function constantTimeTokenMatch(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

async function retryShadowGridSource<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown = new Error("Shadow-grid source operation was not attempted");
  for (const delay of SHADOW_GRID_SOURCE_RETRY_DELAYS_MILLISECONDS) {
    if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function shadowGridCollectorNow(request: Request, env: Env): Date {
  const hostname = new URL(request.url).hostname;
  if (
    env.SHADOW_GRID_TEST_NOW &&
    (hostname === "127.0.0.1" || hostname === "localhost")
  ) {
    const testNow = new Date(env.SHADOW_GRID_TEST_NOW);
    if (!Number.isFinite(testNow.getTime())) throw new Error("Invalid loopback shadow-grid test clock");
    return testNow;
  }
  return new Date();
}

function shadowGridCollectorCheckpointNow(request: Request, env: Env): Date {
  const hostname = new URL(request.url).hostname;
  const testNow = env.SHADOW_GRID_TEST_CHECKPOINT_NOW ?? env.SHADOW_GRID_TEST_NOW;
  if (testNow && (hostname === "127.0.0.1" || hostname === "localhost")) {
    const checkpointNow = new Date(testNow);
    if (!Number.isFinite(checkpointNow.getTime())) {
      throw new Error("Invalid loopback shadow-grid checkpoint clock");
    }
    return checkpointNow;
  }
  return new Date();
}

function scheduleEvidence(request: Request, now: Date): ShadowGridScheduleEvidence {
  const event = request.headers.get("X-GitHub-Event");
  const repository = request.headers.get("X-GitHub-Repository");
  const runId = request.headers.get("X-GitHub-Run-Id");
  const runAttempt = request.headers.get("X-GitHub-Run-Attempt");
  const headSha = request.headers.get("X-GitHub-Sha");
  const workflowRef = request.headers.get("X-GitHub-Workflow-Ref");
  const currentWorkflowRef =
    `dolepee/positioncrew/${SHADOW_GRID_WORKFLOW_PATH}@refs/heads/main`;
  const legacyWorkflowRef =
    `dolepee/positioncrew/${SHADOW_GRID_LEGACY_WORKFLOW_PATH}@refs/heads/main`;
  const workflowPath = workflowRef === currentWorkflowRef
    ? SHADOW_GRID_WORKFLOW_PATH
    : workflowRef === legacyWorkflowRef
      ? SHADOW_GRID_LEGACY_WORKFLOW_PATH
      : null;
  if (
    event !== "schedule" ||
    repository !== "dolepee/positioncrew" ||
    !runId || !/^\d+$/.test(runId) ||
    runAttempt !== "1" ||
    !headSha || !/^[a-f0-9]{40}$/i.test(headSha) ||
    workflowPath === null
  ) {
    throw new FreshMarketplaceRequestError(
      400,
      "INVALID_JSON",
      "Shadow-grid collection requires the fixed GitHub scheduled-workflow identity",
    );
  }
  return {
    event: "schedule",
    repository: "dolepee/positioncrew",
    workflowPath,
    runId,
    runAttempt,
    headSha: headSha.toLowerCase(),
    workflowRef: workflowPath === SHADOW_GRID_WORKFLOW_PATH
      ? currentWorkflowRef
      : legacyWorkflowRef,
    recordedAt: now.toISOString(),
  };
}

async function waitForFreshMarketplaceTerminal(env: Env, hireId: string): Promise<FreshMarketplaceChain> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const chain = await freshStore(env).getHire(hireId);
    if (!chain) throw new Error("Shadow-grid source hire disappeared");
    if (chain.job.state === "COMPLETED" && chain.receipt) return chain;
    if (chain.job.state === "FAILED") throw new Error(chain.job.error?.message ?? "Shadow-grid source hire failed");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Shadow-grid source hire did not reach a terminal state");
}

async function createCurrentGridHireForShadowRun(
  env: Env,
  runId: string,
): Promise<FreshMarketplaceChain> {
  const namespaceSecret = env.SHADOW_GRID_TICK_TOKEN;
  if (!namespaceSecret) throw new Error("Shadow-grid scheduler credential is unavailable");
  const idempotencyKey = await deterministicUuid(
    `positioncrew:shadow-grid-source:v2:${runId}:${namespaceSecret}`,
  );
  const existingReference = await env.DB.prepare(
    "SELECT hire_id FROM fresh_marketplace_hires WHERE idempotency_key = ? LIMIT 1",
  ).bind(idempotencyKey).first<{ hire_id: string }>();
  let chain = existingReference
    ? await freshStore(env).getHire(existingReference.hire_id)
    : null;

  if (!chain) {
    const probe = await retryShadowGridSource(() => inspectPancakeGridMarket());
    const internalRequest = new Request(`${CANONICAL_PRODUCT_ORIGIN}/api/benchmark-hires`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: CANONICAL_PRODUCT_ORIGIN },
      body: JSON.stringify({
        schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
        idempotencyKey,
        benchmarkSlug: "bounded-grid",
        providerSlug: "bounded-grid",
        evidenceMode: "CURRENT_BLOCK_PINNED",
        observation: {
          blockNumber: probe.source.blockNumber,
          observedAt: probe.source.blockTimestamp,
          explorerUrl: probe.source.explorerUrl,
        },
        request: probe.gridRequest,
      }),
    });
    const createdResponse = await createFreshMarketplaceHire(internalRequest, env);
    if (!createdResponse.ok) {
      throw new Error(`Shadow-grid source hire creation returned HTTP ${createdResponse.status}`);
    }
    chain = FreshMarketplaceChainSchema.parse(await createdResponse.json());
  }

  if (chain.job.state === "CREATED") {
    const started = performance.now();
    const claimed = await freshStore(env).claimJob(chain.hire.hireId, new Date().toISOString());
    if (claimed.claimed && claimed.claimToken && claimed.chain?.job.startedAt) {
      await finishFreshMarketplaceJob(
        env,
        chain.hire.hireId,
        chain.job.jobId,
        claimed.claimToken,
        chain.hire,
        claimed.chain.job.startedAt,
        started,
      );
    }
    chain = await waitForFreshMarketplaceTerminal(env, chain.hire.hireId);
  } else if (chain.job.state === "RUNNING") {
    chain = await waitForFreshMarketplaceTerminal(env, chain.hire.hireId);
  } else if (chain.job.state === "FAILED") {
    throw new Error(chain.job.error?.message ?? "Shadow-grid source hire failed");
  }
  if (
    chain.hire.evidenceMode !== "CURRENT_BLOCK_PINNED" ||
    chain.hire.service !== "BOUNDED_GRID" ||
    !chain.hire.providerHash || !chain.hire.evidenceHash || !chain.receipt
  ) {
    throw new Error("Shadow-grid source hire is not an exact completed current Bounded Grid receipt");
  }
  return chain;
}

function gridReceiptPayload(chain: FreshMarketplaceChain) {
  if (!chain.receipt) throw new Error("Shadow-grid source hire has no receipt");
  const request = BoundedGridRequestSchema.parse(chain.hire.request);
  const response = chain.receipt.response;
  if (typeof response !== "object" || response === null || !("result" in response)) {
    throw new Error("Shadow-grid source receipt has no provider result");
  }
  const result = (response as { result?: unknown }).result;
  if (typeof result !== "object" || result === null || !("deliverable" in result)) {
    throw new Error("Shadow-grid source receipt has no deliverable");
  }
  const deliverable = BoundedGridDeliverableSchema.parse(
    (result as { deliverable?: unknown }).deliverable,
  );
  return { request, deliverable };
}

async function appendShadowGridRunEvent(
  store: ShadowGridLedgerStore,
  events: readonly ShadowGridEvent[],
  input: {
    eventType: Parameters<typeof createShadowGridEvent>[0]["eventType"];
    recordedAt: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<readonly ShadowGridEvent[]> {
  const event = createShadowGridEvent({
    binding: bindingFromShadowGridRun(events),
    previous: events.at(-1) ?? null,
    ...input,
  });
  const persisted = await store.appendEvent(event);
  return [...events, persisted.event];
}

type StoredShadowGridScheduleEvidence = Omit<ShadowGridScheduleEvidence, "workflowPath"> & {
  workflowPath: typeof SHADOW_GRID_WORKFLOW_PATH | typeof SHADOW_GRID_LEGACY_WORKFLOW_PATH;
};

function isShadowGridRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function storedScheduleFromShadowGridGenesis(
  events: readonly ShadowGridEvent[],
): StoredShadowGridScheduleEvidence {
  const genesis = events[0];
  if (!genesis || genesis.eventType !== "EPOCH_STARTED") {
    throw new Error("Shadow-grid initialization requires an EPOCH_STARTED event");
  }
  const payload = parseShadowGridEvent(genesis).payload;
  const schedule = payload.schedule;
  if (
    !isShadowGridRecord(schedule) ||
    schedule.event !== "schedule" ||
    schedule.repository !== "dolepee/positioncrew" ||
    (schedule.workflowPath !== SHADOW_GRID_WORKFLOW_PATH &&
      schedule.workflowPath !== SHADOW_GRID_LEGACY_WORKFLOW_PATH) ||
    typeof schedule.runId !== "string" ||
    !/^\d+$/.test(schedule.runId) ||
    schedule.runAttempt !== "1" ||
    typeof schedule.headSha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(schedule.headSha) ||
    typeof schedule.workflowRef !== "string" ||
    typeof schedule.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(schedule.recordedAt))
  ) {
    throw new Error("Shadow-grid genesis has no valid scheduled-workflow evidence");
  }
  return {
    event: "schedule",
    repository: "dolepee/positioncrew",
    workflowPath: schedule.workflowPath,
    runId: schedule.runId,
    runAttempt: "1",
    headSha: schedule.headSha,
    workflowRef: schedule.workflowRef,
    recordedAt: schedule.recordedAt,
  };
}

function scheduleFromShadowGridGenesis(
  events: readonly ShadowGridEvent[],
): ShadowGridScheduleEvidence {
  const schedule = storedScheduleFromShadowGridGenesis(events);
  if (
    schedule.workflowRef !==
      `dolepee/positioncrew/${schedule.workflowPath}@refs/heads/main`
  ) {
    throw new Error("Shadow-grid genesis has no rollout-allowed scheduled-workflow evidence");
  }
  return schedule;
}

function cleanupScheduleFromShadowGridGenesis(
  events: readonly ShadowGridEvent[],
): StoredShadowGridScheduleEvidence {
  const schedule = storedScheduleFromShadowGridGenesis(events);
  if (
    schedule.workflowRef !==
      `dolepee/positioncrew/${schedule.workflowPath}@refs/heads/main`
  ) {
    throw new Error("Shadow-grid cleanup genesis has no recognized scheduled-workflow provenance");
  }
  return schedule;
}

function assertShadowGridScheduleBinding(
  events: readonly ShadowGridEvent[],
  incoming: ShadowGridScheduleEvidence,
): void {
  const committed = scheduleFromShadowGridGenesis(events);
  if (
    committed.event !== incoming.event ||
    committed.repository !== incoming.repository ||
    committed.workflowPath !== incoming.workflowPath ||
    committed.runId !== incoming.runId ||
    committed.runAttempt !== incoming.runAttempt ||
    committed.headSha !== incoming.headSha ||
    committed.workflowRef !== incoming.workflowRef
  ) {
    throw new FreshMarketplaceRequestError(
      400,
      "INVALID_JSON",
      "Shadow-grid tick identity does not match the originating scheduled workflow",
    );
  }
}

function assertShadowGridHireBinding(
  events: readonly ShadowGridEvent[],
  chain: FreshMarketplaceChain,
): void {
  const binding = bindingFromShadowGridRun(events);
  const receipt = chain.receipt;
  if (
    !receipt ||
    chain.job.state !== "COMPLETED" ||
    chain.hire.hireId !== binding.hireId ||
    receipt.receiptId !== binding.receiptId ||
    chain.hire.requestHash !== binding.requestHash ||
    chain.hire.providerHash !== binding.providerHash ||
    chain.hire.evidenceHash !== binding.evidenceHash ||
    receipt.responseHash !== binding.responseHash ||
    receipt.deliverableHash !== binding.deliverableHash ||
    receipt.evaluationHash !== binding.evaluationHash
  ) {
    throw new Error("Shadow-grid initialization does not match its completed source receipt");
  }
}

async function resumeShadowGridInitialization(
  env: Env,
  eventsInput: readonly ShadowGridEvent[],
): Promise<readonly ShadowGridEvent[]> {
  if (eventsInput.length === 0 || shadowGridRunIsTerminal(eventsInput)) return eventsInput;
  verifyShadowGridRun(eventsInput);
  const store = shadowGridStore(env);
  let events = eventsInput;
  let precommit = events.find((event) => event.eventType === "PRECOMMITTED")
    ? precommitFromShadowGridRun(events)
    : null;

  if (!precommit) {
    if (events.length !== 1 || events[0]!.eventType !== "EPOCH_STARTED") {
      throw new Error("Shadow-grid run stopped before its immutable precommitment");
    }
    const chain = await freshStore(env).getHire(events[0]!.hireId);
    if (!chain) throw new Error("Shadow-grid initialization source hire disappeared");
    assertShadowGridHireBinding(events, chain);
    const { request, deliverable } = gridReceiptPayload(chain);
    const receipt = chain.receipt!;
    precommit = {
      schedule: scheduleFromShadowGridGenesis(events),
      sourceHireId: chain.hire.hireId,
      sourceReceiptId: receipt.receiptId,
      sourceReceiptUrl: receipt.publicUrl,
      sourceRequestHash: chain.hire.requestHash,
      sourceBlockNumber: chain.hire.evidence?.evidenceClass === "CURRENT_BLOCK_PINNED"
        ? chain.hire.evidence.source.blockNumber
        : request.requestId.replace("pancake-grid-", ""),
      sourceBlockTimestamp: request.marketState.observedAt,
      request,
      deliverable,
    };
    events = await appendShadowGridRunEvent(store, events, {
      eventType: "PRECOMMITTED",
      recordedAt: receipt.createdAt,
      idempotencyKey: `${events[0]!.runId}:precommit`,
      payload: precommit as unknown as Record<string, unknown>,
    });
  }

  if (
    precommit.deliverable.status !== "ACTIONABLE" ||
    precommit.deliverable.decision !== "BUILD_GRID"
  ) {
    events = await appendShadowGridRunEvent(store, events, {
      eventType: "REFUSED",
      recordedAt: new Date(
        Math.max(Date.now(), Date.parse(events.at(-1)!.recordedAt) + 1),
      ).toISOString(),
      idempotencyKey: `${events[0]!.runId}:terminal`,
      payload: {
        status: precommit.deliverable.status,
        decision: precommit.deliverable.decision,
        reason: precommit.deliverable.summary,
        netOutcomeUsd: null,
        outcome: null,
      },
    });
  }
  return events;
}

async function startShadowGridRun(
  env: Env,
  runId: string,
  schedule: ShadowGridScheduleEvidence,
  collectorRequest: Request,
  openingDeadline: number,
): Promise<
  | { state: "STARTED"; events: readonly ShadowGridEvent[] }
  | { state: "LATE_START_SKIPPED"; recordedAt: Date }
> {
  const store = shadowGridStore(env);
  const existing = await store.getRun(runId);
  if (existing.length > 0) return { state: "STARTED", events: existing };
  const chain = await createCurrentGridHireForShadowRun(env, runId);
  const { request, deliverable } = gridReceiptPayload(chain);
  const receipt = chain.receipt!;
  const epochStartedAt = chain.hire.createdAt;
  const binding: ShadowGridRunBinding = {
    runId,
    epochStartedAt,
    horizonEndsAt: new Date(Date.parse(epochStartedAt) + SHADOW_GRID_HORIZON_MINUTES * 60_000).toISOString(),
    hireId: chain.hire.hireId,
    receiptId: receipt.receiptId,
    requestHash: chain.hire.requestHash,
    providerHash: chain.hire.providerHash!,
    evidenceHash: chain.hire.evidenceHash!,
    responseHash: receipt.responseHash,
    deliverableHash: receipt.deliverableHash,
    evaluationHash: receipt.evaluationHash,
  };
  const genesis = createShadowGridEvent({
    binding,
    previous: null,
    eventType: "EPOCH_STARTED",
    recordedAt: epochStartedAt,
    idempotencyKey: `${runId}:epoch`,
    payload: {
      schedule,
      method: "FORWARD_ONLY_ACTUAL_SAMPLES",
      sampleCadenceMinutes: 5,
      horizonMinutes: 15,
      backfill: "PROHIBITED",
      capitalMode: "ZERO_FUND_SHADOW",
    },
  });
  const persistenceCheckpoint = shadowGridCollectorCheckpointNow(collectorRequest, env);
  if (persistenceCheckpoint.getTime() >= openingDeadline) {
    return { state: "LATE_START_SKIPPED", recordedAt: persistenceCheckpoint };
  }
  const persistedGenesis = await store.appendEvent(genesis);
  let events: readonly ShadowGridEvent[] = [persistedGenesis.event];
  const precommitPayload = {
    schedule,
    sourceHireId: chain.hire.hireId,
    sourceReceiptId: receipt.receiptId,
    sourceReceiptUrl: receipt.publicUrl,
    sourceRequestHash: chain.hire.requestHash,
    sourceBlockNumber: chain.hire.evidence?.evidenceClass === "CURRENT_BLOCK_PINNED"
      ? chain.hire.evidence.source.blockNumber
      : request.requestId.replace("pancake-grid-", ""),
    sourceBlockTimestamp: request.marketState.observedAt,
    request,
    deliverable,
  };
  events = await appendShadowGridRunEvent(store, events, {
    eventType: "PRECOMMITTED",
    recordedAt: receipt.createdAt,
    idempotencyKey: `${runId}:precommit`,
    payload: precommitPayload,
  });
  if (deliverable.status !== "ACTIONABLE" || deliverable.decision !== "BUILD_GRID") {
    events = await appendShadowGridRunEvent(store, events, {
      eventType: "REFUSED",
      recordedAt: new Date(Math.max(Date.now(), Date.parse(receipt.createdAt) + 1)).toISOString(),
      idempotencyKey: `${runId}:terminal`,
      payload: {
        status: deliverable.status,
        decision: deliverable.decision,
        reason: deliverable.summary,
        netOutcomeUsd: null,
        outcome: null,
      },
    });
  }
  return { state: "STARTED", events };
}

async function voidShadowGridRun(
  store: ShadowGridLedgerStore,
  events: readonly ShadowGridEvent[],
  now: Date,
  reason: string,
): Promise<readonly ShadowGridEvent[]> {
  if (shadowGridRunIsTerminal(events)) return events;
  return appendShadowGridRunEvent(store, events, {
    eventType: "VOID_SOURCE_GAP",
    recordedAt: now.toISOString(),
    idempotencyKey: `${events[0]!.runId}:terminal`,
    payload: {
      reason,
      observedSampleCount: events.filter((event) => event.eventType === "OBSERVED").length,
      netOutcomeUsd: null,
      outcome: null,
      repairedLater: false,
    },
  });
}

async function processOpenShadowGridRun(
  env: Env,
  eventsInput: readonly ShadowGridEvent[],
  now: Date,
  request: Request,
): Promise<readonly ShadowGridEvent[]> {
  if (eventsInput.length === 0 || shadowGridRunIsTerminal(eventsInput)) return eventsInput;
  let events = await resumeShadowGridInitialization(env, eventsInput);
  if (shadowGridRunIsTerminal(events)) return events;
  verifyShadowGridRun(events);
  const store = shadowGridStore(env);
  const precommit = precommitFromShadowGridRun(events);
  const samples = events.filter((event) => event.eventType === "OBSERVED");
  const nextDue = Date.parse(events[0]!.epochStartedAt) + (samples.length + 1) * 5 * 60_000;
  const horizon = Date.parse(events[0]!.horizonEndsAt);
  if (now.getTime() > horizon + SHADOW_GRID_SAMPLE_GRACE_MILLISECONDS || now.getTime() > nextDue + SHADOW_GRID_SAMPLE_GRACE_MILLISECONDS) {
    return voidShadowGridRun(store, events, now, "A required forward sample was not recorded inside its fixed grace window");
  }
  if (now.getTime() < nextDue - SHADOW_GRID_SAMPLE_EARLY_TOLERANCE_MILLISECONDS) {
    return events;
  }

  let sample: ShadowGridPriceSample;
  try {
    sample = await retryShadowGridSource(() => inspectPancakeGridPriceSample());
  } catch (error) {
    return voidShadowGridRun(
      store,
      events,
      new Date(),
      `The live block-pinned sample was unavailable: ${error instanceof Error ? error.message.slice(0, 240) : "unknown source failure"}`,
    );
  }
  const sampleCompletedAt = shadowGridCollectorCheckpointNow(request, env);
  const sampledAt = Date.parse(sample.sampledAt);
  const sampleDeadline = Math.min(nextDue, horizon) + SHADOW_GRID_SAMPLE_GRACE_MILLISECONDS;
  if (
    !Number.isFinite(sampledAt) ||
    Math.max(sampledAt, sampleCompletedAt.getTime()) > sampleDeadline
  ) {
    return voidShadowGridRun(
      store,
      events,
      sampleCompletedAt,
      "The actual forward sample completed outside its fixed grace window",
    );
  }
  const priorSamples = events.filter((event) => event.eventType === "OBSERVED")
    .map((event) => parseShadowGridEvent(event).payload as unknown as ShadowGridPriceSample);
  if (
    Date.parse(sample.source.blockTimestamp) <= Date.parse(precommit.sourceBlockTimestamp) ||
    (priorSamples.at(-1) && BigInt(sample.source.blockNumber) <= BigInt(priorSamples.at(-1)!.source.blockNumber))
  ) {
    return voidShadowGridRun(store, events, now, "The next actual sample did not advance beyond the committed source block");
  }
  const fills = deriveShadowGridFills(events, sample);
  events = await appendShadowGridRunEvent(store, events, {
    eventType: "OBSERVED",
    recordedAt: sample.sampledAt,
    idempotencyKey: `${events[0]!.runId}:observed:${sample.source.blockHash.toLowerCase()}`,
    payload: sample as unknown as Record<string, unknown>,
  });
  for (const fill of fills) {
    events = await appendShadowGridRunEvent(store, events, {
      eventType: "SHADOW_FILL",
      recordedAt: sample.sampledAt,
      idempotencyKey: `${events[0]!.runId}:fill:${fill.orderIndex}`,
      payload: fill,
    });
  }
  const terminal = calculateShadowGridTerminal(events, sample);
  const terminalEvaluationTime = new Date();
  const reachedHorizon = terminalEvaluationTime.getTime() >=
    horizon - SHADOW_GRID_SAMPLE_EARLY_TOLERANCE_MILLISECONDS;
  if (!terminal.riskExit && !reachedHorizon) return events;
  const retainedSamples = events.filter((event) => event.eventType === "OBSERVED")
    .map((event) => parseShadowGridEvent(event).payload as unknown as ShadowGridPriceSample);
  if (!terminal.riskExit && retainedSamples.length < 3) {
    return voidShadowGridRun(store, events, now, "The 15-minute horizon ended without all three actual forward samples");
  }
  try {
    await retryShadowGridSource(async () => {
      for (const retained of retainedSamples) await verifyPancakeGridPriceSample(retained);
    });
  } catch (error) {
    return voidShadowGridRun(
      store,
      events,
      new Date(),
      `A retained source block failed identity revalidation: ${error instanceof Error ? error.message.slice(0, 240) : "unknown block failure"}`,
    );
  }
  return appendShadowGridRunEvent(store, events, {
    eventType: terminal.riskExit ? "RISK_EXIT" : "CLOSED",
    recordedAt: new Date().toISOString(),
    idempotencyKey: `${events[0]!.runId}:terminal`,
    payload: terminal,
  });
}

async function collectShadowGridTick(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", ["Use POST."]);
  if (url.search !== "") return apiError(400, "CALLER_INPUT_PROHIBITED", ["Collector epochs and samples are server-derived."]);
  if ((request.headers.get("Content-Length") ?? "0") !== "0") {
    return apiError(400, "CALLER_INPUT_PROHIBITED", ["Collector request bodies are prohibited."]);
  }
  const expectedToken = env.SHADOW_GRID_TICK_TOKEN;
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expectedToken || !supplied || !(await constantTimeTokenMatch(supplied, expectedToken))) {
    return apiError(401, "UNAUTHORIZED", ["A valid scheduler credential is required."]);
  }
  const expectedRunId = request.headers.get(SHADOW_GRID_EXPECTED_RUN_HEADER);
  if (expectedRunId !== null && !SHADOW_GRID_RUN_ID_PATTERN.test(expectedRunId)) {
    throw new FreshMarketplaceRequestError(
      400,
      "INVALID_JSON",
      "Shadow-grid follow-up run ID must match bg-YYYYMMDD-HH",
    );
  }
  await ensureShadowGridAppendOnlyGuards(env.DB);
  const now = shadowGridCollectorNow(request, env);
  const schedule = scheduleEvidence(request, now);
  const currentHour = new Date(now);
  currentHour.setUTCMinutes(0, 0, 0);
  const currentRunId = shadowGridRunId(currentHour);
  const openingDeadline = currentHour.getTime() + SHADOW_GRID_OPENING_CUTOFF_MINUTE * 60_000;
  const previousHour = new Date(currentHour.getTime() - 60 * 60_000);
  const store = shadowGridStore(env);
  let previousHourCleanup: {
    runId: string;
    status: "NOT_REQUIRED" | "PROCESSED" | "FAILED";
    error: string | null;
  } = {
    runId: shadowGridRunId(previousHour),
    status: "NOT_REQUIRED",
    error: null,
  };
  const abandonedRunCleanup: {
    status: "SKIPPED_EXPECTED_RUN" | "NOT_REQUIRED" | "PROCESSED" | "PARTIAL" | "FAILED";
    batchLimit: number;
    candidateCount: number;
    examinedCount: number;
    voidedCount: number;
    failedCount: number;
    deferredNonExpiredCount: number;
    currentRunExcludedCount: number;
    alreadyTerminalCount: number;
    batchLimitReached: boolean;
    truncated: boolean;
    failures: Array<{ runId: string | null; error: string }>;
  } = {
    status: expectedRunId === null ? "NOT_REQUIRED" : "SKIPPED_EXPECTED_RUN",
    batchLimit: SHADOW_GRID_ABANDONED_CLEANUP_LIMIT,
    candidateCount: 0,
    examinedCount: 0,
    voidedCount: 0,
    failedCount: 0,
    deferredNonExpiredCount: 0,
    currentRunExcludedCount: 0,
    alreadyTerminalCount: 0,
    batchLimitReached: false,
    truncated: false,
    failures: [],
  };
  if (expectedRunId === null) {
    try {
      const discoveredCandidates = await store.listOldestNonterminalEpochs(
        SHADOW_GRID_ABANDONED_CLEANUP_LIMIT + 1,
      );
      const candidates = discoveredCandidates.slice(0, SHADOW_GRID_ABANDONED_CLEANUP_LIMIT);
      abandonedRunCleanup.candidateCount = candidates.length;
      abandonedRunCleanup.batchLimitReached =
        candidates.length === SHADOW_GRID_ABANDONED_CLEANUP_LIMIT;
      abandonedRunCleanup.truncated =
        discoveredCandidates.length > SHADOW_GRID_ABANDONED_CLEANUP_LIMIT;
      for (const candidate of candidates) {
        if (candidate.runId === currentRunId) {
          abandonedRunCleanup.currentRunExcludedCount += 1;
          continue;
        }
        abandonedRunCleanup.examinedCount += 1;
        try {
          const events = await store.getRun(candidate.runId);
          if (events.length === 0 || shadowGridRunIsTerminal(events)) {
            abandonedRunCleanup.alreadyTerminalCount += 1;
            continue;
          }
          verifyShadowGridRun(events);
          const originatingSchedule = cleanupScheduleFromShadowGridGenesis(events);
          const observedSampleCount = events.filter(
            (event) => event.eventType === "OBSERVED",
          ).length;
          const nextSampleDeadline = Date.parse(events[0]!.epochStartedAt) +
            (observedSampleCount + 1) * 5 * 60_000 +
            SHADOW_GRID_SAMPLE_GRACE_MILLISECONDS;
          const horizonDeadline = Date.parse(events[0]!.horizonEndsAt) +
            SHADOW_GRID_SAMPLE_GRACE_MILLISECONDS;
          const abandonmentDeadline = Math.min(nextSampleDeadline, horizonDeadline);
          if (!Number.isFinite(abandonmentDeadline)) {
            throw new Error("Shadow-grid abandoned epoch has an invalid sampling deadline");
          }
          if (now.getTime() <= abandonmentDeadline) {
            abandonedRunCleanup.deferredNonExpiredCount += 1;
            continue;
          }
          const cleanupRecordedAt = shadowGridCollectorCheckpointNow(request, env);
          if (cleanupRecordedAt.getTime() <= Date.parse(events.at(-1)!.recordedAt)) {
            throw new Error("Shadow-grid cleanup checkpoint must advance beyond the persisted ledger head");
          }
          await voidShadowGridRun(
            store,
            events,
            cleanupRecordedAt,
            `Originating GitHub workflow run ${originatingSchedule.runId} ended before its next required forward sample; the abandoned epoch was voided without backfill or source sampling`,
          );
          abandonedRunCleanup.voidedCount += 1;
          if (candidate.runId === previousHourCleanup.runId) {
            previousHourCleanup = { ...previousHourCleanup, status: "PROCESSED" };
          }
        } catch (error) {
          try {
            const refreshed = await store.getRun(candidate.runId);
            if (refreshed.length > 0 && shadowGridRunIsTerminal(refreshed)) {
              abandonedRunCleanup.alreadyTerminalCount += 1;
              continue;
            }
          } catch {
            // Preserve the original cleanup failure below.
          }
          const message = error instanceof Error
            ? error.message.slice(0, 240)
            : "Unknown cleanup failure";
          abandonedRunCleanup.failedCount += 1;
          abandonedRunCleanup.failures.push({ runId: candidate.runId, error: message });
          if (candidate.runId === previousHourCleanup.runId) {
            previousHourCleanup = { ...previousHourCleanup, status: "FAILED", error: message };
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message.slice(0, 240)
        : "Unknown cleanup enumeration failure";
      abandonedRunCleanup.failedCount += 1;
      abandonedRunCleanup.failures.push({ runId: null, error: message });
    }
    abandonedRunCleanup.status = abandonedRunCleanup.failedCount > 0
      ? abandonedRunCleanup.voidedCount > 0 ? "PARTIAL" : "FAILED"
      : abandonedRunCleanup.voidedCount > 0 ? "PROCESSED" : "NOT_REQUIRED";
  }
  const runId = expectedRunId ?? currentRunId;
  let events = await store.getRun(runId);
  if (expectedRunId !== null && events.length === 0) {
    throw new FreshMarketplaceRequestError(
      400,
      "INVALID_JSON",
      "Shadow-grid follow-up references an unknown originating run",
    );
  }
  const openingCheckpoint = shadowGridCollectorNow(request, env);
  if (
    expectedRunId === null &&
    events.length === 0 &&
    openingCheckpoint.getTime() >= openingDeadline
  ) {
    return json({
      schemaVersion: "positioncrew.bounded-grid-forward-shadow-tick.v1",
      accepted: true,
      recordedAt: openingCheckpoint.toISOString(),
      runId,
      state: "LATE_START_SKIPPED",
      headHash: null,
      eventCount: 0,
      epochStartedAt: null,
      horizonEndsAt: null,
      previousHourCleanup,
      abandonedRunCleanup,
      claimBoundary: SHADOW_GRID_PUBLIC_CLAIM_BOUNDARY,
    });
  }
  if (events.length === 0) {
    const started = await startShadowGridRun(env, runId, schedule, request, openingDeadline);
    if (started.state === "LATE_START_SKIPPED") {
      return json({
        schemaVersion: "positioncrew.bounded-grid-forward-shadow-tick.v1",
        accepted: true,
        recordedAt: started.recordedAt.toISOString(),
        runId,
        state: "LATE_START_SKIPPED",
        headHash: null,
        eventCount: 0,
        epochStartedAt: null,
        horizonEndsAt: null,
        previousHourCleanup,
        abandonedRunCleanup,
        claimBoundary: SHADOW_GRID_PUBLIC_CLAIM_BOUNDARY,
      });
    }
    events = started.events;
    assertShadowGridScheduleBinding(events, schedule);
  } else {
    assertShadowGridScheduleBinding(events, schedule);
    events = await processOpenShadowGridRun(env, events, now, request);
  }
  const latest = events.at(-1);
  if (!latest) throw new Error("Shadow-grid collector produced no event");
  return json({
    schemaVersion: "positioncrew.bounded-grid-forward-shadow-tick.v1",
    accepted: true,
    recordedAt: now.toISOString(),
    runId,
    state: shadowGridRunState(events),
    headHash: latest.eventHash,
    eventCount: events.length,
    epochStartedAt: latest.epochStartedAt,
    horizonEndsAt: latest.horizonEndsAt,
    previousHourCleanup,
    abandonedRunCleanup,
    claimBoundary: SHADOW_GRID_PUBLIC_CLAIM_BOUNDARY,
  });
}

async function getShadowGridLedger(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
  const epochs = await shadowGridStore(env).listEpochEvents();
  const runs = await Promise.all(epochs.map((epoch) => shadowGridStore(env).getRun(epoch.runId)));
  return json(summarizeShadowGridRuns(runs, origin), 200, "public, max-age=0, s-maxage=60");
}

async function getShadowGridWindow(
  request: Request,
  env: Env,
  origin: string,
  runId: string,
): Promise<Response> {
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
  const events = await shadowGridStore(env).getRun(runId);
  if (events.length === 0) return apiError(404, "SHADOW_WINDOW_NOT_FOUND", ["Unknown forward shadow window."]);
  const integrity = verifyShadowGridRun(events);
  const terminal = shadowGridRunIsTerminal(events);
  return json({
    schemaVersion: "positioncrew.bounded-grid-forward-shadow-window.v1",
    generatedAt: new Date().toISOString(),
    window: publicShadowGridWindow(events, origin),
    integrity,
    events: events.map(parseShadowGridEvent),
    claimBoundary: SHADOW_GRID_PUBLIC_CLAIM_BOUNDARY,
  }, 200, terminal ? "public, max-age=3600, s-maxage=86400, immutable" : "no-store");
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
      ? await runCurrentBlockPinnedProviderRequest(hire.request, new Date(executionStartedAt))
      : await runFrozenFixture(task.service);
    if (
      response.result.request.service !== task.service ||
      response.result.job.state !== "COMPLETED" ||
      response.result.job.deliverable === null
    ) {
      throw new Error("Provider response was not a completed result for the persisted service");
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

    if (url.pathname === EXTERNAL_COMPARISON_SNAPSHOT_ROUTE) {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(EXTERNAL_COMPARISON_SNAPSHOT, 200, "public, max-age=31536000, immutable");
    }

    if (url.pathname === VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE_ROUTE) {
      if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", ["Use GET."]);
      return json(VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE, 200, "public, max-age=31536000, immutable");
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

    if (url.pathname === "/api/evidence/bounded-grid-forward-shadow") {
      return getShadowGridLedger(request, env, url.origin);
    }

    const shadowGridWindowRoute = url.pathname.match(
      /^\/api\/evidence\/bounded-grid-forward-shadow\/windows\/(bg-[0-9]{8}-[0-9]{2})$/,
    );
    if (shadowGridWindowRoute) {
      return getShadowGridWindow(request, env, url.origin, shadowGridWindowRoute[1]!);
    }

    if (url.pathname === "/api/internal/bounded-grid-forward-shadow/tick") {
      return await collectShadowGridTick(request, env, url);
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
