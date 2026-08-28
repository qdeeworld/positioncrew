import type { FixtureJobResponse, FreshMarketplaceChain, ServiceId, SessionJob } from "./types.js";
import { FixtureJobResponseSchema } from "../../src/api/fixture-response-schema.js";
import {
  canonicalJson,
  freshMarketplaceTaskForService,
  sha256Commitment,
} from "../../src/commerce/fresh-hire-schema.js";

export const RECENT_JOB_STORAGE_KEY = "positioncrew.recent-jobs.v1";
export const RECENT_JOB_CHANGED_EVENT = "positioncrew:recent-job-changed";
export const RECENT_JOB_LIMIT = 20;

const HISTORY_SCHEMA_VERSION = "positioncrew.recent-jobs.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICES = new Set<ServiceId>([
  "LENDING_RESCUE",
  "LP_REBALANCE",
  "YIELD_OPTIMIZATION",
  "BOUNDED_GRID",
]);

export interface RecentJobReference {
  hireId: string;
  service: ServiceId;
  rememberedAt: string;
}

export interface RecentJobHistoryRead {
  available: boolean;
  entries: RecentJobReference[];
  corruptCount: number;
}

export interface RecentJobHistoryWrite {
  ok: boolean;
  entries: RecentJobReference[];
  reason?: "STORAGE_UNAVAILABLE" | "INVALID_REFERENCE";
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface RecentJobChangeDetail {
  reference: RecentJobReference;
  storageAvailable: boolean;
}

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFixtureJobResponseForChain(
  value: unknown,
  reference: RecentJobReference,
  expectedProviderId: string,
  expectedRequest: unknown,
  expectedRequestHash: string,
  expectedDeliverableHash: string,
  expectedEvaluationHash: string,
  chainEvidenceMode: "HISTORICAL_FIXTURE" | "CURRENT_BLOCK_PINNED",
): value is FixtureJobResponse {
  const canonical = FixtureJobResponseSchema.safeParse(value);
  if (!canonical.success) {
    return false;
  }
  const expectedResponseMode = chainEvidenceMode === "CURRENT_BLOCK_PINNED"
    ? "CURRENT_BLOCK_PINNED"
    : "FROZEN_BSC_TEST_FIXTURE";
  if (canonical.data.evidenceMode !== expectedResponseMode) {
    return false;
  }
  value = canonical.data;

  if (!isRecord(value) ||
    value.schemaVersion !== "positioncrew.fixture-job-response.v1" ||
    !["FROZEN_BSC_TEST_FIXTURE", "CALLER_SUPPLIED_OBSERVATIONS", "CURRENT_BLOCK_PINNED"].includes(String(value.evidenceMode)) ||
    value.commerceMode !== "IN_MEMORY_CONFORMANCE" ||
    value.advantageStatus !== "PENDING_INDEPENDENT_BLIND_EVALUATION" ||
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !isStringArray(value.claimBoundary)) {
    return false;
  }

  const benchmarkLock = value.benchmarkLock;
  if (benchmarkLock !== null && (!isRecord(benchmarkLock) ||
    typeof benchmarkLock.taskId !== "string" ||
    typeof benchmarkLock.fixtureHash !== "string" ||
    typeof benchmarkLock.rubricHash !== "string" ||
    typeof benchmarkLock.protocolHash !== "string")) {
    return false;
  }

  const embeddedReceipt = value.receipt;
  const result = value.result;
  if (!isRecord(embeddedReceipt) ||
    !["PUBLIC_REPRODUCIBLE", "SESSION_EMBEDDED"].includes(String(embeddedReceipt.mode)) ||
    !(embeddedReceipt.path === null || typeof embeddedReceipt.path === "string") ||
    embeddedReceipt.evaluationHash !== expectedEvaluationHash ||
    !isRecord(result)) {
    return false;
  }

  const responseJob = result.job;
  const request = result.request;
  const deliverable = result.deliverable;
  const evaluation = result.evaluation;
  if (!isRecord(responseJob) ||
    typeof responseJob.jobId !== "string" ||
    responseJob.jobId.length < 8 ||
    typeof responseJob.state !== "string" ||
    typeof responseJob.envelopeHash !== "string" ||
    responseJob.providerId !== expectedProviderId ||
    typeof responseJob.evaluatorId !== "string" ||
    !isRecord(responseJob.envelope) ||
    typeof responseJob.envelope.requestHash !== "string" ||
    !Array.isArray(responseJob.history) ||
    !responseJob.history.every((entry) => isRecord(entry) &&
      typeof entry.state === "string" &&
      typeof entry.at === "string" &&
      typeof entry.reference === "string") ||
    !isRecord(responseJob.deliverable) ||
    typeof responseJob.deliverable.requestHash !== "string" ||
    responseJob.deliverable.deliverableHash !== expectedDeliverableHash ||
    !isRecord(responseJob.evaluation) ||
    typeof responseJob.evaluation.requestHash !== "string") {
    return false;
  }

  if (!isRecord(request) ||
    request.service !== reference.service ||
    typeof request.account !== "string" ||
    ![56, 97].includes(Number(request.chainId)) ||
    typeof request.maxActionUsd !== "string" ||
    typeof request.maxGasUsd !== "string" ||
    typeof request.maxSlippageBps !== "number" ||
    !Number.isFinite(request.maxSlippageBps) ||
    typeof request.maxDataAgeSeconds !== "number" ||
    !Number.isFinite(request.maxDataAgeSeconds)) {
    return false;
  }

  if (!isRecord(deliverable) ||
    deliverable.service !== reference.service ||
    typeof deliverable.status !== "string" ||
    typeof deliverable.decision !== "string" ||
    typeof deliverable.summary !== "string" ||
    typeof deliverable.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(deliverable.expiresAt))) {
    return false;
  }

  if (!isRecord(evaluation) ||
    typeof evaluation.requestHash !== "string" ||
    typeof evaluation.score !== "number" ||
    !Number.isFinite(evaluation.score) ||
    typeof evaluation.passed !== "boolean" ||
    evaluation.evaluationHash !== expectedEvaluationHash ||
    !Array.isArray(evaluation.checks) ||
    !evaluation.checks.every((check) => isRecord(check) &&
      typeof check.id === "string" &&
      typeof check.passed === "boolean" &&
      typeof check.critical === "boolean")) {
    return false;
  }

  const responseRequestHash = evaluation.requestHash;
  if (responseJob.envelope.requestHash !== responseRequestHash ||
    responseJob.deliverable.requestHash !== responseRequestHash ||
    responseJob.evaluation.requestHash !== responseRequestHash) {
    return false;
  }

  if (chainEvidenceMode === "CURRENT_BLOCK_PINNED") {
    if (responseRequestHash !== expectedRequestHash) {
      return false;
    }
    try {
      return canonicalJson(request) === canonicalJson(expectedRequest);
    } catch {
      return false;
    }
  }

  const fixtureBinding = freshMarketplaceTaskForService(reference.service);
  if (!fixtureBinding || !isRecord(expectedRequest) || !isRecord(benchmarkLock)) {
    return false;
  }
  const [benchmarkSlug, task] = fixtureBinding;
  return embeddedReceipt.mode === "PUBLIC_REPRODUCIBLE" &&
    expectedRequest.schemaVersion === "positioncrew.fresh-marketplace-provider-request.v1" &&
    expectedRequest.benchmarkSlug === benchmarkSlug &&
    expectedRequest.providerSlug === task.providerSlug &&
    expectedRequest.providerId === expectedProviderId &&
    expectedRequest.requestSchema === task.requestSchema &&
    expectedRequest.evidenceMode === "HISTORICAL_FIXTURE" &&
    expectedRequest.directCostUsd === "0.00" &&
    expectedRequest.walletRequired === false &&
    request.schemaVersion === task.requestSchema &&
    request.requestId === benchmarkLock.taskId &&
    responseRequestHash === benchmarkLock.fixtureHash;
}

export function isRecentJobReference(value: unknown): value is RecentJobReference {
  if (!isRecord(value) || !hasExactKeys(value, ["hireId", "service", "rememberedAt"])) {
    return false;
  }

  return typeof value.hireId === "string" &&
    UUID_PATTERN.test(value.hireId) &&
    typeof value.service === "string" &&
    SERVICES.has(value.service as ServiceId) &&
    typeof value.rememberedAt === "string" &&
    Number.isFinite(Date.parse(value.rememberedAt));
}

function normalizeReferences(values: unknown[]): { entries: RecentJobReference[]; corruptCount: number } {
  const unique = new Map<string, RecentJobReference>();
  let corruptCount = 0;

  for (const value of values) {
    if (!isRecentJobReference(value)) {
      corruptCount += 1;
      continue;
    }

    const previous = unique.get(value.hireId);
    if (!previous || Date.parse(value.rememberedAt) > Date.parse(previous.rememberedAt)) {
      unique.set(value.hireId, value);
    }
  }

  const entries = [...unique.values()]
    .sort((left, right) => Date.parse(right.rememberedAt) - Date.parse(left.rememberedAt))
    .slice(0, RECENT_JOB_LIMIT);

  return { entries, corruptCount };
}

export function readRecentJobReferences(storage: StorageLike | undefined = defaultStorage()): RecentJobHistoryRead {
  if (!storage) {
    return { available: false, entries: [], corruptCount: 0 };
  }

  try {
    const raw = storage.getItem(RECENT_JOB_STORAGE_KEY);
    if (raw === null) {
      return { available: true, entries: [], corruptCount: 0 };
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) ||
      !hasExactKeys(parsed, ["schemaVersion", "entries"]) ||
      parsed.schemaVersion !== HISTORY_SCHEMA_VERSION ||
      !Array.isArray(parsed.entries)) {
      return { available: true, entries: [], corruptCount: 1 };
    }

    const normalized = normalizeReferences(parsed.entries);
    return { available: true, ...normalized };
  } catch {
    return { available: false, entries: [], corruptCount: 0 };
  }
}

function writeReferences(entries: RecentJobReference[], storage: StorageLike | undefined): RecentJobHistoryWrite {
  if (!storage) {
    return { ok: false, entries: [], reason: "STORAGE_UNAVAILABLE" };
  }

  try {
    storage.setItem(RECENT_JOB_STORAGE_KEY, JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries,
    }));
    return { ok: true, entries };
  } catch {
    return { ok: false, entries: [], reason: "STORAGE_UNAVAILABLE" };
  }
}

export function rememberRecentJobReference(
  reference: RecentJobReference,
  storage: StorageLike | undefined = defaultStorage(),
): RecentJobHistoryWrite {
  if (!isRecentJobReference(reference)) {
    return { ok: false, entries: [], reason: "INVALID_REFERENCE" };
  }

  const current = readRecentJobReferences(storage);
  if (!current.available) {
    return { ok: false, entries: [], reason: "STORAGE_UNAVAILABLE" };
  }

  const normalized = normalizeReferences([reference, ...current.entries]);
  return writeReferences(normalized.entries, storage);
}

export function removeRecentJobReference(
  hireId: string,
  storage: StorageLike | undefined = defaultStorage(),
): RecentJobHistoryWrite {
  const current = readRecentJobReferences(storage);
  if (!current.available) {
    return { ok: false, entries: [], reason: "STORAGE_UNAVAILABLE" };
  }
  return writeReferences(current.entries.filter((entry) => entry.hireId !== hireId), storage);
}

export function clearRecentJobReferences(
  storage: StorageLike | undefined = defaultStorage(),
): RecentJobHistoryWrite {
  if (!storage) {
    return { ok: false, entries: [], reason: "STORAGE_UNAVAILABLE" };
  }

  try {
    storage.removeItem(RECENT_JOB_STORAGE_KEY);
    return { ok: true, entries: [] };
  } catch {
    return { ok: false, entries: [], reason: "STORAGE_UNAVAILABLE" };
  }
}

export function rememberRecentJobOnDevice(reference: RecentJobReference): RecentJobHistoryWrite {
  const result = rememberRecentJobReference(reference);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<RecentJobChangeDetail>(RECENT_JOB_CHANGED_EVENT, {
      detail: { reference, storageAvailable: result.ok },
    }));
  }
  return result;
}

export function isRecentJobChangeDetail(value: unknown): value is RecentJobChangeDetail {
  return isRecord(value) &&
    isRecentJobReference(value.reference) &&
    typeof value.storageAvailable === "boolean";
}

export async function isFreshMarketplaceChainForReference(
  value: unknown,
  reference: RecentJobReference,
): Promise<boolean> {
  if (!isRecord(value) || value.schemaVersion !== "positioncrew.fresh-marketplace-chain.v1") {
    return false;
  }

  const hire = value.hire;
  const job = value.job;
  if (!isRecord(hire) || !isRecord(job)) {
    return false;
  }

  const taskBinding = freshMarketplaceTaskForService(reference.service);
  if (!taskBinding) {
    return false;
  }
  const [benchmarkSlug, task] = taskBinding;
  const expectedStatus = {
    CREATED: "HIRE_RECORDED",
    RUNNING: "RUNNING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
  }[String(job.state)];

  if (hire.hireId !== reference.hireId || hire.service !== reference.service ||
    hire.benchmarkSlug !== benchmarkSlug ||
    hire.providerSlug !== task.providerSlug ||
    typeof hire.providerId !== "string" ||
    !isRecord(hire.request) ||
    typeof hire.requestHash !== "string" ||
    !["HISTORICAL_FIXTURE", "CURRENT_BLOCK_PINNED"].includes(String(hire.evidenceMode)) ||
    typeof job.jobId !== "string" ||
    !expectedStatus || job.status !== expectedStatus) {
    return false;
  }

  if (job.error !== null && (!isRecord(job.error) ||
    typeof job.error.code !== "string" ||
    typeof job.error.message !== "string")) {
    return false;
  }

  if (job.state === "COMPLETED") {
    const receipt = value.receipt;
    if (!isRecord(receipt) ||
      typeof receipt.receiptId !== "string" ||
      typeof receipt.publicUrl !== "string" ||
      typeof receipt.responseHash !== "string" ||
      typeof receipt.deliverableHash !== "string" ||
      typeof receipt.evaluationHash !== "string" ||
      typeof receipt.createdAt !== "string" ||
      !isFixtureJobResponseForChain(
        receipt.response,
        reference,
        hire.providerId,
        hire.request,
        hire.requestHash,
        receipt.deliverableHash,
        receipt.evaluationHash,
        hire.evidenceMode as "HISTORICAL_FIXTURE" | "CURRENT_BLOCK_PINNED",
      )) {
      return false;
    }
    try {
      if (await sha256Commitment(receipt.response) !== receipt.responseHash) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

export async function validatedFreshMarketplaceChain(
  value: unknown,
): Promise<FreshMarketplaceChain | null> {
  if (!isRecord(value) || !isRecord(value.hire)) {
    return null;
  }

  const reference = {
    hireId: value.hire.hireId,
    service: value.hire.service,
    rememberedAt: value.hire.createdAt,
  };
  if (!isRecentJobReference(reference) || !(await isFreshMarketplaceChainForReference(value, reference))) {
    return null;
  }
  return value as unknown as FreshMarketplaceChain;
}

export function sessionJobFromFreshChain(chain: FreshMarketplaceChain): SessionJob | null {
  if (chain.job.state !== "COMPLETED" || !chain.receipt) {
    return null;
  }

  return {
    response: chain.receipt.response,
    responseTimeMs: chain.job.apiDurationMilliseconds ?? 0,
    ranAt: chain.job.completedAt ?? chain.hire.createdAt,
    marketplaceTrace: chain,
  };
}
