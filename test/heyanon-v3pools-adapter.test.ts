import { describe, expect, it } from "vitest";
import {
  auditionHeyAnonV3Position,
  fetchHeyAnonV3Position,
} from "../src/marketplace/heyanon-v3pools-adapter.js";

const positionId = "7284482";
const token0 = "0x55d398326f99059fF775485246999027B3197955";
const token1 = "0xBEEA1D618e533a387D941F58a7d4c9b7bD377777";
const owner = "0x318cf4df2d07babe7ee204022455bdcb8860bb07";
const liquidity = "66847121046507566902115";

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string): string {
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function positionResponse(): string {
  return `0x${[
    word(0n),
    word(0n),
    addressWord(token0),
    addressWord(token1),
    word(2500n),
    word(22950n),
    word(24950n),
    word(BigInt(liquidity)),
    word(0n),
    word(0n),
    word(0n),
    word(0n),
  ].join("")}`;
}

const external = {
  chainName: "bsc",
  protocol: "Pancake",
  positionId,
  token0: { symbol: "usdt", address: token0 },
  token1: { symbol: "TOKEN", address: token1 },
  fee: "0.25%",
  liquidity,
  amount0: "1068.56",
  amount0Pct: 54.2,
  amount1: "9876.96",
  amount1Pct: 45.8,
  pendingFee0: "0.07",
  pendingFee1: "0.31",
  currentPrice: "10.87",
  lowerPrice: "9.92",
  upperPrice: "12.12",
};

function mockFetch(extraExternal: Record<string, unknown> = {}): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
    if (url.includes("heyanon.ai")) {
      const payload = {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              project: "v3pools",
              operation: "getLpPosition",
              data: { positions: [{ ...external, ...extraExternal }] },
            }),
          }],
        },
      };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    const callData = (body.params?.[0] as { data?: string } | undefined)?.data ?? "";
    const result = body.method === "eth_blockNumber"
      ? "0x7170000"
      : callData.includes("6352211e")
        ? `0x${addressWord(owner)}`
        : positionResponse();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
}

describe("HeyAnon V3 Pools adapter", () => {
  it("cross-checks external position identity against a pinned BSC response", async () => {
    const assessment = await auditionHeyAnonV3Position(positionId, { fetchImpl: mockFetch() });
    expect(assessment.checks.filter((check) => check.status === "PASS")).toHaveLength(5);
    expect(assessment.onchain.owner).toBe(owner);
    expect(assessment.eligibleForLpRebalance).toBe(false);
  });

  it("rejects undeclared external response fields", async () => {
    await expect(fetchHeyAnonV3Position(positionId, mockFetch({ inventedRisk: "LOW" }))).rejects.toThrow();
  });
});
