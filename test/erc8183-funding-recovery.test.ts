import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  JOB_FUNDED_EVENT_ABI,
  bscMainnetNetworkAtRpc,
  providerSubmissionStillOpen,
  recoverFundingEvidence,
} from "../src/commerce/erc8183-funding-recovery.js";

const commerce = "0xEa4DAa3100A767e86FDed867729ae7446476EBA6";
const client = "0xADd748C416E8A7efd7d65D18Abb121dea268ddF9";
const provider = "0x20f1cA5d1e5A3Ee94C29DbF95e6BF6ceA6a8d64b";
const hash = `0x${"1".repeat(64)}` as Hex;

function receipt(overrides: Record<string, unknown> = {}) {
  const topics = encodeEventTopics({
    abi: JOB_FUNDED_EVENT_ABI,
    eventName: "JobFunded",
    args: { jobId: 56_700n, client, provider },
  }) as [Hex, ...Hex[]];
  return {
    transactionHash: hash,
    status: "success" as const,
    blockNumber: 119_800_000n,
    from: client,
    to: commerce,
    logs: [{
      address: commerce,
      data: encodeAbiParameters([{ type: "uint256" }], [100_000_000_000_000_000n]),
      topics,
      transactionHash: hash,
      blockNumber: 119_800_000n,
    }],
    ...overrides,
  };
}

const expected = {
  commerce,
  client,
  provider,
  jobId: 56_700n,
  amount: 100_000_000_000_000_000n,
};

describe("ERC-8183 funding recovery", () => {
  it("uses the confirmed fund receipt and never invokes the wide-log fallback", async () => {
    const fallbackFundedBlock = vi.fn(async () => 1n);
    const evidence = await recoverFundingEvidence({
      recorded: { hash, blockNumber: "119800000" },
      expected,
      readTransactionReceipt: vi.fn(async () => receipt()),
      fallbackFundedBlock,
    });
    expect(evidence).toEqual({
      source: "RECORDED_TRANSACTION_RECEIPT",
      blockNumber: 119_800_000n,
      transactionHash: hash,
    });
    expect(fallbackFundedBlock).not.toHaveBeenCalled();
  });

  it("fails closed instead of scanning when the recorded receipt event is incompatible", async () => {
    const fallbackFundedBlock = vi.fn(async () => 119_800_000n);
    const incompatible = receipt({
      logs: [{
        ...receipt().logs[0],
        data: encodeAbiParameters([{ type: "uint256" }], [1n]),
      }],
    });
    await expect(recoverFundingEvidence({
      recorded: { hash, blockNumber: "119800000" },
      expected,
      readTransactionReceipt: vi.fn(async () => incompatible),
      fallbackFundedBlock,
    })).rejects.toThrow("amount differs from the exact approved price");
    expect(fallbackFundedBlock).not.toHaveBeenCalled();
  });

  it("uses the signed-window SDK scan only when no confirmed fund transaction is recorded", async () => {
    const readTransactionReceipt = vi.fn(async () => receipt());
    const evidence = await recoverFundingEvidence({
      recorded: null,
      expected,
      readTransactionReceipt,
      fallbackFundedBlock: vi.fn(async () => 119_799_999n),
    });
    expect(evidence.source).toBe("SIGNED_WINDOW_LOG_FALLBACK");
    expect(evidence.blockNumber).toBe(119_799_999n);
    expect(readTransactionReceipt).not.toHaveBeenCalled();
  });

  it("fails closed when neither a receipt nor signed-window event proves funding", async () => {
    await expect(recoverFundingEvidence({
      recorded: null,
      expected,
      readTransactionReceipt: vi.fn(async () => receipt()),
      fallbackFundedBlock: vi.fn(async () => null),
    })).rejects.toThrow("could not be proven inside the provider-signed quote window");
  });

  it("pins the SDK preset to the exact direct-client RPC", () => {
    const rpcUrl = "https://example-rpc.invalid/bsc";
    const network = bscMainnetNetworkAtRpc(rpcUrl);
    expect(network.chainId).toBe(56);
    expect(network.rpcUrl).toBe(rpcUrl);
  });

  it("allows funded notification only before the immutable submission deadline", () => {
    const deadline = "2026-09-03T19:30:00.000Z";
    expect(providerSubmissionStillOpen(deadline, Date.parse(deadline) - 1)).toBe(true);
    expect(providerSubmissionStillOpen(deadline, Date.parse(deadline))).toBe(false);
    expect(providerSubmissionStillOpen(deadline, Date.parse(deadline) + 1)).toBe(false);
  });
});
