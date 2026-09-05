import { describe, expect, it } from "vitest";
import lending from "../fixtures/lending-rescue/stressed-venus-position.v1.json" with { type: "json" };
import lp from "../fixtures/provider-conformance/lp-valid.v2.json" with { type: "json" };
import yieldRequest from "../fixtures/yield-optimization/venus-to-beefy.v1.json" with { type: "json" };
import grid from "../fixtures/provider-conformance/grid-valid.v2.json" with { type: "json" };
import { PositionCrewRequestSchema, type PositionCrewRequest } from "../src/contracts/index.js";
import {
  issueServerObservationBinding,
  verifyServerObservationBinding,
  SourceObservationBindingError,
} from "../src/commerce/server-observation-binding.js";

const KEY = "test-only-server-observation-key-00000000000000000000000000000001";
const OTHER_KEY = "test-only-server-observation-key-00000000000000000000000000000002";
const NOW = new Date("2026-08-12T16:00:30.000Z");
const OBSERVATION = {
  blockNumber: "30000000",
  observedAt: "2026-08-12T15:59:00.000Z",
  explorerUrl: "https://bscscan.com/block/30000000",
};
const INPUTS = { LENDING_RESCUE: lending, LP_REBALANCE: lp, YIELD_OPTIMIZATION: yieldRequest, BOUNDED_GRID: grid };
type Service = PositionCrewRequest["service"];
type RequestFor<S extends Service> = Extract<PositionCrewRequest, { service: S }>;

// Synthetic server-side observations are established before signing. Mutations below occur only after issuance.
function requestFor<S extends Service>(service: S): RequestFor<S> {
  const request = PositionCrewRequestSchema.parse(INPUTS[service]);
  request.chainId = 56;
  request.requestedAt = "2026-08-12T16:00:00.000Z";
  request.deadline = "2026-08-12T16:05:00.000Z";
  request.maxDataAgeSeconds = 300;
  request.sources = [{ ...request.sources[0]!, observedAt: OBSERVATION.observedAt, uri: OBSERVATION.explorerUrl }];
  const observations = request.service === "LENDING_RESCUE" ? [...request.position.collateral, ...request.position.debt]
    : request.service === "YIELD_OPTIMIZATION" ? [...request.currentPositions, ...request.opportunities] : [request.marketState];
  for (const observation of observations) {
    observation.observedAt = OBSERVATION.observedAt;
    observation.sourceId = request.sources[0]!.sourceId;
  }
  return request as RequestFor<S>;
}

async function signed<S extends Service>(service: S) {
  const request = requestFor(service);
  const binding = await issueServerObservationBinding(request, OBSERVATION, KEY, NOW);
  return { request, binding, observation: { ...OBSERVATION, binding } };
}

interface MutationCase { name: string; service: Service; mutate: (request: PositionCrewRequest) => void }
function mutation<S extends Service>(service: S, name: string, mutate: (request: RequestFor<S>) => void): MutationCase {
  return { name, service, mutate: (request) => mutate(request as RequestFor<S>) };
}

const IMMUTABLE_MUTATIONS: MutationCase[] = [
  mutation("LP_REBALANCE", "snapshot request ID", (request) => { request.requestId = "client-replaced-snapshot-id"; }),
  mutation("LP_REBALANCE", "account", (request) => { request.account = "0x9999999999999999999999999999999999999999"; }),
  mutation("LP_REBALANCE", "chain", (request) => { request.chainId = 97; }),
  mutation("LP_REBALANCE", "protocol", (request) => { request.protocol = "Another protocol"; }),
  mutation("LP_REBALANCE", "request epoch", (request) => { request.requestedAt = "2026-08-12T16:00:01.000Z"; }),
  mutation("LP_REBALANCE", "source URL", (request) => { request.sources[0]!.uri = "https://bscscan.com/block/30000001"; }),
  mutation("LP_REBALANCE", "source timestamp", (request) => { request.sources[0]!.observedAt = "2026-08-12T15:59:01.000Z"; }),
  mutation("LP_REBALANCE", "source label", (request) => { request.sources[0]!.label = "Client-attested replacement source"; }),
  mutation("LP_REBALANCE", "LP current tick", (request) => { request.marketState.currentTick += 1; }),
  mutation("LP_REBALANCE", "LP token price", (request) => { request.marketState.token0PriceUsd = "0.000000000000000001"; }),
  mutation("LP_REBALANCE", "LP earned-fee input", (request) => { request.marketState.fees24hUsd = "100000000"; }),
  mutation("LP_REBALANCE", "LP position value", (request) => { request.position.positionValueUsd = "1000000"; }),
  mutation("LP_REBALANCE", "LP position ticks", (request) => { request.position.lowerTick -= 60; }),
  mutation("LP_REBALANCE", "LP inventory split", (request) => { request.position.token0ShareBps = 5000; request.position.token1ShareBps = 5000; }),
  mutation("LP_REBALANCE", "LP token precision", (request) => { request.token0.decimals = 6; }),
  mutation("LP_REBALANCE", "LP gas quote", (request) => { request.constraints.estimatedGasUsd = "0"; }),
  mutation("LP_REBALANCE", "LP swap-cost quote", (request) => { request.constraints.estimatedSwapCostUsd = "0"; }),
  mutation("LP_REBALANCE", "LP tick spacing", (request) => { request.constraints.tickSpacing = 1; }),
  mutation("LENDING_RESCUE", "lending collateral balance", (request) => { request.position.collateral[0]!.amount = "999999"; }),
  mutation("LENDING_RESCUE", "lending liquidation threshold", (request) => { request.position.collateral[0]!.liquidationThresholdBps = 10000; }),
  mutation("LENDING_RESCUE", "lending debt balance", (request) => { request.position.debt[0]!.amount = "1"; }),
  mutation("LENDING_RESCUE", "lending available inventory", (request) => { request.availableAssets[0]!.availableAmount = "999999"; }),
  mutation("LENDING_RESCUE", "lending asset precision", (request) => { request.position.debt[0]!.decimals = 6; }),
  mutation("LENDING_RESCUE", "lending gas quote", (request) => { request.estimatedGasUsd = "0"; }),
  mutation("LENDING_RESCUE", "lending market", (request) => { request.market = "0x9999999999999999999999999999999999999999"; }),
  mutation("YIELD_OPTIMIZATION", "yield existing balance", (request) => { request.currentPositions[0]!.amountUsd = "1"; }),
  mutation("YIELD_OPTIMIZATION", "yield current APY", (request) => { request.currentPositions[0]!.grossApyBps = 0; }),
  mutation("YIELD_OPTIMIZATION", "yield capacity", (request) => { request.opportunities[0]!.amountUsd = "999999"; }),
  mutation("YIELD_OPTIMIZATION", "yield destination APY", (request) => { request.opportunities[0]!.grossApyBps = 999999; }),
  mutation("YIELD_OPTIMIZATION", "yield entry-cost quote", (request) => { request.opportunities[0]!.estimatedEntryCostUsd = "0"; }),
  mutation("YIELD_OPTIMIZATION", "yield exit-cost quote", (request) => { request.currentPositions[0]!.estimatedExitCostUsd = "0"; }),
  mutation("YIELD_OPTIMIZATION", "yield destination asset", (request) => { request.opportunities[0]!.asset.address = "0x9999999999999999999999999999999999999999"; }),
  mutation("YIELD_OPTIMIZATION", "yield risk tier", (request) => { request.opportunities[0]!.riskTier = "LOW"; }),
  mutation("BOUNDED_GRID", "grid midpoint", (request) => { request.marketState.midPrice = "10.1"; }),
  mutation("BOUNDED_GRID", "grid liquidity", (request) => { request.marketState.liquidityUsd = "999999999"; }),
  mutation("BOUNDED_GRID", "grid venue fee", (request) => { request.marketState.venueFeeBps = 0; }),
  mutation("BOUNDED_GRID", "grid base asset", (request) => { request.baseAsset.address = "0x9999999999999999999999999999999999999999"; }),
  mutation("BOUNDED_GRID", "grid quote precision", (request) => { request.quoteAsset.decimals = 6; }),
  mutation("BOUNDED_GRID", "grid gas quote", (request) => { request.constraints.estimatedGasUsd = "0"; }),
];

describe("server observation authentication", () => {
  it.each(Object.keys(INPUTS) as Service[])("verifies a server-issued %s snapshot without exposing its key", async (service) => {
    const { request, binding, observation } = await signed(service);
    expect(await verifyServerObservationBinding(request, observation, KEY, NOW)).toEqual(binding);
    expect(binding.snapshotId).toBe(request.requestId);
    expect(binding.service).toBe(service);
    expect(binding.observation).toEqual(OBSERVATION);
    expect(binding.issuedAt).toBe(NOW.toISOString());
    expect(binding.expiresAt).toBe("2026-08-12T16:04:00.000Z");
    expect(binding.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(binding)).not.toContain(KEY);
  });

  it.each(IMMUTABLE_MUTATIONS)("rejects changed $name after issuance", async ({ service, mutate }) => {
    const { request, observation } = await signed(service);
    mutate(request);
    await expect(verifyServerObservationBinding(request, observation, KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it.each(Object.keys(INPUTS) as Service[])("allows explicitly editable buyer policy for %s", async (service) => {
    const { request, binding, observation } = await signed(service);
    request.maxActionUsd = "999";
    request.maxGasUsd = "999";
    request.maxSlippageBps = service === "LP_REBALANCE" ? 29 : 50;
    request.deadline = "2026-08-12T16:03:00.000Z";
    request.maxDataAgeSeconds = 240;
    if (request.service === "LP_REBALANCE") {
      Object.assign(request.constraints, { minimumWidthTicks: 60, maximumWidthTicks: 1200, edgeBufferBps: 200,
        highVolatilityBps: 5000, maximumToken0ShareBps: 9000, maximumToken1ShareBps: 9000,
        minimumNetBenefitUsd: "0", evaluationHorizonHours: 168 });
    } else if (request.service === "LENDING_RESCUE") {
      request.allowedActions = ["ADD_COLLATERAL"];
      request.targetHealthFactor = "1.5";
      request.stressPriceDropBps = 2000;
      request.oracleDeviationToleranceBps = 200;
    } else if (request.service === "YIELD_OPTIMIZATION") {
      request.capitalUsd = "1001";
      Object.assign(request.constraints, { protocolAllowlist: ["Venus"], maximumRiskTier: "LOW", maximumProtocolConcentrationBps: 5000,
        maximumLockupSeconds: 3600, minimumLiquidityUsd: "2000000", minimumNetBenefitUsd: "1", evaluationHorizonDays: 180 });
    } else {
      Object.assign(request.constraints, { capitalUsd: "800", lowerPrice: "8", upperPrice: "12", levelCount: 7,
        maximumInventoryUsd: "300", maximumLossUsd: "100", minimumExpectedNetProfitUsd: "0", minimumLiquidityUsd: "500000",
        maximumVolatilityBps: 2000, expectedCompletedCycles: 5, orderExpirySeconds: 60 });
    }
    // Authentication accepts these preferences; financial feasibility remains a separate evaluator concern.
    expect(await verifyServerObservationBinding(request, observation, KEY, NOW)).toEqual(binding);
  });

  it("refuses LP slippage beyond the signed quote's baseline", async () => {
    const { request, observation } = await signed("LP_REBALANCE");
    request.maxSlippageBps = 31;
    await expect(verifyServerObservationBinding(request, observation, KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it.each(["blockNumber", "observedAt", "explorerUrl"] as const)("binds outer observation metadata: %s", async (field) => {
    const { request, observation } = await signed("LP_REBALANCE");
    const changed = { ...observation, [field]: field === "blockNumber" ? "30000001"
      : field === "observedAt" ? "2026-08-12T15:59:01.000Z" : "https://bscscan.com/block/30000001" };
    await expect(verifyServerObservationBinding(request, changed, KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("rejects cross-service replay even when the outer block metadata matches", async () => {
    const { observation } = await signed("LP_REBALANCE");
    await expect(verifyServerObservationBinding(requestFor("BOUNDED_GRID"), observation, KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("rejects cross-key replay", async () => {
    const { request, observation } = await signed("LP_REBALANCE");
    await expect(verifyServerObservationBinding(request, observation, OTHER_KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it.each([undefined, "", "a".repeat(31)])("fails closed with a missing or short key %s", async (key) => {
    const { request, observation } = await signed("LP_REBALANCE");
    await expect(issueServerObservationBinding(request, OBSERVATION, key, NOW)).rejects.toBeInstanceOf(SourceObservationBindingError);
    await expect(verifyServerObservationBinding(request, observation, key, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("accepts an explicitly configured 32-byte key", async () => {
    const request = requestFor("BOUNDED_GRID");
    const key = "a".repeat(32);
    const binding = await issueServerObservationBinding(request, OBSERVATION, key, NOW);
    expect(await verifyServerObservationBinding(request, { ...OBSERVATION, binding }, key, NOW)).toEqual(binding);
  });

  it.each([undefined, null, {}, "client-says-verified"])("fails closed for missing or malformed proof %s", async (binding) => {
    await expect(verifyServerObservationBinding(requestFor("LP_REBALANCE"), { ...OBSERVATION, binding }, KEY, NOW))
      .rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("rejects an altered signature", async () => {
    const { request, binding } = await signed("LP_REBALANCE");
    binding.signature = `${binding.signature[0] === "0" ? "1" : "0"}${binding.signature.slice(1)}`;
    await expect(verifyServerObservationBinding(request, { ...OBSERVATION, binding }, KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it.each([
    { name: "request commitment", change: { immutableRequestHash: `sha256:${"1".repeat(64)}` } },
    { name: "signing epoch", change: { issuedAt: "2026-08-12T16:00:29.000Z" } },
    { name: "expiry", change: { expiresAt: "2026-08-12T16:05:00.000Z" } },
    { name: "source-age ceiling", change: { maxDataAgeSeconds: 3600 } },
    { name: "request deadline", change: { requestDeadline: "2026-08-12T17:00:00.000Z" } },
    { name: "slippage ceiling", change: { maximumSlippageBps: 2000 } },
    { name: "unknown proof field", change: { clientOverride: true } },
  ])("rejects an unsigned change to the binding's $name", async ({ change }) => {
    const { request, binding } = await signed("LP_REBALANCE");
    await expect(verifyServerObservationBinding(request, { ...OBSERVATION, binding: { ...binding, ...change } }, KEY, NOW))
      .rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("rejects an unknown request field instead of leaving it outside the commitment", async () => {
    const { request, observation } = await signed("LP_REBALANCE");
    await expect(verifyServerObservationBinding({ ...request, clientOverrides: { token0PriceUsd: "999" } }, observation, KEY, NOW))
      .rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });
});

describe("server observation expiry", () => {
  it("verifies immediately before expiry and refuses at the exact expiry boundary", async () => {
    const { request, binding, observation } = await signed("LP_REBALANCE");
    const expiresAt = Date.parse(binding.expiresAt);
    expect(await verifyServerObservationBinding(request, observation, KEY, new Date(expiresAt - 1))).toEqual(binding);
    await expect(verifyServerObservationBinding(request, observation, KEY, new Date(expiresAt))).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
    await expect(verifyServerObservationBinding(request, observation, KEY, new Date(expiresAt + 1))).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("does not accept a proof before its signing epoch", async () => {
    const { request, observation } = await signed("LP_REBALANCE");
    await expect(verifyServerObservationBinding(request, observation, KEY, new Date(NOW.getTime() - 1))).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("cannot extend freshness by increasing the caller's deadline or data-age limit", async () => {
    const { request, observation } = await signed("LP_REBALANCE");
    await expect(verifyServerObservationBinding({ ...request, deadline: "2026-08-12T17:00:00.000Z" }, observation, KEY, NOW))
      .rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
    await expect(verifyServerObservationBinding({ ...request, maxDataAgeSeconds: 301 }, observation, KEY, NOW))
      .rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("enforces a stricter buyer deadline even while the signature remains unexpired", async () => {
    const { request, observation } = await signed("LP_REBALANCE");
    request.deadline = NOW.toISOString();
    await expect(verifyServerObservationBinding(request, observation, KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("enforces a stricter buyer data-age limit at its own exact boundary", async () => {
    const { request, observation } = await signed("LP_REBALANCE");
    request.maxDataAgeSeconds = 90;
    await expect(verifyServerObservationBinding(request, observation, KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("caps a new signature at the request deadline when it precedes source expiry", async () => {
    const request = requestFor("LP_REBALANCE");
    request.deadline = "2026-08-12T16:02:00.000Z";
    const binding = await issueServerObservationBinding(request, OBSERVATION, KEY, NOW);
    expect(binding.expiresAt).toBe(request.deadline);
  });

  it("cannot issue a fresh signature for an already stale observation", async () => {
    const request = requestFor("LP_REBALANCE");
    request.maxDataAgeSeconds = 89;
    await expect(issueServerObservationBinding(request, OBSERVATION, KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("cannot issue a signature over future-dated observations", async () => {
    const request = requestFor("LP_REBALANCE");
    const future = "2026-08-12T16:01:00.000Z";
    request.sources[0]!.observedAt = future;
    request.marketState.observedAt = future;
    await expect(issueServerObservationBinding(request, { ...OBSERVATION, observedAt: future }, KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });

  it("cannot authenticate observations whose source URL disagrees with the block metadata", async () => {
    const request = requestFor("LP_REBALANCE");
    request.sources[0]!.uri = "https://bscscan.com/block/30000001";
    await expect(issueServerObservationBinding(request, OBSERVATION, KEY, NOW)).rejects.toMatchObject({ code: "REFRESH_REQUIRED" });
  });
});
