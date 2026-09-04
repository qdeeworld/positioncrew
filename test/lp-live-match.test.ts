import { describe, expect, it } from "vitest";
import {
  LpLiveMatchAuditionSchema,
  LpLiveMatchRunRequestSchema,
} from "../src/marketplace/lp-live-match-schema.js";
import {
  LpLiveMatchSelectionError,
  selectLpLiveMatchProvider,
} from "../src/marketplace/lp-live-match.js";

const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"b".repeat(64)}`;
const NOW = "2026-09-04T10:00:00.000Z";

function candidate(providerKey: "POSITIONCREW" | "HEYANON", selectable: boolean) {
  return {
    providerKey,
    providerId: providerKey === "POSITIONCREW"
      ? "positioncrew:provider:lp-rebalance:v1"
      : "erc8004:56:45650",
    name: providerKey === "POSITIONCREW" ? "LP Range Operator v1" : "V3 Pools powered by HeyAnon",
    identity: {
      protocol: "ERC-8004" as const,
      network: providerKey === "POSITIONCREW" ? "BSC_TESTNET" as const : "BSC_MAINNET" as const,
      chainId: providerKey === "POSITIONCREW" ? 97 as const : 56 as const,
      agentId: providerKey === "POSITIONCREW" ? "1811" : "45650",
      owner: "0x1111111111111111111111111111111111111111",
    },
    endpoint: providerKey === "POSITIONCREW"
      ? "https://positioncrew.dolepee.com/api/providers/lp-rebalance/jobs"
      : "https://erc8004.heyanon.ai/mcp/v3pools",
    adapterId: providerKey === "POSITIONCREW"
      ? "positioncrew:native:lp-rebalance:v1"
      : "positioncrew:mcp:heyanon-v3pools:lp-job:v1",
    status: selectable ? "COMPATIBLE" as const : "INCOMPATIBLE" as const,
    selectable,
    rawResponseHash: selectable ? HASH : null,
    normalizedResponseHash: selectable ? HASH : null,
    latencyMilliseconds: 12,
    checks: [{
      code: "EXACT_JOB",
      status: selectable ? "PASS" as const : "FAIL" as const,
      detail: "Exact job compatibility.",
    }],
  };
}

const audition = LpLiveMatchAuditionSchema.parse({
  schemaVersion: "positioncrew.lp-live-match-audition.v1",
  requestHash: HASH,
  source: {
    blockNumber: "119900001",
    observedAt: NOW,
    explorerUrl: "https://bscscan.com/block/119900001",
  },
  auditionedAt: NOW,
  candidates: [candidate("POSITIONCREW", true), candidate("HEYANON", false)],
  claimBoundary: [
    "Both providers received the same exact job.",
    "Only compatible candidates may be selected.",
    "Selection triggers a new provider invocation.",
  ],
});

describe("LP Live Match provider selection", () => {
  it("binds an explicit compatible choice to the persisted audition hash", () => {
    const request = LpLiveMatchRunRequestSchema.parse({
      schemaVersion: "positioncrew.lp-live-match-selection-request.v1",
      selectedProvider: "POSITIONCREW",
      auditionHash: HASH,
    });
    expect(selectLpLiveMatchProvider(audition, request, HASH, new Date(NOW))).toMatchObject({
      selectedProvider: "POSITIONCREW",
      providerId: "positioncrew:provider:lp-rebalance:v1",
      auditionHash: HASH,
    });
  });

  it("rejects an incompatible provider and a stale audition commitment", () => {
    expect(() => selectLpLiveMatchProvider(audition, {
      schemaVersion: "positioncrew.lp-live-match-selection-request.v1",
      selectedProvider: "HEYANON",
      auditionHash: HASH,
    }, HASH, new Date(NOW))).toThrow(LpLiveMatchSelectionError);
    expect(() => selectLpLiveMatchProvider(audition, {
      schemaVersion: "positioncrew.lp-live-match-selection-request.v1",
      selectedProvider: "POSITIONCREW",
      auditionHash: OTHER_HASH,
    }, HASH, new Date(NOW))).toThrow(LpLiveMatchSelectionError);
  });
});
