import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { YieldOptimizationRequest } from "../src/contracts/yield-optimization.js";
import {
  assertYieldRateObservationRequestBinding, issueServerObservationBinding, verifyServerObservationBinding,
  type YieldRateObservation, type VerifiedYieldRateObservation,
} from "../src/commerce/server-observation-binding.js";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/commerce/d1-marketplace-store.js";
import { FreshMarketplaceChainSchema, sha256Commitment } from "../src/commerce/fresh-hire-schema.js";
import { auditionAiKiVenusYield, AIKI_VENUS_YIELD } from "../src/marketplace/aiki-venus-yield-adapter.js";
import { createYieldOptimizationDeliverable } from "../src/providers/yield-optimization.js";
import { annualizedYieldBps } from "../src/telemetry/bsc.js";
import worker from "../worker/index.js";

const inspection = vi.hoisted(() => vi.fn());
vi.mock("../src/telemetry/bsc.js", async (original) => ({
  ...await original<typeof import("../src/telemetry/bsc.js")>(), inspectVenusStableYields: inspection,
}));

const NOW = new Date("2026-09-07T21:49:16.000Z");
const BLOCK = 120569152;
const MARKET = "0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba";
const RATE = 410632935n;
const KEY = "positioncrew-yield-retention-explicit-test-key";
const SOURCE = { blockNumber: String(BLOCK), observedAt: NOW.toISOString(), explorerUrl: `https://bscscan.com/block/${BLOCK}` };
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const databases: DatabaseSync[] = [];

function request(): YieldOptimizationRequest {
  return {
    schemaVersion: "positioncrew.yield-optimization.request.v1", service: "YIELD_OPTIMIZATION",
    requestId: `venus-yield-${BLOCK}`, account: "0x0000000000000000000000000000000000000000",
    chainId: 56, protocol: "Venus Core Pool stablecoin supply", requestedAt: NOW.toISOString(),
    deadline: later(120).toISOString(), maxDataAgeSeconds: 120, capitalUsd: "1000.00",
    maxActionUsd: "1000.00", maxAllocationUsd: "1000.00", maxExecutionCostUsd: "0.25", maxGasUsd: "0.25",
    maxSlippageBps: 0, currentPositions: [], opportunities: [{
      opportunityId: "venus-core-fdusd-supply", protocol: "Venus Core Pool", vaultOrMarket: MARKET,
      asset: { address: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", decimals: 18, symbol: "FDUSD" },
      amountUsd: "1000.00", grossApyBps: annualizedYieldBps(RATE, 0.45), liquidityUsd: "2507947.02",
      lockupSeconds: 0, estimatedEntryCostUsd: "0.012930", estimatedExitCostUsd: "0.012930", riskTier: "MEDIUM",
      observedAt: SOURCE.observedAt, sourceId: `venus-yield-mainnet-block-${BLOCK}`,
    }],
    constraints: { evaluationHorizonDays: 90, maximumLockupSeconds: 0, maximumProtocolConcentrationBps: 10000,
      maximumRiskTier: "MEDIUM", minimumLiquidityUsd: "100000", minimumNetBenefitUsd: "1", protocolAllowlist: ["Venus Core Pool"] },
    sources: [{ sourceId: `venus-yield-mainnet-block-${BLOCK}`, label: "Retention regression fixture, not product evidence",
      observedAt: SOURCE.observedAt, uri: SOURCE.explorerUrl }],
  };
}

function proof(): YieldRateObservation {
  return {
    schemaVersion: "positioncrew.venus-yield-rate-observation.v1", chainId: 56,
    observedBlock: { blockNumber: String(BLOCK), blockHash: `0x${"1".repeat(64)}`, observedAt: SOURCE.observedAt },
    baselineBlock: { blockNumber: String(BLOCK - 120), blockHash: `0x${"2".repeat(64)}`, observedAt: later(-54).toISOString() },
    marketRates: [{ market: MARKET, supplyRatePerBlock: RATE.toString() }],
  };
}

async function signed(input = request()) {
  return issueServerObservationBinding(input, SOURCE, KEY, NOW, { yieldRateObservation: proof() });
}

async function verified(input = request()) {
  const binding = await signed(input);
  const result = await verifyServerObservationBinding(input, { ...SOURCE, binding }, KEY, later(85));
  if (!result.yieldRateObservation) throw new Error("Expected authenticated retained rates");
  return result.yieldRateObservation;
}

function external(rate = RATE): typeof fetch {
  return async (input) => {
    if (!String(input).startsWith(AIKI_VENUS_YIELD.endpoint)) {
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Historical state pruned" } });
    }
    return Response.json({
      assessment: { category: "yield_optimisation", assessmentVersion: "venus-yield/v1",
        routes: [{ market: MARKET, symbol: "vFDUSD", supplyRatePerBlock: rate.toString(), simpleAnnualRateBps: "287" }],
        recommendedMarket: MARKET, recommendation: "RATE_ONLY_CANDIDATE", observedAt: later(85).toISOString(),
        caveats: ["Synthetic transport regression, no capital transaction."] },
      evidence: { persisted: true },
    });
  };
}

async function compare(input: YieldOptimizationRequest, retained: VerifiedYieldRateObservation, fetchImpl = external(), completion = later(85)) {
  return auditionAiKiVenusYield(input, createYieldOptimizationDeliverable(input, later(85)), {
    now: later(85), completionNow: () => completion, verifiedYieldRateObservation: retained, fetchImpl,
  });
}

class Statement implements D1PreparedStatement {
  constructor(private readonly database: DatabaseSync, private readonly sql: string, private readonly values: SQLInputValue[] = []) {}
  bind(...values: unknown[]): D1PreparedStatement {
    return new Statement(this.database, this.sql, values.map((value) => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new Error("Unsupported test SQL binding");
    }));
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = OFF");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  sqlite.exec("PRAGMA foreign_keys = ON");
  return {
    prepare: (sql) => new Statement(sqlite, sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results: D1Result[] = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); vi.clearAllMocks(); });
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe("authenticated Yield observation retention", () => {
  it("keeps an85-second-old snapshot usable without historical RPC reads", async () => {
    const input = request();
    const retained = await verified(input);
    const fetchImpl = vi.fn(external());
    const result = await compare(input, retained, fetchImpl);
    expect(result.outcome).toBe("SEMANTICALLY_COMPARABLE");
    expect(result.eligibleForYieldSelection).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(AIKI_VENUS_YIELD.endpoint);
    expect(result.boundary).toContain("original server capture");
    expect(result.checks.find((check) => check.code === "PINNED_RATE_BINDING")?.detail).toContain("not re-fetched");
  });

  it("preserves the legacy binding and fail-closed RPC fallback", async () => {
    const input = request();
    const binding = await issueServerObservationBinding(input, SOURCE, KEY, NOW);
    expect(binding).not.toHaveProperty("yieldRateObservation");
    await expect(verifyServerObservationBinding(input, { ...SOURCE, binding }, KEY, later(85))).resolves.toEqual(binding);
    const result = await auditionAiKiVenusYield(input, createYieldOptimizationDeliverable(input, later(85)), { now: later(85), fetchImpl: external() });
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.checks[0]?.code).toBe("PINNED_STATE_UNAVAILABLE");
  });

  it.each(["rate", "market", "block", "hash", "time", "baseline", "expiry", "signature"])("rejects tampered %s before admitting evidence", async (field) => {
    const binding = await signed();
    const changed = binding.yieldRateObservation!;
    if (field === "rate") changed.marketRates[0]!.supplyRatePerBlock = (RATE + 1n).toString();
    if (field === "market") changed.marketRates[0]!.market = "0x1111111111111111111111111111111111111111";
    if (field === "block") changed.observedBlock.blockNumber = String(BLOCK + 1);
    if (field === "hash") changed.observedBlock.blockHash = `0x${"3".repeat(64)}`;
    if (field === "time") changed.observedBlock.observedAt = later(1).toISOString();
    if (field === "baseline") changed.baselineBlock.blockNumber = String(BLOCK - 119);
    if (field === "expiry") binding.expiresAt = later(300).toISOString();
    if (field === "signature") binding.signature = "0".repeat(64);
    await expect(verifyServerObservationBinding(request(), { ...SOURCE, binding }, KEY, later(85))).rejects.toThrow();
  });

  it.each(["duplicate", "missing", "extra", "apy", "interval", "same-hash"])("refuses inconsistent %s at issuance", async (field) => {
    const retained = proof();
    if (field === "duplicate") retained.marketRates.push({ ...retained.marketRates[0]! });
    if (field === "missing") retained.marketRates = [];
    if (field === "extra") retained.marketRates.push({ market: "0x1111111111111111111111111111111111111111", supplyRatePerBlock: "1" });
    if (field === "apy") retained.marketRates[0]!.supplyRatePerBlock = (RATE * 2n).toString();
    if (field === "interval") retained.baselineBlock.blockNumber = String(BLOCK - 119);
    if (field === "same-hash") retained.baselineBlock.blockHash = retained.observedBlock.blockHash;
    await expect(issueServerObservationBinding(request(), SOURCE, KEY, NOW, { yieldRateObservation: retained })).rejects.toThrow();
  });

  it("does not admit raw, cloned or post-verification altered proofs", async () => {
    const input = request();
    const retained = await verified(input);
    for (const candidate of [proof(), structuredClone(retained)]) {
      const fetchImpl = vi.fn(external());
      const result = await compare(input, candidate as VerifiedYieldRateObservation, fetchImpl);
      expect(result.outcome).toBe("UNAVAILABLE");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    retained.marketRates[0]!.supplyRatePerBlock = (RATE + 1n).toString();
    expect(() => assertYieldRateObservationRequestBinding(retained, input, later(85))).toThrow();
  });

  it("re-authenticates a serialized binding but rejects a transplanted request", async () => {
    const input = request();
    const binding = JSON.parse(JSON.stringify(await signed(input)));
    const authenticated = await verifyServerObservationBinding(input, { ...SOURCE, binding }, KEY, later(85));
    expect(() => assertYieldRateObservationRequestBinding(authenticated.yieldRateObservation!, input, later(85))).not.toThrow();
    const changed = { ...input, account: "0x1111111111111111111111111111111111111111" };
    await expect(verifyServerObservationBinding(changed, { ...SOURCE, binding }, KEY, later(85))).rejects.toThrow();
    expect(() => assertYieldRateObservationRequestBinding(authenticated.yieldRateObservation!, changed, later(85))).toThrow();
  });

  it("preserves stricter buyer limits and rejects a changed external raw rate", async () => {
    const input = request();
    const retained = await verified(input);
    const restricted = await compare({ ...input, maxGasUsd: "0.000001" }, retained);
    expect(restricted.normalizedDeliverable?.status).not.toBe("ACTIONABLE");
    expect(Number(restricted.normalizedDeliverable?.allocationUsd)).toBe(0);
    const mismatch = await compare(input, retained, external(RATE + 1n));
    expect(mismatch.eligibleForYieldSelection).toBe(false);
    expect(mismatch.checks).toContainEqual(expect.objectContaining({ code: "PINNED_RATE_BINDING", status: "FAIL" }));
  });

  it("rejects expired, extended and in-flight expired evidence", async () => {
    const input = request();
    const binding = await signed(input);
    const retained = await verified(input);
    await expect(verifyServerObservationBinding(input, { ...SOURCE, binding }, KEY, later(120))).rejects.toThrow();
    expect(() => assertYieldRateObservationRequestBinding(retained, { ...input, deadline: later(180).toISOString() }, later(85))).toThrow();
    expect(() => assertYieldRateObservationRequestBinding(retained, { ...input, maxDataAgeSeconds: 180 }, later(85))).toThrow();
    const result = await compare(input, retained, external(), later(120));
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.eligibleForYieldSelection).toBe(false);
  });

  it("keeps signed capture through real Worker creation, SQLite persistence, run and receipt reload", async () => {
    const input = request();
    inspection.mockResolvedValue({ schemaVersion: "positioncrew.venus-yield-probe.v1", generatedAt: NOW.toISOString(), chainId: 56,
      state: "READY", markets: [], yieldRequest: input, yieldRateObservation: proof(),
      source: { ...SOURCE, blockTimestamp: SOURCE.observedAt }, boundary: "Synthetic capture regression" });
    const env = { DB: database(), ASSETS: { fetch: async () => new Response("Unused", { status: 404 }) }, SOURCE_OBSERVATION_HMAC_KEY: KEY };
    const tasks: Promise<unknown>[] = [];
    const context = { waitUntil: (task: Promise<unknown>) => { tasks.push(task); } };
    const api = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://positioncrew.example${path}`, init), env, context);
    const capturedResponse = await api("/api/markets/venus/stable-yields");
    expect(capturedResponse.status).toBe(200);
    const capture = await capturedResponse.json() as { observationBinding: Awaited<ReturnType<typeof signed>> };
    expect(inspection).toHaveBeenCalledWith({ retainYieldRateObservation: true });
    expect(capture).not.toHaveProperty("yieldRateObservation");
    expect(capture.observationBinding.yieldRateObservation).toEqual(proof());
    const fetchImpl = vi.fn(external());
    vi.stubGlobal("fetch", fetchImpl);
    vi.setSystemTime(later(85));
    const body = { schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2", benchmarkSlug: "yield-optimization",
      providerSlug: "yield-optimization", evidenceMode: "CURRENT_BLOCK_PINNED", idempotencyKey: crypto.randomUUID(),
      observation: SOURCE, observationBinding: capture.observationBinding, request: input };
    const post = (value: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json", Origin: "https://positioncrew.example" }, body: JSON.stringify(value) });
    const createdResponse = await api("/api/benchmark-hires", post(body));
    expect([200, 201]).toContain(createdResponse.status);
    const created = FreshMarketplaceChainSchema.parse(await createdResponse.json());
    expect(created.hire.evidence).toMatchObject({ observationBinding: capture.observationBinding,
      externalYieldComparison: { outcome: "SEMANTICALLY_COMPARABLE", eligibleForYieldSelection: true } });
    expect(created.hire.evidenceHash).toBe(await sha256Commitment(created.hire.evidence));
    const started = await api(`/api/benchmark-hires/${created.hire.hireId}/jobs`, { method: "POST", headers: { Origin: "https://positioncrew.example" } });
    expect([200, 202]).toContain(started.status);
    await Promise.all(tasks);
    const complete = FreshMarketplaceChainSchema.parse(await (await api(`/api/benchmark-hires/${created.hire.hireId}`)).json());
    expect(complete.job.state).toBe("COMPLETED");
    expect(complete.receipt).not.toBeNull();
    const receipt = FreshMarketplaceChainSchema.parse(await (await api(complete.receipt!.publicUrl)).json());
    expect(receipt.hire.request).toEqual(input);
    expect(receipt.hire.evidence).toEqual(created.hire.evidence);
    expect(receipt.hire.evidenceHash).toEqual(created.hire.evidenceHash);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.setSystemTime(later(121));
    expect((await api(complete.receipt!.publicUrl)).status).toBe(200);
    const replay = FreshMarketplaceChainSchema.parse(await (await api("/api/benchmark-hires", post(body))).json());
    expect(replay.hire).toEqual(created.hire);
    expect((await api("/api/benchmark-hires", post({ ...body, idempotencyKey: crypto.randomUUID() }))).status).toBe(409);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
