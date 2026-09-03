import { resolveNetwork, type NetworkConfig } from "@bnbagent/sdk";
import { decodeEventLog, getAddress, type Hex } from "viem";

export const JOB_FUNDED_EVENT_ABI = [{
  anonymous: false,
  type: "event",
  name: "JobFunded",
  inputs: [
    { indexed: true, name: "jobId", type: "uint256" },
    { indexed: true, name: "client", type: "address" },
    { indexed: true, name: "provider", type: "address" },
    { indexed: false, name: "amount", type: "uint256" },
  ],
}] as const;

interface ReceiptLogLike {
  address: string;
  data: Hex;
  topics: readonly Hex[];
  transactionHash?: Hex | null;
  blockNumber?: bigint | null;
}

interface FundingReceiptLike {
  transactionHash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  from: string;
  to: string | null;
  logs: readonly ReceiptLogLike[];
}

export interface RecordedFundingTransaction {
  hash: Hex;
  blockNumber: string;
}

export interface ExpectedFundingEvent {
  commerce: string;
  client: string;
  provider: string;
  jobId: bigint;
  amount: bigint;
}

export interface FundingEvidence {
  source: "RECORDED_TRANSACTION_RECEIPT" | "SIGNED_WINDOW_LOG_FALLBACK";
  blockNumber: bigint;
  transactionHash: Hex | null;
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function bscMainnetNetworkAtRpc(rpcUrl: string): NetworkConfig {
  const parsed = new URL(rpcUrl);
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new Error("BSC RPC URL must be an HTTP(S) URL without embedded credentials");
  }
  return { ...resolveNetwork("bsc-mainnet"), rpcUrl: parsed.toString() };
}

export function providerSubmissionStillOpen(deadline: string, nowMs = Date.now()): boolean {
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) throw new Error("Provider submission deadline is invalid");
  return nowMs < deadlineMs;
}

export function verifyRecordedFundingReceipt(
  receipt: FundingReceiptLike,
  recorded: RecordedFundingTransaction,
  expected: ExpectedFundingEvent,
): FundingEvidence {
  if (!sameHex(receipt.transactionHash, recorded.hash)) throw new Error("Funding receipt hash differs from the checkpoint transaction");
  if (receipt.status !== "success") throw new Error("Recorded fund transaction did not succeed");
  if (receipt.blockNumber.toString() !== recorded.blockNumber) throw new Error("Funding receipt block differs from the checkpoint transaction");
  if (!receipt.to || !sameHex(getAddress(receipt.to), getAddress(expected.commerce))) throw new Error("Recorded fund transaction did not call the approved commerce contract");
  if (!sameHex(getAddress(receipt.from), getAddress(expected.client))) throw new Error("Recorded fund transaction was not sent by the approved client");

  const fundedEvents = receipt.logs.flatMap((log) => {
    if (!sameHex(getAddress(log.address), getAddress(expected.commerce)) || log.topics.length === 0) return [];
    try {
      const decoded = decodeEventLog({
        abi: JOB_FUNDED_EVENT_ABI,
        eventName: "JobFunded",
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      return [{ log, args: decoded.args }];
    } catch {
      return [];
    }
  });
  if (fundedEvents.length !== 1) throw new Error("Recorded fund transaction must contain exactly one commerce JobFunded event");
  const event = fundedEvents[0]!;
  if (event.log.transactionHash && !sameHex(event.log.transactionHash, recorded.hash)) throw new Error("JobFunded log transaction hash differs from the checkpoint transaction");
  if (event.log.blockNumber !== null && event.log.blockNumber !== undefined && event.log.blockNumber !== receipt.blockNumber) throw new Error("JobFunded log block differs from its receipt");
  if (event.args.jobId !== expected.jobId) throw new Error("JobFunded event names a different job");
  if (!sameHex(getAddress(event.args.client), getAddress(expected.client))) throw new Error("JobFunded event names a different client");
  if (!sameHex(getAddress(event.args.provider), getAddress(expected.provider))) throw new Error("JobFunded event names a different provider");
  if (event.args.amount !== expected.amount) throw new Error("JobFunded event amount differs from the exact approved price");
  return { source: "RECORDED_TRANSACTION_RECEIPT", blockNumber: receipt.blockNumber, transactionHash: recorded.hash };
}

export async function recoverFundingEvidence(input: {
  recorded: RecordedFundingTransaction | null;
  expected: ExpectedFundingEvent;
  readTransactionReceipt: (hash: Hex) => Promise<FundingReceiptLike>;
  fallbackFundedBlock: () => Promise<bigint | null>;
}): Promise<FundingEvidence> {
  if (input.recorded) {
    try {
      const receipt = await input.readTransactionReceipt(input.recorded.hash);
      return verifyRecordedFundingReceipt(receipt, input.recorded, input.expected);
    } catch (error) {
      throw new Error(`Recorded fund transaction could not be verified: ${errorMessage(error)}`, { cause: error });
    }
  }
  const fallbackBlock = await input.fallbackFundedBlock();
  if (fallbackBlock === null) throw new Error("Job funding could not be proven inside the provider-signed quote window");
  return { source: "SIGNED_WINDOW_LOG_FALLBACK", blockNumber: fallbackBlock, transactionHash: null };
}
