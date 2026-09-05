import archive from "../../evidence/historical-provider-receipts.2026-09-05.json" with { type: "json" };
import type { PositionCrewRequest } from "../contracts/index.js";

export const ERC8183_TESTNET_CONTRACTS = {
  commerce: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE",
  router: "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25",
  policy: "0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA",
} as const;

export const ERC8183_TESTNET_JOBS = [
  { jobId: 490, slug: "lending-rescue", service: "LENDING_RESCUE", agentId: 1810 },
  { jobId: 491, slug: "lp-rebalance", service: "LP_REBALANCE", agentId: 1811 },
  { jobId: 492, slug: "yield-optimization", service: "YIELD_OPTIMIZATION", agentId: 1812 },
  { jobId: 493, slug: "bounded-grid", service: "BOUNDED_GRID", agentId: 1813 },
  { jobId: 494, slug: "yield-optimization", service: "YIELD_OPTIMIZATION", agentId: 1812 },
  { jobId: 495, slug: "bounded-grid", service: "BOUNDED_GRID", agentId: 1813 },
] as const satisfies ReadonlyArray<{
  jobId: number;
  slug: string;
  service: PositionCrewRequest["service"];
  agentId: number;
}>;

export async function buildErc8183TestnetDeliverable(jobId: number) {
  const job = ERC8183_TESTNET_JOBS.find((candidate) => candidate.jobId === jobId);
  if (!job) return null;
  // Onchain commitments bind the original v1 bytes, not a replay using today's generator or rubric.
  const entry = archive.manifests.find((candidate) => candidate.jobId === jobId);
  if (!entry) throw new Error(`Missing immutable ERC-8183 manifest archive for job ${jobId}`);
  return structuredClone(entry.manifest);
}
