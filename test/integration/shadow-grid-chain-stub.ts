// Synthetic chain seam for D1 scheduler integration, not production evidence.
// Only the temporary integration bundle imports this module.
import fixture from "../../fixtures/provider-conformance/grid-valid.v2.json" with { type: "json" };
import { BoundedGridRequestSchema } from "../../src/contracts/bounded-grid.js";
import type { PancakeGridProbe, PancakeGridPriceSample } from "../../src/telemetry/bsc.js";

const blockNumber = "71008888";
const blockHash = `0x${"a".repeat(64)}` as const;
const poolAddress = "0x6666666666666666666666666666666666666666" as const;

export async function inspectPancakeGridMarket(): Promise<PancakeGridProbe> {
  const observedAt = new Date().toISOString();
  const sourceId = `synthetic-shadow-grid-block-${blockNumber}`;
  const explorerUrl = `https://bscscan.com/block/${blockNumber}`;
  const gridRequest = BoundedGridRequestSchema.parse({
    ...structuredClone(fixture),
    requestId: `pancake-grid-${blockNumber}-${Date.now()}`,
    protocol: "PancakeSwap V3 bounded grid policy",
    requestedAt: observedAt,
    deadline: new Date(Date.parse(observedAt) + 300_000).toISOString(),
    sources: [{ sourceId, label: "Synthetic D1 lifecycle input, not a chain observation", uri: explorerUrl, observedAt }],
    marketState: { ...fixture.marketState, observedAt, sourceId },
  });
  return {
    schemaVersion: "positioncrew.pancake-grid-probe.v1", generatedAt: observedAt,
    chainId: 56, state: "READY", gridRequest,
    market: { pair: "WBNB/USDT", poolAddress, feeTier: 100,
      spotPriceUsd: gridRequest.marketState.midPrice,
      activeLiquidityUsd: gridRequest.marketState.liquidityUsd,
      reserveValueUsd: gridRequest.marketState.liquidityUsd,
      realizedVolatilityBps: gridRequest.marketState.realizedVolatilityBps,
      volatilityWindowSeconds: 300, volatilitySampleCount: 2 },
    source: { blockNumber, blockTimestamp: observedAt, explorerUrl, poolExplorerUrl: `https://bscscan.com/address/${poolAddress}` },
    boundary: "Synthetic deterministic chain seam; only D1 and scheduler behavior are under test.",
  };
}

export async function inspectPancakeGridPriceSample(): Promise<PancakeGridPriceSample> {
  const observedAt = new Date().toISOString();
  return {
    sampledAt: observedAt, spotPriceUsd: fixture.marketState.midPrice,
    source: { chainId: 56, market: "WBNB/USDT", protocol: "PancakeSwap V3",
      poolAddress, blockNumber, blockHash, blockTimestamp: observedAt,
      explorerUrl: `https://bscscan.com/block/${blockNumber}`, confirmationDepth: 32,
      finality: "FINALIZED_OR_32_CONFIRMATIONS" },
  };
}

export async function verifyPancakeGridPriceSample(sample: PancakeGridPriceSample): Promise<void> {
  if (sample.source.blockNumber !== blockNumber || sample.source.blockHash !== blockHash ||
      sample.source.poolAddress !== poolAddress || sample.spotPriceUsd !== fixture.marketState.midPrice) {
    throw new Error("Unexpected input outside the synthetic D1 chain seam");
  }
}
