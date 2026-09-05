import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { verifyServerObservationBinding } from "../src/commerce/server-observation-binding.js";
import worker from "../worker/index.js";

const inspections = vi.hoisted(() => ({
  inspectVenusAccount: vi.fn(),
  inspectPancakePosition: vi.fn(),
  inspectPancakeGridMarket: vi.fn(),
  inspectVenusStableYields: vi.fn(),
}));
vi.mock("../src/telemetry/bsc.js", async (original) => ({
  ...await original<typeof import("../src/telemetry/bsc.js")>(),
  ...inspections,
}));

const NOW = new Date("2026-09-05T12:00:00.000Z");
const KEY = "positioncrew-probe-explicit-test-signing-key";
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const BLOCK = "71001234";
const SOURCE = {
  blockNumber: BLOCK,
  observedAt: new Date(NOW.getTime() - 15_000).toISOString(),
  explorerUrl: `https://bscscan.com/block/${BLOCK}`,
};
const CASES = [
  { fixture: "lending-rescue/stressed-venus-position.v1.json", service: "LENDING_RESCUE", key: "rescueRequest", inspect: "inspectVenusAccount", path: `/api/wallets/${ACCOUNT}/venus`, protocol: "Venus Classic", sourcePrefix: "venus-mainnet-block", slug: "lending-rescue" },
  { fixture: "lp-rebalance/out-of-range-v3-position.v1.json", service: "LP_REBALANCE", key: "lpRequest", inspect: "inspectPancakePosition", path: "/api/positions/pancake/9000001", protocol: "PancakeSwap V3 position analysis", sourcePrefix: "pancake-position-mainnet-block", slug: "lp-rebalance" },
  { fixture: "bounded-grid/bnb-usdt-grid.v1.json", service: "BOUNDED_GRID", key: "gridRequest", inspect: "inspectPancakeGridMarket", path: "/api/markets/pancake/wbnb-usdt/grid", protocol: "PancakeSwap V3 bounded grid policy", sourcePrefix: "pancake-v3-mainnet-block", slug: "bounded-grid" },
  { fixture: "yield-optimization/venus-to-beefy.v1.json", service: "YIELD_OPTIMIZATION", key: "yieldRequest", inspect: "inspectVenusStableYields", path: "/api/markets/venus/stable-yields", protocol: "Venus Core Pool stablecoin supply", sourcePrefix: "venus-yield-mainnet-block", slug: "yield-optimization" },
] as const;

function inspectedProbe(definition: typeof CASES[number]) {
  const fixture = JSON.parse(readFileSync(new URL(`../fixtures/${definition.fixture}`, import.meta.url), "utf8"));
  const sourceId = `${definition.sourcePrefix}-${BLOCK}`;
  function rebind(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(rebind);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key, key === "sourceId" ? sourceId : key === "observedAt" ? SOURCE.observedAt : rebind(child),
    ]));
  }
  const request = rebind(fixture) as Record<string, any>;
  request.requestId = definition.service === "LP_REBALANCE" ? `pancake-position-9000001-${BLOCK}`
    : definition.service === "BOUNDED_GRID" ? `pancake-grid-${BLOCK}`
      : definition.service === "YIELD_OPTIMIZATION" ? `venus-yield-${BLOCK}`
        : `venus-live-test-${BLOCK}`;
  request.chainId = 56;
  request.account = ACCOUNT;
  request.protocol = definition.protocol;
  request.requestedAt = NOW.toISOString();
  request.deadline = new Date(NOW.getTime() + 300_000).toISOString();
  request.maxDataAgeSeconds = 300;
  request.sources = [{ sourceId, label: "Synthetic server probe test", uri: SOURCE.explorerUrl, observedAt: SOURCE.observedAt }];
  if (definition.service === "LENDING_RESCUE") request.market = "0xfd36e2c2a6789db23113685031d7f16329158384";
  return {
    state: "READY",
    source: { ...SOURCE, blockTimestamp: SOURCE.observedAt },
    [definition.key]: request,
  };
}

const environment = {
  ASSETS: { async fetch() { return new Response("unused"); } },
  DB: {
    prepare() { throw new Error("No storage or provider call is allowed at this boundary"); },
    async batch() { throw new Error("No storage mutation is allowed at this boundary"); },
  },
  SOURCE_OBSERVATION_HMAC_KEY: KEY,
};
const context = { waitUntil() { throw new Error("No execution is allowed at this boundary"); } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("server-issued current observation probes", () => {
  it.each(CASES)("signs the actual $service observation and forbids shared caching", async (definition) => {
    const probe = inspectedProbe(definition);
    inspections[definition.inspect].mockResolvedValue(probe);
    const response = await worker.fetch(new Request(`https://positioncrew.example${definition.path}`), environment, context);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.json() as Record<string, any>;
    expect(body[definition.key]).toEqual(probe[definition.key]);
    await expect(verifyServerObservationBinding(body[definition.key], {
      ...SOURCE, binding: body.observationBinding,
    }, KEY, NOW)).resolves.toMatchObject({ service: definition.service, account: ACCOUNT });
  });

  it.each(CASES)("fails closed for $service when signing configuration is absent", async (definition) => {
    inspections[definition.inspect].mockResolvedValue(inspectedProbe(definition));
    const { SOURCE_OBSERVATION_HMAC_KEY: _key, ...unsignedEnvironment } = environment;
    const response = await worker.fetch(new Request(`https://positioncrew.example${definition.path}`), unsignedEnvironment, context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "REFRESH_REQUIRED" });
  });

  it.each(CASES)("rejects a changed observed $service request before storage or auditions", async (definition) => {
    const probe = inspectedProbe(definition);
    inspections[definition.inspect].mockResolvedValue(probe);
    const response = await worker.fetch(new Request(`https://positioncrew.example${definition.path}`), environment, context);
    const body = await response.json() as Record<string, any>;
    const request = body[definition.key];
    request.account = "0x2222222222222222222222222222222222222222";
    const created = await worker.fetch(new Request("https://positioncrew.example/api/benchmark-hires", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://positioncrew.example" },
      body: JSON.stringify({
        schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2",
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
        benchmarkSlug: definition.slug,
        providerSlug: definition.slug,
        evidenceMode: "CURRENT_BLOCK_PINNED",
        observation: SOURCE,
        observationBinding: body.observationBinding,
        request,
      }),
    }), environment, context);
    expect(created.status, await created.clone().text()).toBe(409);
    await expect(created.json()).resolves.toMatchObject({ error: "REFRESH_REQUIRED" });
  });

  it("classifies the known inactive LP position without exposing an RPC error", async () => {
    inspections.inspectPancakePosition.mockRejectedValue(new Error("The PancakeSwap position has no active liquidity"));
    const response = await worker.fetch(new Request("https://positioncrew.example/api/positions/pancake/7284554"), environment, context);
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string; details: string[] };
    expect(body.error).toBe("NO_ACTIVE_LIQUIDITY");
    expect(JSON.stringify(body)).toContain("Choose an active position");
  });

  it("does not misclassify or expose unrelated RPC failures as an inactive position", async () => {
    inspections.inspectPancakePosition.mockRejectedValue(new Error("private-rpc.example secret-rpc-token"));
    const response = await worker.fetch(new Request("https://positioncrew.example/api/positions/pancake/7284554"), environment, context);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("secret-rpc-token");
    expect(body).not.toContain("NO_ACTIVE_LIQUIDITY");
  });
});
