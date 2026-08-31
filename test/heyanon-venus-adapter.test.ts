import { describe, expect, it } from "vitest";
import {
  evaluateHeyAnonCompatibility,
  HeyAnonVenusSnapshotSchema,
} from "../src/marketplace/heyanon-venus-adapter.js";
import { lendingFixture } from "./helpers.js";

describe("HeyAnon Venus compatibility adapter", () => {
  it("preserves partial agreement without promoting a complete Lending provider", () => {
    const request = lendingFixture();
    request.chainId = 56;
    request.protocol = "Venus Classic";
    const collateral = request.position.collateral.map((entry) => ({
      tokenSymbol: entry.symbol,
      balance: entry.amount,
    }));
    const debt = request.position.debt.map((entry) => ({
      tokenSymbol: entry.symbol,
      balance: entry.amount,
    }));
    const snapshot = HeyAnonVenusSnapshotSchema.parse({
      schemaVersion: "positioncrew.heyanon-venus-snapshot.v1",
      observedAt: "2026-08-30T09:46:03.000Z",
      requestedAccount: request.account,
      chainId: 56,
      pool: "CORE",
      identity: {
        chainId: 56,
        tokenId: "43129",
        registry: "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
        owner: "0xda977767452c5dd021624511f14df67b6c9c2c1b",
      },
      endpoint: "https://erc8004.heyanon.ai/mcp/venus",
      endpointDomainVerified: false,
      supportedTokens: {
        project: "venus",
        operation: "getSupportedTokens",
        data: [{ chain: "bsc", tokens: ["BNB", "CAKE", "USDT"] }],
      },
      omittedRequestSymbols: [],
      liquidity: {
        project: "venus",
        operation: "getAccountLiquidity",
        data: [{ chain: "bsc", pool: "CORE", borrowLimit: "508.53", shortfall: "0.00" }],
      },
      enabledCollateral: {
        project: "venus",
        operation: "getEnabledCollateral",
        data: { enabledAssets: [] },
      },
      supplied: {
        project: "venus",
        operation: "getVenusBalance",
        data: { chainName: "bsc", pool: "CORE", balances: collateral },
      },
      borrowed: {
        project: "venus",
        operation: "getBorrowBalance",
        data: { chainName: "bsc", pool: "CORE", balances: debt },
      },
    });

    const result = evaluateHeyAnonCompatibility(request, snapshot, "508.530872");

    expect(result.status).toBe("PARTIAL_COMPATIBILITY");
    expect(result.eligibleForLendingRescue).toBe(false);
    expect(result.checks.filter((check) => check.status === "PASS").map(
      (check) => check.code,
    )).toEqual([
      "PUBLIC_REMOTE_ENDPOINT",
      "BSC_CORE_POOL_BINDING",
      "POSITION_BALANCE_COVERAGE",
      "PROTOCOL_LIQUIDITY",
    ]);
    expect(result.checks.filter((check) => check.status === "FAIL").map(
      (check) => check.code,
    )).toEqual([
      "OUTPUT_ACCOUNT_ATTRIBUTION",
      "BLOCK_ATTRIBUTION",
      "PRICE_AND_THRESHOLD_EVIDENCE",
      "HEALTH_FACTOR",
      "STRESS_TABLE",
      "BOUNDED_RESCUE_DECISION",
      "ENDPOINT_DOMAIN_CONTROL",
    ]);
  });

  it("does not coerce a missing requested balance into an explicit zero", () => {
    const request = lendingFixture();
    request.chainId = 56;
    request.protocol = "Venus Classic";
    request.position.collateral.push({
      ...request.position.collateral[0]!,
      symbol: "DOGE",
      address: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43",
      decimals: 8,
      amount: "0.00000045",
    });
    const snapshot = HeyAnonVenusSnapshotSchema.parse({
      schemaVersion: "positioncrew.heyanon-venus-snapshot.v1",
      observedAt: "2026-08-30T09:46:03.000Z",
      requestedAccount: request.account,
      chainId: 56,
      pool: "CORE",
      identity: {
        chainId: 56,
        tokenId: "43129",
        registry: "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432",
        owner: "0xda977767452c5dd021624511f14df67b6c9c2c1b",
      },
      endpoint: "https://erc8004.heyanon.ai/mcp/venus",
      endpointDomainVerified: false,
      supportedTokens: {
        project: "venus",
        operation: "getSupportedTokens",
        data: [{ chain: "bsc", tokens: ["BNB", "USDT"] }],
      },
      omittedRequestSymbols: ["DOGE"],
      liquidity: {
        project: "venus",
        operation: "getAccountLiquidity",
        data: [{ chain: "bsc", pool: "CORE", borrowLimit: "508.53", shortfall: "0.00" }],
      },
      enabledCollateral: {
        project: "venus",
        operation: "getEnabledCollateral",
        data: { enabledAssets: [] },
      },
      supplied: {
        project: "venus",
        operation: "getVenusBalance",
        data: {
          chainName: "bsc",
          pool: "CORE",
          balances: request.position.collateral
            .filter((entry) => entry.symbol !== "DOGE")
            .map((entry) => ({ tokenSymbol: entry.symbol, balance: entry.amount })),
        },
      },
      borrowed: {
        project: "venus",
        operation: "getBorrowBalance",
        data: {
          chainName: "bsc",
          pool: "CORE",
          balances: request.position.debt.map((entry) => ({
            tokenSymbol: entry.symbol,
            balance: entry.amount,
          })),
        },
      },
    });

    const result = evaluateHeyAnonCompatibility(request, snapshot, "508.530872");
    expect(result.checks.find((check) => check.code === "POSITION_BALANCE_COVERAGE")).toMatchObject({
      status: "FAIL",
      detail: expect.stringContaining("supplied DOGE"),
    });
  });
});
