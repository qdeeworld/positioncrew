import type { FixtureJobResponse, FreshMarketplaceChain, ServiceId, SessionJob } from "./types.js";

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
  expectedJobId: string,
  expectedProviderId: string,
  expectedDeliverableHash: string,
  expectedEvaluationHash: string,
): value is FixtureJobResponse {
  if (!isRecord(value) ||
    value.schemaVersion !== "positioncrew.fixture-job-response.v1" ||
    !["FROZEN_BSC_TEST_FIXTURE", "CALLER_SUPPLIED_OBSERVATIONS"].includes(String(value.evidenceMode)) ||
    value.commerceMode !== "IN_MEMORY_CONFORMANCE" ||
    value.advantageStatus !== "PENDING_INDEPENDENT_BLIND_EVALUATION" ||
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !isStringArray(value.claimBoundary)) {
    return false;
  }

  const benchmarkLock = value.benchmarkLock;
  if (benchmarkLock !== null && (!isRecord(benchmarkLock) ||
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
    responseJob.jobId !== expectedJobId ||
    typeof responseJob.state !== "string" ||
    typeof responseJob.envelopeHash !== "string" ||
    responseJob.providerId !== expectedProviderId ||
    typeof responseJob.evaluatorId !== "string" ||
    !Array.isArray(responseJob.history) ||
    !responseJob.history.every((entry) => isRecord(entry) &&
      typeof entry.state === "string" &&
      typeof entry.at === "string" &&
      typeof entry.reference === "string") ||
    !isRecord(responseJob.deliverable) ||
    responseJob.deliverable.deliverableHash !== expectedDeliverableHash) {
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

  return isRecord(evaluation) &&
    typeof evaluation.score === "number" &&
    Number.isFinite(evaluation.score) &&
    typeof evaluation.passed === "boolean" &&
    evaluation.evaluationHash === expectedEvaluationHash &&
    Array.isArray(evaluation.checks) &&
    evaluation.checks.every((check) => isRecord(check) &&
      typeof check.id === "string" &&
      typeof check.passed === "boolean" &&
      typeof check.critical === "boolean");
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

export function isFreshMarketplaceChainForReference(
  value: unknown,
  reference: RecentJobReference,
): value is FreshMarketplaceChain {
  if (!isRecord(value) || value.schemaVersion !== "positioncrew.fresh-marketplace-chain.v1") {
    return false;
  }

  const hire = value.hire;
  const job = value.job;
  if (!isRecord(hire) || !isRecord(job)) {
    return false;
  }

  if (hire.hireId !== reference.hireId || hire.service !== reference.service ||
    typeof hire.providerId !== "string" ||
    typeof job.jobId !== "string" ||
    !["CREATED", "RUNNING", "COMPLETED", "FAILED"].includes(String(job.state))) {
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
        job.jobId,
        hire.providerId,
        receipt.deliverableHash,
        receipt.evaluationHash,
      )) {
      return false;
    }
  }

  return true;
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
