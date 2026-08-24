import { describe, expect, it } from "vitest";
import {
  annualizedRatePct,
  annualizedYieldBps,
  isRetryableRpcFailure,
  pancakeActiveLiquidityUsd,
  poolPriceFromSqrtPriceX96,
  realizedVolatilityBpsFromTickCumulatives,
  rpcFallbacks,
  v3PositionTokenAmounts,
  venusLiquidityTotalsFixed,
  venusUsdValueFixed,
} from "../src/telemetry/bsc.js";

describe("BSC telemetry math", () => {
  it("converts a Q96 pool price into token0 per token1", () => {
    const sqrtPriceX96 = 3_206_041_112_872_199_382_275_767_303n;
    expect(poolPriceFromSqrtPriceX96(sqrtPriceX96)).toBeGreaterThan(590);
    expect(poolPriceFromSqrtPriceX96(sqrtPriceX96)).toBeLessThan(630);
  });

  it("values the current V3 active-liquidity virtual reserves", () => {
    const q96 = 2n ** 96n;
    expect(pancakeActiveLiquidityUsd(q96, 1_000n * 10n ** 18n, 1)).toBe(2_000);
    expect(() => pancakeActiveLiquidityUsd(0n, 1n, 1)).toThrow(
      "Positive pool price, liquidity, and token USD prices are required",
    );
  });

  it("reconstructs V3 position inventory below, inside, and above its range", () => {
    const q96 = 2n ** 96n;
    const inRange = v3PositionTokenAmounts(1_000n * 10n ** 18n, q96, -120, 120);
    expect(inRange.token0Amount).toBeGreaterThan(0);
    expect(inRange.token1Amount).toBeGreaterThan(0);

    const below = v3PositionTokenAmounts(1_000n * 10n ** 18n, q96, 120, 240);
    expect(below.token0Amount).toBeGreaterThan(0);
    expect(below.token1Amount).toBe(0);

    const above = v3PositionTokenAmounts(1_000n * 10n ** 18n, q96, -240, -120);
    expect(above.token0Amount).toBe(0);
    expect(above.token1Amount).toBeGreaterThan(0);
    expect(() => v3PositionTokenAmounts(1n, q96, 120, 120)).toThrow(
      "ordered ticks",
    );
  });

  it("annualizes a per-block rate using the measured block interval", () => {
    const annualized = annualizedRatePct(267_884_853n, 0.75);
    expect(annualized).toBeGreaterThan(1);
    expect(annualized).toBeLessThan(1.2);
  });

  it("compounds a Venus base supply rate into bounded APY basis points", () => {
    expect(annualizedYieldBps(267_884_853n, 0.75)).toBe(113);
    expect(annualizedYieldBps(0n, 0.75)).toBe(0);
    expect(annualizedYieldBps(267_884_853n, 0)).toBe(0);
  });

  it("derives realized volatility from ordered onchain tick cumulatives", () => {
    const cumulatives = [0n, -600_000n, -1_206_000n, -1_818_000n];
    const volatility = realizedVolatilityBpsFromTickCumulatives(cumulatives, 60);
    expect(volatility).toBeGreaterThanOrEqual(140);
    expect(volatility).toBeLessThanOrEqual(142);
    expect(() => realizedVolatilityBpsFromTickCumulatives([0n, 1n], 60)).toThrow(
      "At least three ordered tick cumulatives",
    );
  });

  it("retries provider faults but never retries EVM execution failures", () => {
    expect(isRetryableRpcFailure({ code: -32_002, message: "the resource eth_call is not available" })).toBe(true);
    expect(isRetryableRpcFailure({ code: -32_005, message: "rate limit exceeded" })).toBe(true);
    expect(isRetryableRpcFailure({ code: -32_603, message: "temporary internal error" })).toBe(true);
    expect(isRetryableRpcFailure({
      code: -32_603,
      message: "internal error: execution reverted",
      data: "0x08c379a0",
    })).toBe(false);
    expect(isRetryableRpcFailure({ code: 3, message: "execution reverted: policy failed" })).toBe(false);
  });

  it("uses three distinct mainnet transports in a deterministic failover order", () => {
    const publicBnbRpc = "https://bsc-dataseed-public.bnbchain.org";
    const publicNodeRpc = "https://bsc-rpc.publicnode.com";
    const legacyBnbRpc = "https://bsc-dataseed.bnbchain.org";

    expect(rpcFallbacks(publicBnbRpc)).toEqual([
      publicBnbRpc,
      publicNodeRpc,
      legacyBnbRpc,
    ]);
    expect(rpcFallbacks(publicNodeRpc)).toEqual([
      publicNodeRpc,
      publicBnbRpc,
      legacyBnbRpc,
    ]);
    expect(new Set(rpcFallbacks(publicBnbRpc)).size).toBe(3);
    expect(rpcFallbacks("https://example.invalid")).toEqual(["https://example.invalid"]);
  });

  it("normalizes Venus oracle values into 18-decimal USD across token decimals", () => {
    expect(venusUsdValueFixed(650n * 10n ** 18n, 999_000_000_000_000_000n)).toBe(
      649_350_000_000_000_000_000n,
    );
    expect(venusUsdValueFixed(2n * 10n ** 8n, 60_000n * 10n ** 28n)).toBe(
      120_000n * 10n ** 18n,
    );
  });

  it("reconstructs liquidity and shortfall with liquidation thresholds and VAI debt", () => {
    const liquid = venusLiquidityTotalsFixed([
      {
        suppliedUsd: 1_000n * 10n ** 18n,
        borrowedUsd: 100n * 10n ** 18n,
        liquidationThreshold: 8_000n * 10n ** 14n,
        collateralEnabled: true,
      },
      {
        suppliedUsd: 500n * 10n ** 18n,
        borrowedUsd: 0n,
        liquidationThreshold: 6_500n * 10n ** 14n,
        collateralEnabled: true,
      },
    ], 25n * 10n ** 18n);
    expect(liquid.collateralValueUsd).toBe(1_500n * 10n ** 18n);
    expect(liquid.liquidationWeightedCollateralUsd).toBe(1_125n * 10n ** 18n);
    expect(liquid.debtValueUsd).toBe(125n * 10n ** 18n);
    expect(liquid.liquidityUsd).toBe(1_000n * 10n ** 18n);
    expect(liquid.shortfallUsd).toBe(0n);

    const short = venusLiquidityTotalsFixed([
      {
        suppliedUsd: 100n * 10n ** 18n,
        borrowedUsd: 90n * 10n ** 18n,
        liquidationThreshold: 8_000n * 10n ** 14n,
        collateralEnabled: true,
      },
    ]);
    expect(short.liquidityUsd).toBe(0n);
    expect(short.shortfallUsd).toBe(10n * 10n ** 18n);
  });
});
